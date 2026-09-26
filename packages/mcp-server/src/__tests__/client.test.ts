import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { TapflowClient, REASON_ADVICE, SessionEndedError, SessionLeftError, reasonAdvice } from '../client.js'
import { makeFlowDriver } from '../tools.js'
import { EnvironmentStepError, TransientQueryError } from '@tapflowio/flow-runner'

// inputAck models the agent's terminal-input ack: 'done' = new agent (booted), 'error' = rejects with prose only, 'error-with-reason' = rejects with the machine-readable reason too, 'none' = older agent that never acks (degradation).
function createMockRelay(): {
  wss: WebSocketServer
  port: number
  lastClient: () => WebSocket
  send: (msg: Record<string, unknown>) => void
  setInputAck: (mode: 'done' | 'error' | 'error-with-reason' | 'none') => void
  sentMessages: () => Record<string, unknown>[]
  close: () => Promise<void>
} {
  const wss = new WebSocketServer({ port: 0 })
  const received: Record<string, unknown>[] = []
  let conn: WebSocket | null = null
  let inputAck: 'done' | 'error' | 'error-with-reason' | 'none' = 'done'
  const TERMINAL = new Set(['input:touch:end', 'input:key', 'input:button'])

  wss.on('connection', (ws) => {
    conn = ws
    ws.on('message', (data) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) as Record<string, unknown> } catch { return }
      received.push(msg)
      if (inputAck !== 'none' && TERMINAL.has(msg['type'] as string)) {
        // Echoes `requestId`, because an agent must (L5c). Read back off the request rather than invented:
        // a made-up id would only prove the waiter rejects made-up ids, which is a different claim.
        const requestId = msg['requestId']
        ws.send(JSON.stringify(inputAck === 'error'
          ? { type: 'input:error', sessionId: msg['sessionId'], requestId, message: 'device not booted' }
          : inputAck === 'error-with-reason'
          ? { type: 'input:error', sessionId: msg['sessionId'], requestId, message: 'the input channel is still starting — retry in a moment', reason: 'channel-starting' }
          : { type: 'input:done', sessionId: msg['sessionId'], requestId }))
      }
    })
  })

  const port = (wss.address() as { port: number }).port

  return {
    wss,
    port,
    lastClient: () => conn!,
    send: (msg) => conn?.send(JSON.stringify(msg)),
    setInputAck: (mode) => { inputAck = mode },
    sentMessages: () => received,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  }
}

function waitForMessage(relay: ReturnType<typeof createMockRelay>, type: string, timeoutMs = 2000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const check = setInterval(() => {
      const found = relay.sentMessages().find((m) => m['type'] === type)
      if (found) { clearInterval(check); clearTimeout(timer); resolve(found) }
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error(`waitForMessage: timed out waiting for type "${type}"`))
    }, timeoutMs)
  })
}

/** Answers the next request of `type` with `reply`, carrying back the correlator the client minted.
 *
 *  A timer that fires before the request arrives cannot do this: the id is chosen by the client, so the
 *  fake has to observe the request and echo. That is the point of the correlator, and a fixture that made
 *  one up would be testing that the client rejects it. */
function echoReply(relay: { lastClient: () => WebSocket }, type: string, reply: Record<string, unknown>): void {
  const ws = relay.lastClient()
  const onMessage = (data: unknown) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(String(data)) as Record<string, unknown> } catch { return }
    if (msg['type'] !== type) return
    ws.off('message', onMessage)
    ws.send(JSON.stringify({ ...reply, requestId: msg['requestId'] }))
  }
  ws.on('message', onMessage)
}

/** Waits until everything sent so far has been **dispatched by the client**.
 *
 *  A round trip the client completes itself, not a sleep: `agents:list` carries no session, so no lifecycle
 *  frame can settle its waiter, and frames on one socket stay ordered — so once this resolves, everything
 *  sent ahead of it has been through `dispatch`. A 20ms sleep in this position is a guess about scheduling,
 *  and the sibling suite rejected it for the same job.
 */
async function settle(relay: ReturnType<typeof createMockRelay>, client: TapflowClient): Promise<void> {
  const listing = client.listDevices()
  relay.send({ type: 'agents:listed', sessions: [] })
  await listing
}

describe('TapflowClient', () => {
  let relay: ReturnType<typeof createMockRelay>
  let client: TapflowClient

  beforeEach(async () => {
    relay = createMockRelay()
    client = new TapflowClient(`ws://localhost:${relay.port}`, 'tflw_pat_test')
    await client.connect()
  })

  afterEach(async () => {
    client.disconnect()
    await relay.close()
  })

  describe('listDevices', () => {
    it('sends agents:list and returns sessions from agents:listed', async () => {
      const sessions = [{ agentName: 'MyMac', devices: [{ id: 'dev-1', name: 'iPhone', sessionId: 'sess-1', platform: 'ios', status: 'shutdown', busy: false }] }]
      setTimeout(() => relay.send({ type: 'agents:listed', sessions }), 10)

      const [result, msg] = await Promise.all([
        client.listDevices(),
        waitForMessage(relay, 'agents:list'),
      ])

      expect(result).toEqual(sessions)
      expect(msg).toMatchObject({ type: 'agents:list' })
    })

    it('returns empty array when sessions is missing', async () => {
      setTimeout(() => relay.send({ type: 'agents:listed' }), 10)
      const result = await client.listDevices()
      expect(result).toEqual([])
    })
  })

  describe('connectDevice', () => {
    it('sends session:start and resolves on session:joined', async () => {
      setTimeout(() => relay.send({ type: 'session:joined', sessionId: 'sess-1' }), 10)
      const [, msg] = await Promise.all([
        client.connectDevice('sess-1'),
        waitForMessage(relay, 'session:start'),
      ])
      expect(msg).toMatchObject({ type: 'session:start', sessionId: 'sess-1' })
    })

    // These two send an **addressed** refusal, as the relay does since L5d. The fake relay's `send` takes
    // `Record<string, unknown>`, so nothing typed them and they carried neither `sessionId` nor the required
    // `reason` — they passed only because the waiter had a `sessionId === undefined` escape. Removing that
    // escape is what closes #512's first finding, and it is what would have turned these two red with no
    // compile error to point at them.
    it('throws on session busy error', async () => {
      setTimeout(() => relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session busy', reason: 'session-busy' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session busy')
    })

    it('does not resolve one join with another session\'s refusal', async () => {
      // **#512 finding 1.** Before L5d `error` carried no address, so the waiter's `sessionId === undefined`
      // half was always true and any refusal resolved any pending join. Two joins in flight and the first
      // refusal woke the wrong one — reported as a failure that session never had — while the one that was
      // actually refused waited out its deadline, because `dispatch` resolves only the first match.
      const other = client.connectDevice('sess-OTHER')
      relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session busy', reason: 'session-busy' })

      expect(await Promise.race([
        other.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])).toBe('still-waiting')
      other.catch(() => { /* times out on its own deadline */ })
    }, 15_000)

    it('is not resolved by an unaddressed refusal, and logs the skew once', async () => {
      // The `sessionId === undefined` escape only fires for a refusal carrying **no** address, so the
      // foreign-address test above does not exercise it — a mutation putting the escape back left all 80
      // tests passing. This is the case that holds it, and the same one that holds the skew log.
      //
      // A relay older than L5d sends unaddressed refusals. They match nothing now, so the join runs to its
      // deadline instead of throwing `'Session busy'` — advice the caller could have acted on. Taken
      // deliberately over a fallback, and logged once per socket because nothing else announces a relay's
      // version and the join's own timeout says nothing about why.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        const pending = client.connectDevice('sess-1')
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })   // no sessionId
        await new Promise((r) => setTimeout(r, 20))
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })   // and again
        await new Promise((r) => setTimeout(r, 20))

        expect(await Promise.race([
          pending.then(() => 'resolved').catch(() => 'rejected'),
          new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
        ])).toBe('still-waiting')
        pending.catch(() => { /* times out on its own deadline */ })
      } finally { spy.mockRestore() }
      // Once, not twice: an old relay refuses every join this way, and a line per refusal would bury it.
      expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
    }, 15_000)

    it('logs the skew for a refusal that arrives with nothing waiting for it', async () => {
      // **The stated reason for recording this in `dispatch`**, and nothing held it: adding
      // `&& this.waiters.length > 0` to the guard passed all 81 tests, because every other fixture has a join
      // still pending when the refusal lands. The case that reason exists for is the opposite one — a refusal
      // arriving *after* its join gave up, from a relay slow enough that the deadline won the race. That
      // caller has already been told "timed out" with no cause, so this line is the only thing that can
      // explain it, and a waiters-guard would drop precisely it.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })   // no join in flight
        await new Promise((r) => setTimeout(r, 20))
      } finally { spy.mockRestore() }
      expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
    })

    it('names the relay and not a session it cannot know', async () => {
      // The first draft keyed the record on the literal `'a pending join'` and rendered it into the line, so
      // the set could only ever hold that sentinel — "once per session" in the docstring, once per *process*
      // in fact, and against an old relay the second refused session logged nothing at all. Keying per
      // session is not available: the frame carries no address, and `Waiter` keeps its predicate as a closure
      // so no session id survives on the record. Naming one anyway would be a guess between the pending
      // joins, which is the false attribution this slice exists to remove. The relay is what the operator
      // acts on, and it is per client, so once per client is the honest cardinality.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })
        await new Promise((r) => setTimeout(r, 20))
      } finally { spy.mockRestore() }
      const line = logged.find((l) => l.includes('predates addressed errors'))
      expect(line).toBeDefined()
      expect(line).toContain('Upgrade the relay')
      expect(line).not.toContain('pending join')
    })

    it('throws on session not found error', async () => {
      setTimeout(() => relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session not found', reason: 'session-not-found' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session not found')
    })
  })

  describe('disconnectDevice', () => {
    it('sends session:leave', async () => {
      client.disconnectDevice('sess-1')
      const msg = await waitForMessage(relay, 'session:leave')
      expect(msg).toMatchObject({ type: 'session:leave', sessionId: 'sess-1' })
    })
  })

  describe('bootDevice', () => {
    it('sends device:boot and resolves on device:ready', async () => {
      setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      // Await outbound device:boot arrival; device:ready resolving doesn't guarantee it was recorded (CI race).
      const bootMsg = await waitForMessage(relay, 'device:boot')
      expect(bootMsg).toMatchObject({
        type: 'device:boot',
        sessionId: 'sess-1',
        payload: { deviceId: 'dev-1' },
      })
    })

    it('throws on device:boot-error', async () => {
      setTimeout(() => relay.send({ type: 'device:boot-error', sessionId: 'sess-1', message: 'Boot failed' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).rejects.toThrow('Boot failed')
    })

    it('ignores device:ready for a different sessionId and resolves on the correct one', async () => {
      setTimeout(() => {
        relay.send({ type: 'device:ready', sessionId: 'OTHER' })
        relay.send({ type: 'device:ready', sessionId: 'sess-1' })
      }, 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
    })
  })

  describe('shutdownDevice', () => {
    it('sends device:shutdown (with payload.deviceId) and resolves on device:shutdown-done', async () => {
      setTimeout(() => relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' }), 10)
      await expect(client.shutdownDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      const msg = await waitForMessage(relay, 'device:shutdown')
      // deviceId must be in the payload — the agent handler destructures msg.payload.deviceId.
      expect(msg).toMatchObject({ type: 'device:shutdown', sessionId: 'sess-1', payload: { deviceId: 'dev-1' } })
    })

    it('does not resolve on a different session\'s shutdown-done, only the matching one', async () => {
      const p = client.shutdownDevice('sess-1', 'dev-1')
      relay.send({ type: 'device:shutdown-done', sessionId: 'OTHER' })
      // A different session's completion must leave the promise pending.
      const outcome = await Promise.race([
        p.then(() => 'resolved'),
        new Promise<string>((r) => setTimeout(() => r('pending'), 40)),
      ])
      expect(outcome).toBe('pending')
      relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' })
      await expect(p).resolves.toBeUndefined()
    })

    it('fails on device:shutdown-error instead of waiting out the 30s deadline', async () => {
      // #542. The relay used to resolve this command's session inline and drop the frame when it could
      // not — the only browser command it never answered — so a shutdown addressed to a dead session
      // reported `Request timed out` with no cause, half a minute later.
      //
      // **The relay half alone would not have fixed this caller.** The predicate matched
      // `device:shutdown-done` only, so the new reply would have been ignored and the deadline would run
      // exactly as before — and nothing would say so, because inbound here is `Record<string, unknown>`
      // (#512) and the symptom is identical to the bug.
      const p = client.shutdownDevice('sess-1', 'dev-1')
      const sent = await waitForMessage(relay, 'device:shutdown')
      relay.send({
        type: 'device:shutdown-error', sessionId: 'sess-1',
        requestId: sent['requestId'], message: 'agent offline',
      })
      await expect(p).rejects.toThrow(/agent offline/)
    })

    it('does not take another request\'s shutdown-error as its own answer', async () => {
      // The correlator is optional on this pair, so `correlatesWith` falls back to the session when the
      // reply carries none — but a reply that carries a *different* id is another request's, and taking
      // it would resolve one shutdown with another's outcome. Same shape as the `-done` guard below.
      const p = client.shutdownDevice('sess-1', 'dev-1')
      await waitForMessage(relay, 'device:shutdown')
      relay.send({
        type: 'device:shutdown-error', sessionId: 'sess-1',
        requestId: 'someone-elses', message: 'agent offline',
      })
      const outcome = await Promise.race([
        p.then(() => 'settled', () => 'settled'),
        new Promise<string>((r) => setTimeout(() => r('pending'), 40)),
      ])
      expect(outcome).toBe('pending')
      relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' })
      await expect(p).resolves.toBeUndefined()
    })
  })

  describe('tap', () => {
    it('sends touch:start then touch:end with coordinates', async () => {
      await client.tap('sess-1', 100, 200)
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
      expect(msgs[1]).toMatchObject({ type: 'input:touch:end', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
    })

    it('throws when the agent acks input:error (device not booted)', async () => {
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
    })

    // The reason is what lets a caller tell "retry in a moment" from "reconnect" from "never retry".
    // Acting on it is #457; carrying it is this change.
    it('includes the machine-readable reason when the agent sends one', async () => {
      relay.setInputAck('error-with-reason')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow(/channel-starting/)
    })

    it('behaves exactly as before for an agent that sends no reason', async () => {
      // The field is required as of #491; an agent outside this repo predating it still omits one, which is the population the branch is for — absence must not change anything.
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
    })

    it('resolves optimistically when an older agent never acks (degradation)', async () => {
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
    })

    // The input is already on the wire by the time the ack is awaited — `tap` sends both frames first —
    // so a close means "could not confirm", not "was not dispatched". It used to say the latter.
    it('reports a drop mid-input as unconfirmed, not as undispatched', async () => {
      relay.setInputAck('none') // no ack will arrive
      const p = client.tap('sess-1', 1, 2)
      relay.lastClient().close() // drop the connection while awaiting the ack
      const err = await p.catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/could not confirm/i)
      expect(err.message).toMatch(/may have landed/i)
      expect(err.message).toMatch(/do not repeat/i)
    })

    // And it does not depend on the ledger: a close is not evidence about whether the agent acks, so a
    // session that has never answered one still gets the truth rather than an optimistic success.
    it('reports a drop as unconfirmed even on a session that never acked', async () => {
      relay.setInputAck('none')
      const p = client.tap('sess-NEW', 1, 2)
      relay.lastClient().close()
      await expect(p).rejects.toThrow(/could not confirm/i)
    })
  })

  // #457. Silence used to be reported as success, so a tap that never reached the device was reported
  // as landed to a model that then moved on. Two decisions carry the fix, and both are tested here:
  // silence is answered with "could not confirm" rather than "dropped", and whether it is fatal at all
  // is decided by what this session has already done rather than by a negotiated flag.
  //
  // The silent paths each cost the real 2s ack window. Fake timers are not an option — these drive a
  // real WebSocket — so the count of them is kept deliberately small.
  describe('input ack truthfulness (#457)', () => {
    it('throws once a session has acked before and then goes silent', async () => {
      await client.tap('sess-1', 1, 2)          // acks: this agent demonstrably answers input
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 3, 4)).rejects.toThrow(/could not confirm/i)
    })

    // "Dropped" would invite a retry, and `ackInput` awaits a device verify on the first input after a
    // boot or reconnect — so an ack past the window can belong to an input that did land. Repeating it
    // would duplicate it.
    it('says the input may have landed, and does not call it dropped', async () => {
      await client.tap('sess-1', 1, 2)
      relay.setInputAck('none')
      const err = await client.tap('sess-1', 3, 4).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/may have landed/i)
      expect(err.message).not.toMatch(/dropped/i)
      expect(err.message).toMatch(/do not repeat/i)
    })

    // Only `input:done` is the agent's word. The relay originates `input:error` to this same socket for
    // a terminal input it cannot dispatch, so counting errors would let one agent-offline blip mark a
    // session as acking when its agent may never have answered anything — and every later input would
    // then be reported as unconfirmed on evidence the agent did not produce.
    it('does not treat an input:error as evidence that the agent acks', async () => {
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 3, 4)).resolves.toBeUndefined()
    })

    // The relay's own reply, verbatim: `agent offline` with `channel-unavailable`, which is what an
    // older agent's session looks like from here. It must not arm the gate against that agent.
    it('is not armed by the relay answering on an absent agent behalf', async () => {
      relay.setInputAck('none')
      relay.send({ type: 'input:error', sessionId: 'sess-1', message: 'agent offline', reason: 'channel-unavailable' })
      await new Promise((r) => setTimeout(r, 20))
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
    })

    // The ledger is written where messages arrive, not where an ack is awaited — so an ack that missed
    // its own window still teaches us this agent acks. That case is the whole reason for the placement:
    // a ledger kept at the waiter would learn nothing from it.
    it('learns from an ack that arrives after its window expired', async () => {
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined() // optimistic, nothing acked
      // The late ack carries the id the first tap minted. Read back, not invented: the ledger records a
      // **correlated** done and only that, so an invented id would test the opposite of this test's subject.
      const sent = relay.sentMessages().filter((m) => m['type'] === 'input:touch:end').at(-1)
      relay.send({ type: 'input:done', sessionId: 'sess-1', requestId: sent!['requestId'] })
      await new Promise((r) => setTimeout(r, 20))
      await expect(client.tap('sess-1', 3, 4)).rejects.toThrow(/could not confirm/i)
      // Two serial 2s windows plus a handshake; vitest's unconfigured default is 5s, which this would
      // otherwise sit at 80% of and flake on a loaded runner.
    }, 15_000)

    it('is not satisfied by an ack carrying no correlator', async () => {
      // **The no-fallback rule, and nothing else held it**: adding `m['requestId'] === undefined ||` to the
      // waiter left all 77 tests passing in the mutation round. A fallback here would keep #499 exactly as
      // it is — an ack that missed its own deadline still matching the next input's waiter — which is the
      // one thing this layer exists to remove. The lifecycle pair (#521) has a fallback because its replies
      // have producers that answer no request; every producer of `input:done` answers a terminal input.
      const ws = relay.lastClient()
      relay.setInputAck('none')
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'input:touch:end') return
        ws.send(JSON.stringify({ type: 'input:done', sessionId: msg['sessionId'] })) // no requestId
      })
      // Resolves optimistically rather than on that ack — the session has never produced a matchable one,
      // so `strict` is false. What this pins is that the ack did not *satisfy the waiter*: with a fallback
      // it would, and the assertion below is what tells the two apart.
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()

      // Now make the session strict with a correlated ack, then send an uncorrelated one for the next tap.
      relay.setInputAck('done')
      await client.tap('sess-1', 3, 4)
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 5, 6)).rejects.toThrow(/could not confirm/i)
    }, 15_000)

    it('does not learn from an uncorrelated late ack, and says why once', async () => {
      // An agent predating the correlator. Its acks can never match a waiter, so silence on this session is
      // **structural** rather than anomalous — recording it would make every later input report a failure
      // the agent never had a chance to avoid. The skew is logged instead, because nothing else in this
      // system announces an agent's version and dropping the signal silently returns the session to
      // optimistic reporting, which reads exactly like the defect #457 fixed.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        relay.setInputAck('none')
        await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
        relay.send({ type: 'input:done', sessionId: 'sess-1' })   // no requestId: an old agent
        await new Promise((r) => setTimeout(r, 20))
        // Still optimistic, because the ledger did not record an ack it cannot match.
        await expect(client.tap('sess-1', 3, 4)).resolves.toBeUndefined()
        relay.send({ type: 'input:done', sessionId: 'sess-1' })
        await new Promise((r) => setTimeout(r, 20))
      } finally { spy.mockRestore() }
      // Once per session, not once per ack: an old agent answers every input this way, and a line per tap
      // would bury the one thing the operator needs to read.
      expect(logged.filter((l) => l.includes('predates input correlation'))).toHaveLength(1)
    }, 15_000)

    // A per-session ledger, not a per-client one: one session's agent acking says nothing about
    // another's. If it were global this would throw.
    it('does not let one session make another strict', async () => {
      await client.tap('sess-1', 1, 2)
      relay.setInputAck('none')
      await expect(client.tap('sess-OTHER', 3, 4)).resolves.toBeUndefined()
    })

    // Regression guard for a discarded design. The first plan retried some reasons inside this client;
    // the design review found that unsafe, because `no-gesture` can mean either "nothing landed" or
    // "the opening frames landed and only the last was refused" and the wire cannot tell them apart.
    // Retrying is the caller's decision, so the client must never re-send on its own.
    it('never re-sends an input on any reason', async () => {
      relay.setInputAck('error-with-reason')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow()
      const ends = relay.sentMessages().filter((m) => m['type'] === 'input:touch:end')
      expect(ends).toHaveLength(1)
    })

    it('carries the advice for the reason into the thrown message', async () => {
      relay.setInputAck('error-with-reason') // channel-starting
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow(REASON_ADVICE['channel-starting'])
    })
  })

  describe('swipe', () => {
    it('sends touch:start, multiple touch:move, and touch:end', async () => {
      await client.swipe('sess-1', 0, 0, 100, 100, 80)
      await waitForMessage(relay, 'input:touch:end')
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', payload: { x: 0, y: 0 } })
      expect(msgs[msgs.length - 1]).toMatchObject({ type: 'input:touch:end', payload: { x: 100, y: 100 } })
      const moves = msgs.filter((m) => m['type'] === 'input:touch:move')
      expect(moves.length).toBe(7) // STEPS - 1
    })
  })

  describe('typeText', () => {
    // Answered off the request rather than on a timer, because the reply must now carry the id the client
    // minted and that id is only knowable once the request has arrived.
    const answerType = (reply: (m: Record<string, unknown>) => Record<string, unknown>) => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] === 'input:type') ws.send(JSON.stringify(reply(msg)))
      })
    }

    it('sends input:type and resolves on input:type-done', async () => {
      answerType((m) => ({ type: 'input:type-done', sessionId: 'sess-1', requestId: m['requestId'] }))
      await expect(client.typeText('sess-1', 'hello')).resolves.toBeUndefined()
      expect(await waitForMessage(relay, 'input:type')).toMatchObject({ type: 'input:type', sessionId: 'sess-1', payload: { text: 'hello' } })
    })

    it('does not take the previous typing\'s reply', async () => {
      // Both tests here answer with the id the client minted, so dropping `requestId` from the predicate
      // matched either way — the echo made the assertion vacuous, which review measured. A **stale** reply
      // is what tells the two apart, and it is #499's shape for `input:type` specifically: a late
      // `input:type-done` from the previous call landing in this one's waiter.
      // The stale reply is an **error** and the real one a success, so which of the two resolved the call is
      // observable. A first version sent two successes and asserted the request count — 1 either way, so it
      // passed with the correlator check deleted. Asserting a property needs the mutation that removes it to
      // fail, and counting requests was not that.
      answerType((m) => {
        const ws = relay.lastClient()
        setTimeout(() => ws.send(JSON.stringify({
          type: 'input:type-done', sessionId: 'sess-1', requestId: m['requestId'],
        })), 20)
        return { type: 'input:type-error', sessionId: 'sess-1', requestId: 'a-previous-call', message: 'stale' }
      })
      await expect(client.typeText('sess-1', 'hello')).resolves.toBeUndefined()
    }, 20_000)

    it('throws on input:type-error', async () => {
      answerType((m) => ({ type: 'input:type-error', sessionId: 'sess-1', requestId: m['requestId'], message: 'No booted device' }))
      await expect(client.typeText('sess-1', 'x')).rejects.toThrow('No booted device')
    })
  })

  describe('pressKey', () => {
    it('sends the agent contract { code, modifiers } — not { key }', async () => {
      await client.pressKey('sess-1', 'Enter')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ type: 'input:key', sessionId: 'sess-1', payload: { code: 'Enter', modifiers: 0 } })
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('key')
    })

    it('maps the Return alias to Enter (no platform maps "Return")', async () => {
      await client.pressKey('sess-1', 'Return')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ payload: { code: 'Enter', modifiers: 0 } })
    })

    it('passes other KeyboardEvent.code names through unchanged', async () => {
      await client.pressKey('sess-1', 'Backspace')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ payload: { code: 'Backspace', modifiers: 0 } })
    })
  })

  describe('pressButton', () => {
    it('sends the agent contract { name } — not { button }', async () => {
      await client.pressButton('sess-1', 'home')
      const msg = await waitForMessage(relay, 'input:button')
      expect(msg).toMatchObject({ type: 'input:button', sessionId: 'sess-1', payload: { name: 'home' } })
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('button')
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('phase')
    })
  })

  // Reverting all four predicates from `requestId` back to `sessionId` left this suite green, because the
  // fixtures echo the id and both fields then agree. These distinguish the two: a reply with the right
  // session and the wrong correlator must not resolve, which is only true if the client matches on the
  // correlator.
  describe('correlator matching', () => {
    it('does not resolve installApp on a reply for another request', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:install') return
        ws.send(JSON.stringify({ type: 'app:install-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const pending = client.installApp('sess-1', 42)
      const settled = await Promise.race([
        pending.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('does not resolve clearState on a reply for another request', async () => {
      // `clearState` had no test at all, which is why the plan's "seven fixtures to rewrite" became four.
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:clear-state') return
        ws.send(JSON.stringify({ type: 'app:clear-state-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.clearState('sess-1', 'com.example.app').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    // ── L5b′: the lifecycle pair, whose correlator is optional ─────────────────────────────────
    //
    // Different from the four above: an absent `requestId` is **accepted** here, because
    // `device:ready` and `device:boot-error` have producers that answer no request — the relay replays
    // a cached ready to a re-joining viewer, and an Android stream that dies mid-session reports it as
    // a boot error. What the correlator buys is the rejection of a *mismatched* id.

    it('mints a correlator on device:boot', async () => {
      setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
      await client.bootDevice('sess-1', 'dev-1')
      const bootMsg = await waitForMessage(relay, 'device:boot')
      expect(typeof bootMsg['requestId']).toBe('string')
      expect(bootMsg['requestId']).not.toBe('')
    })

    it('does not resolve a boot on a ready carrying another request\'s correlator', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.bootDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('resolves a boot on the ready that answers it', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: msg['requestId'] }))
      })
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
    })

    it('rejects a boot on the boot-error that answers it, and not on one that does not', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        // A diagnosis for someone else's boot first. Accepting it would fail a boot that is still
        // perfectly capable of succeeding, which is the mirror image of the deadline defect.
        ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: 'sess-1', requestId: 'not-mine', message: 'other' }))
        setTimeout(() => ws.send(JSON.stringify({
          type: 'device:boot-error', sessionId: 'sess-1', requestId: msg['requestId'], message: 'mine',
        })), 20)
      })
      await expect(client.bootDevice('sess-1', 'dev-1')).rejects.toThrow('mine')
    })

    it('accepts a ready with no correlator, and says so', async () => {
      // An agent predating the echo, and the relay's own replay. Dropping these would trade a
      // misattribution for a 30s hang, so the fallback stands — but silently falling back is how a
      // half-upgraded fleet stays invisible, so it is logged.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
        await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      } finally { spy.mockRestore() }
      expect(logged.some((l) => l.includes('device:ready') && l.includes('no requestId'))).toBe(true)
    })

    it('is not satisfied by the relay\'s replay, which carries no sessionId at all', async () => {
      // The replay frame is `{ type, payload }`. It is cached state addressed to a **join**, not an
      // answer to a **boot**, and `readySent` is cleared by nothing while an agent is wedged-but-
      // connected — which is exactly when a boot hangs, so the value is stalest when it would be
      // consumed. What keeps it out is the `sessionId` comparison, not the correlator: an optional
      // field can make a frame match more precisely, never make it fail to match.
      //
      // Staged genuinely mid-boot, which matters. In the ordinary sequence this client registers its
      // boot waiter only after `session:start` resolves, and the relay sends its replays during that
      // join — so the replay is dropped before any waiter exists and a test that merely joins first
      // would pass with the comparison deleted.
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', payload: { deviceId: 'dev-1' } }))
      })
      const settled = await Promise.race([
        client.bootDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('sends the one reply to the boot it answers, not to whichever waited first', async () => {
      // **The correlator\'s actual payoff on this pair, and it is not "both boots resolve".** A superseded
      // boot is answered by nothing at all — `bootSeq` makes every checkpoint in the agent return silently
      // — so one of two overlapping boots times out either way. What the correlator changes is which.
      // `dispatch` resolves the first waiter whose predicate matches and then stops, so on `sessionId` +
      // type alone that single reply went to the boot registered **first**, i.e. the superseded one, and
      // the boot that actually happened was reported as a failure.
      const ws = relay.lastClient()
      const ids: string[] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ids.push(msg['requestId'] as string)
        // Answer only the second, the way a real agent does once `bootSeq` has moved on.
        if (ids.length === 2) {
          ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: ids[1] }))
        }
      })

      const first = client.bootDevice('sess-1', 'dev-1')
      const second = client.bootDevice('sess-1', 'dev-1')

      await expect(second).resolves.toBeUndefined()
      expect(await Promise.race([
        first.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])).toBe('still-waiting')
      first.catch(() => { /* it times out on its own deadline; nothing here waits for that */ })
    })

    it('mints a correlator on device:shutdown', async () => {
      // `bootDevice` has this and `shutdownDevice` did not, and the two tests either side of it cannot
      // stand in: `toMatchObject` ignores a key that is absent, and the mismatch case below still passes
      // against a hardcoded foreign id even when nothing was sent. Leave the id off the wire and the agent
      // has nothing to echo, so `correlatesWith` falls back and resolves `shutdown_device` on *any*
      // shutdown-done for the session — the relay's idle timer or the dashboard's unmount teardown can
      // satisfy a shutdown that has not happened. It also logs "carried no requestId" on every call,
      // blaming the agent for the client's omission.
      setTimeout(() => relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' }), 10)
      await client.shutdownDevice('sess-1', 'dev-1')
      const msg = await waitForMessage(relay, 'device:shutdown')
      expect(typeof msg['requestId']).toBe('string')
      expect(msg['requestId']).not.toBe('')
    })

    it('does not resolve a shutdown on a done carrying another request\'s correlator', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:shutdown') return
        ws.send(JSON.stringify({ type: 'device:shutdown-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.shutdownDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('resolves clearState on its own reply', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:clear-state') return
        ws.send(JSON.stringify({ type: 'app:clear-state-done', sessionId: 'sess-1', requestId: msg['requestId'] }))
      })
      await expect(client.clearState('sess-1', 'com.example.app')).resolves.toBeUndefined()
    })
  })

  describe('installApp', () => {
    it('sends app:install and resolves on app:install-done', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-done', sessionId: 'sess-1' })
      await expect(client.installApp('sess-1', 42)).resolves.toBeUndefined()
      // Await the outbound message's arrival (same ws race as bootDevice above).
      expect(await waitForMessage(relay, 'app:install')).toMatchObject({ type: 'app:install', sessionId: 'sess-1', buildId: 42 })
    })

    it('throws on app:install-error', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-error', sessionId: 'sess-1', message: 'Build not found' })
      await expect(client.installApp('sess-1', 99)).rejects.toThrow('Build not found')
    })
  })

  describe('launchApp', () => {
    it('sends app:launch and resolves on app:launch-done', async () => {
      echoReply(relay, 'app:launch', { type: 'app:launch-done', sessionId: 'sess-1' })
      await expect(client.launchApp('sess-1', 42)).resolves.toBeUndefined()
    })

    it('throws on app:launch-error', async () => {
      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'Bundle ID not available' })
      await expect(client.launchApp('sess-1', 99)).rejects.toThrow('Bundle ID not available')
    })
  })

  describe('screenshot', () => {
    it('calls REST endpoint with PAT and returns buffer', async () => {
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const origFetch = globalThis.fetch

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/screenshot')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(fakePng, { status: 200, headers: { 'Content-Type': 'image/png' } })
      }

      try {
        const buf = await client.screenshot('sess-1')
        expect(buf).toEqual(fakePng)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('uses jpeg format query param when requested', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL) => {
        expect(String(url)).toContain('format=jpeg')
        return new Response(Buffer.from([0xff, 0xd8]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      }
      try {
        await client.screenshot('sess-1', 'jpeg')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('passes an abort signal to the screenshot request', async () => {
      const controller = new AbortController()
      const origFetch = globalThis.fetch
      globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal)
        return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 })
      }
      try {
        await client.screenshot('sess-1', 'png', controller.signal)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('throws on 401', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      try {
        await expect(client.screenshot('sess-1')).rejects.toThrow('Unauthorized')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('falls back to the response text when the error body is not JSON', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      try {
        await expect(client.screenshot('sess-1')).rejects.toThrow('Bad Gateway')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('queryUITree', () => {
    const ELEMENTS = [
      {
        role: 'button',
        label: 'Login',
        identifier: 'com.example.app:id/login',
        frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
        enabled: true,
        rawRole: 'android.widget.Button',
      },
    ]

    it('calls the ui-tree REST endpoint with PAT and returns elements', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/ui-tree')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(JSON.stringify({ elements: ELEMENTS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      try {
        const elements = await client.queryUITree('sess-1')
        expect(elements).toEqual(ELEMENTS)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('passes an abort signal to the ui-tree request', async () => {
      const controller = new AbortController()
      const origFetch = globalThis.fetch
      globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal)
        return new Response(JSON.stringify({ elements: ELEMENTS }), { status: 200 })
      }
      try {
        await client.queryUITree('sess-1', controller.signal)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it.each([500, 502, 503, 504])('classifies %d as transient query error (retryable)', async (status) => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'temporary' }), { status })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toBeInstanceOf(TransientQueryError)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it.each([
      {},
      { elements: [{}] },
      { elements: [{ role: 'button', label: 'x', frame: { x: 0, y: 0, width: 2, height: 1 }, enabled: true }] },
    ])('rejects malformed successful ui-tree responses', async (body) => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('invalid response shape')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('falls back to the response text when the error body is not JSON', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('Bad Gateway')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('surfaces the relay error body (e.g. 502 dump failure) as an exception', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'uiautomator dump produced no XML within 10s' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('uiautomator dump produced no XML')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('listBuilds', () => {
    it('unwraps { items }, maps uploaded_at→createdAt, and pages through total', async () => {
      const origFetch = globalThis.fetch
      // 3 builds across 2 pages (limit=100 requested; server splits for the test)
      const allBuilds = [
        { id: 7, app_id: 1, version_name: '1.0', build_number: '42', platform: 'ios', status_label: null, uploaded_at: '2026-07-01' },
        { id: 8, app_id: 1, version_name: '1.1', build_number: '43', platform: 'ios', status_label: 'Done', uploaded_at: '2026-07-02' },
        { id: 9, app_id: 1, version_name: '1.2', build_number: '44', platform: 'ios', status_label: null, uploaded_at: '2026-07-03' },
      ]
      globalThis.fetch = async (url: RequestInfo | URL) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/apps')) {
          // real server column is bundle_id_key, not bundle_id
          return new Response(JSON.stringify({ items: [{ id: 1, name: 'TheApp', bundle_id_key: 'com.example', platform: 'ios' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        const page = Number(u.searchParams.get('page'))
        const items = page === 0 ? allBuilds.slice(0, 2) : allBuilds.slice(2)
        return new Response(JSON.stringify({ items, total: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      try {
        const apps = await client.listBuilds()
        expect(apps).toHaveLength(1)
        expect(apps[0].bundleId).toBe('com.example') // from bundle_id_key, not undefined
        // all three builds returned (not just the first page)
        expect(apps[0].builds.map((b) => b.id)).toEqual([7, 8, 9])
        expect(apps[0].builds[0].createdAt).toBe('2026-07-01')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  // #512, finding 4. The relay reports a session's fate on three messages and sends them **without closing
  // the socket**, so before this the `close` handler never ran and no waiter was settled.
  //
  // Only `session:terminated` settles anything, and the two that do not are the part worth pinning: both
  // agents reconnect **without restarting the process**, so a request that finishes after the reconnect
  // still answers on the new socket, and rejecting on `rebound` or `agent-away` would fail requests that
  // succeed today. The relay's 15s grace exists to keep exactly those alive.
  describe('session lifecycle (#512, finding 4)', () => {
    const terminated = (sessionId: string) =>
      ({ type: 'session:terminated', sessionId, reason: 'agent-disconnected' })

    it('settles an in-flight install the moment the session is terminated', async () => {
      const install = client.installApp('sess-1', 42)
      await waitForMessage(relay, 'app:install')
      relay.send(terminated('sess-1'))
      const err = await install.catch((e: unknown) => e) as SessionEndedError
      expect(err).toBeInstanceOf(SessionEndedError)
      expect(err.reason).toBe('agent-disconnected')
    })

    // The session being gone is a fact the relay states. Whether the request reached the device before the
    // agent went is not knowable from here, and a message reading as a clean failure would invite a model
    // to repeat a command that may already have run.
    it('separates what is certain from what is not', async () => {
      const install = client.installApp('sess-1', 42)
      await waitForMessage(relay, 'app:install')
      relay.send(terminated('sess-1'))
      const err = await install.catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/session is gone is certain/i)
      expect(err.message).toMatch(/whether the request reached the device is not/i)
      expect(err.message).toMatch(/check device state/i)
    })

    // The reason `Waiter` gained a `sessionId`. This is a long-lived stdio process and a model can hold
    // several sessions, so rejecting the whole array would fail commands on devices that are healthy.
    it("leaves another session's waiter alone", async () => {
      echoReply(relay, 'app:install', { type: 'app:install-done', sessionId: 'sess-1' })
      const install = client.installApp('sess-1', 42)
      relay.send(terminated('other-session'))
      await expect(install).resolves.toBeUndefined()
    })

    it('leaves a session-less waiter alone', async () => {
      const listing = client.listDevices()
      relay.send(terminated('sess-1'))
      relay.send({ type: 'agents:listed', sessions: [] })
      await expect(listing).resolves.toEqual([])
    })

    // **The mutation guard for the non-boot half of the design.** Rejecting a non-boot request here is
    // the obvious-looking change and it is a regression. Boots are the exception, not the rule — see
    // the #583 block below.
    it('does NOT settle an in-flight request on rebound — the reply can still arrive', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-done', sessionId: 'sess-1' })
      const install = client.installApp('sess-1', 42)
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await expect(install).resolves.toBeUndefined()
    })

    it('does NOT settle an in-flight request on agent-away — the relay is still holding the session', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-done', sessionId: 'sess-1' })
      const install = client.installApp('sess-1', 42)
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      await expect(install).resolves.toBeUndefined()
    })

    // **The sharpest case in this change.** A session that has never acked takes the optimistic path, which
    // is the *first input after a boot* — and `agent-away` is exactly when its ack cannot come, because the
    // relay only refuses inputs sent after the agent went and this one is already in flight. Without the
    // away check this resolves, reporting a tap that could not have been delivered as landed: #457's defect
    // reached through a door this client can now see through.
    it('does not report an input as landed while the relay says the agent is away', async () => {
      relay.setInputAck('none')
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      await settle(relay, client)
      const err = await client.tap('sess-1', 1, 2).catch((e: unknown) => e) as Error
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/could not confirm/i)
      expect(err.message).toMatch(/went away/i)
      expect(err.message).toMatch(/may have landed/i)
    }, 15_000)

    // A rebound session answers commands with `No booted device`, which is true and points a model nowhere:
    // the simulator is booted and the app is on screen. Saying the device reset would send it to reinstall
    // an app that is running.
    it('explains a later failure on a rebound session as a reconnect, not as a device reset', async () => {
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'No booted device' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/No booted device/)
      expect(err.message).toMatch(/boot_device again/i)
      expect(err.message).not.toMatch(/reset/i)
    })

    // The relay answers an undispatchable shutdown as of #542, so this check is no longer the difference
    // between a diagnosis and 30s of nothing. What it still buys is a round trip and a better cause: the
    // relay's answer for a session it has dropped is `Session not found`, while this names *why* it was
    // dropped and throws the type the tool layer branches on.
    it('refuses a shutdown on a terminated session instead of waiting out 30s of silence', async () => {
      relay.send(terminated('sess-1'))
      await settle(relay, client)
      await expect(client.shutdownDevice('sess-1', 'dev-1')).rejects.toBeInstanceOf(SessionEndedError)
      expect(relay.sentMessages().find((m) => m['type'] === 'device:shutdown')).toBeUndefined()
    })

    it('takes all three with nothing pending', async () => {
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      relay.send(terminated('sess-1'))
      const listing = client.listDevices()
      relay.send({ type: 'agents:listed', sessions: [] })
      await expect(listing).resolves.toEqual([])
    })

    // `SessionTerminatedReason` has one member, so anything else means a relay newer than this client. The
    // comment on that branch says inventing `agent-disconnected` for a cause we cannot name is what
    // `reason` exists to stop — and with every test sending `agent-disconnected`, collapsing the ternary to
    // that constant was green.
    it('reads a reason it does not know as unknown rather than inventing one', async () => {
      const install = client.installApp('sess-1', 42)
      await waitForMessage(relay, 'app:install')
      relay.send({ type: 'session:terminated', sessionId: 'sess-1', reason: 'evicted-by-something-newer' })
      const err = await install.catch((e: unknown) => e) as SessionEndedError
      expect(err.reason).toBe('unknown')
      expect(err.message).not.toMatch(/agent-disconnected/)
    })

    // **A join is not a boot.** A draft deleted the whole lifecycle entry on `session:joined`, which undid
    // `needsReboot` silently — and `connect_device` is a tool a model calls freely, with the relay letting a
    // socket re-join the session it already holds. The reason for every later failure went with it.
    it('keeps the reboot note across a re-join', async () => {
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      echoReply(relay, 'session:start', { type: 'session:joined', sessionId: 'sess-1', capabilities: [] })
      await client.connectDevice('sess-1')

      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'No booted device' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/boot_device again/i)
    })

    // The half of a re-join that *does* reset: a socket that dropped inside the hold window missed whichever
    // outcome arrived while it was gone, so it starts from "not away" and lets the relay restate it.
    it('starts a re-join from not-away', async () => {
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      await settle(relay, client)
      echoReply(relay, 'session:start', { type: 'session:joined', sessionId: 'sess-1', capabilities: [] })
      await client.connectDevice('sess-1')

      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'nope' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toBe('nope')
    })

    // `needsReboot` is cleared only by a boot, so a flapping agent has it and `away` set at once. Only
    // `away` is current, and advising `boot_device` there names a call the relay refuses with `agent offline`.
    it('reports a live agent-away over a stale rebound', async () => {
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      await settle(relay, client)
      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'nope' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/went away/i)
      expect(err.message).not.toMatch(/boot_device again/i)
    })

    // A boot is the one thing that answers what a rebound cost the session, so it is the one thing that
    // clears the note. Without this the model is told to boot again after every failure on a session it has
    // already booted — a loop the note itself invites. `flow-runner` had this test and this package did not.
    it('stops asking for a reboot once one has happened', async () => {
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      echoReply(relay, 'device:boot', { type: 'device:ready', sessionId: 'sess-1' })
      await client.bootDevice('sess-1', 'dev-1')

      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'nope' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toBe('nope')
    })

    // The note decorates seven refusals and only `app:launch-error` was covered, so six call sites could be
    // reverted to a bare error with the suite green. This is the one that matters most: a refused input is
    // what #512's third finding was about.
    it('explains a refused input on a rebound session too', async () => {
      relay.setInputAck('error')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      const err = await client.tap('sess-1', 1, 2).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/device not booted/)
      expect(err.message).toMatch(/boot_device again/i)
    })

    // The one path in either client that rebuilds its own prose instead of wrapping the rejection, so the
    // one path where what the relay said about the session used to be dropped. A model whose input timed
    // out on a rebound session was told the ack went unanswered — true, and not the thing it can act on.
    it('names the rebound as the cause when an input times out on a rebound session', async () => {
      await client.tap('sess-1', 1, 2)          // acks, so the session is judged strictly from here
      relay.setInputAck('none')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      const err = await client.tap('sess-1', 3, 4).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/could not confirm/i)
      expect(err.message).toMatch(/boot_device again/i)
      // The prose is rebuilt here, so nothing else carries the original rejection's stack.
      expect(err.cause).toBeInstanceOf(Error)
    }, 15_000)

    // `sessionNote`'s three branches are ordered and the terminated one sits on top, but nothing read it:
    // the rejection builds its own prose and `shutdownDevice` reads the field directly. The branch is
    // reached by a command issued *after* the termination, which is what a caller that missed the
    // rejection does next.
    it('explains a command issued after the session ended', async () => {
      relay.send({ type: 'session:terminated', sessionId: 'sess-1', reason: 'agent-disconnected' })
      await settle(relay, client)
      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'Session not found' })
      const err = await client.launchApp('sess-1', 42).catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/Session not found/)
      expect(err.message).toMatch(/relay ended this session \(agent-disconnected\)/)
      expect(err.message).toMatch(/list_devices/)
    })

    // **The narrowing is deliberate, so it is pinned in both directions.** The guard is `away`, not "any
    // lifecycle note": a rebound session is answering again — the agent replies `input:error`/`no-session`
    // to an input on it — so silence there is once more the agent's to explain, and a session that has
    // never acked keeps the exemption. Widening the guard to `sessionNote(...) !== undefined` would leave
    // the away test green and silently drop this.
    it('still reports optimistically on a rebound session that has never acked', async () => {
      relay.setInputAck('none')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await settle(relay, client)
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
    }, 15_000)

    // The deadline is the moment the state was held for: a waiter shorter than the relay's 15s grace never
    // hears the outcome message, so the note is the only thing that can say why it gave up. Nothing answers
    // `session:start` in this fixture, so the join runs its full 5s.
    it('carries the note on a deadline, not only on a refusal', async () => {
      relay.send({ type: 'session:agent-away', sessionId: 'sess-2' })
      await settle(relay, client)
      const err = await client.connectDevice('sess-2').catch((e: unknown) => e) as Error
      expect(err.message).toMatch(/Request timed out/)
      expect(err.message).toMatch(/went away/i)
    }, 15_000)

    // #583. A boot in flight when the rebound arrives can never be answered: the binding a boot
    // creates is exactly what the rebind loses. Every other request type keeps waiting for its reply
    // on the new socket — boots are the one exception, settled here by waiter metadata (`isBoot`),
    // never by prose matching.
    it('settles a pending boot the moment the session rebounds', async () => {
      const boot = client.bootDevice('sess-1', 'dev-1')
      await waitForMessage(relay, 'device:boot')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      const err = await boot.catch((e: unknown) => e) as Error
      expect(err).toBeInstanceOf(Error)
      // The session is alive, only its device binding is gone — never the terminated shape.
      expect(err).not.toBeInstanceOf(SessionEndedError)
      expect(err.message).toMatch(/Boot failed/)
      expect(err.message).toContain('sess-1')
      expect(err.message).toMatch(/rebounded/)
      expect(err.message).toContain('the agent reconnected and cleared its device binding')
    })

    // The rejection above would be worthless if the tools layer read it as product. This feeds the
    // exact rejection through `makeFlowDriver`'s guard — the classifier every `run_flow` step failure
    // travels through — and holds the environmental retype there instead of trusting the prose.
    it('classifies the invalidated boot as environmental through the tools guard', async () => {
      const boot = client.bootDevice('sess-1', 'dev-1')
      await waitForMessage(relay, 'device:boot')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      const bootErr = await boot.catch((e: unknown) => e)
      const fake = { tap: async (): Promise<never> => { throw bootErr } } as unknown as TapflowClient
      const err = await makeFlowDriver(fake, 'sess-1').tap(0.5, 0.5).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EnvironmentStepError)
      expect(err).not.toBe(bootErr) // retyped, with the original kept as cause
      expect((err as Error).cause).toBe(bootErr)
    })

    // A boot issued *after* the rebound is the recovery boot that restores the binding. Settling is
    // synchronous at dispatch, so only waiters already registered are touched — this one must survive
    // the rebound and still be answerable.
    it('leaves a boot issued after the rebound pending — it is the recovery boot', async () => {
      const stale = client.bootDevice('sess-1', 'dev-1')
      await waitForMessage(relay, 'device:boot')
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await expect(stale).rejects.toBeInstanceOf(Error)
      echoReply(relay, 'device:boot', { type: 'device:ready', sessionId: 'sess-1' })
      const recovery = client.bootDevice('sess-1', 'dev-1')
      await expect(recovery).resolves.toBeUndefined()
    })

    // `agent-away` is the relay's hold window, not an answer: the agent may come back on the same
    // binding, so even a boot keeps waiting through it.
    it('does not cancel a pending boot on agent-away — the grace may still answer it', async () => {
      echoReply(relay, 'device:boot', { type: 'device:ready', sessionId: 'sess-1' })
      const boot = client.bootDevice('sess-1', 'dev-1')
      relay.send({ type: 'session:agent-away', sessionId: 'sess-1' })
      await expect(boot).resolves.toBeUndefined()
    })

    it("leaves another session's boot waiter alone on rebound", async () => {
      const mine = client.bootDevice('sess-1', 'dev-1')
      await waitForMessage(relay, 'device:boot')
      const other = client.bootDevice('sess-2', 'dev-2')
      // `waitForMessage` returns the first match, which is the other session's request — wait for
      // this session's own request instead, or the ready below would carry the wrong correlator.
      const otherReq = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const check = setInterval(() => {
          const found = relay.sentMessages().find((m) => m['type'] === 'device:boot' && m['sessionId'] === 'sess-2')
          if (found) { clearInterval(check); clearTimeout(timer); resolve(found) }
        }, 10)
        const timer = setTimeout(() => { clearInterval(check); reject(new Error('no sess-2 boot arrived')) }, 2000)
      })
      relay.send({ type: 'session:rebound', sessionId: 'sess-1', capabilities: [] })
      await expect(mine).rejects.toBeInstanceOf(Error)
      // Only the other session's boot is still waiting: answering it resolves, proving the rebound
      // settled nothing outside its session.
      relay.send({ type: 'device:ready', sessionId: 'sess-2', requestId: otherReq['requestId'] })
      await expect(other).resolves.toBeUndefined()
    })
  })

  describe('WebSocket lifecycle', () => {
    it('rejects pending waiters when WS closes', async () => {
      const promise = client.listDevices()
      relay.lastClient().close()
      await expect(promise).rejects.toThrow('WebSocket closed')
    })
  })
})

// The advice is what a language model acts on, so an entry that is missing, blank, or shared with a
// reason whose required action differs would send it the wrong way. `tsc` enforces that every reason
// has a key; none of the rest.
describe('REASON_ADVICE', () => {
  const reasons = Object.keys(REASON_ADVICE) as Array<keyof typeof REASON_ADVICE>

  it('gives every reason non-blank advice', () => {
    for (const r of reasons) expect(REASON_ADVICE[r].trim(), r).not.toBe('')
  })

  it('gives no two reasons the same advice', () => {
    const values = reasons.map((r) => REASON_ADVICE[r])
    expect(new Set(values).size).toBe(values.length)
  })

  // Absence means an agent older than the field, and an unfamiliar value means one newer than this
  // build. Both resolve to `channel-unavailable` — the protocol's conservative reading — rather than to
  // silence, which would be the dangerous direction.
  it.each([undefined, 'some-future-reason', 'toString'])('resolves %s to the channel-unavailable advice', (r) => {
    expect(reasonAdvice(r)).toBe(REASON_ADVICE['channel-unavailable'])
  })

  it('resolves a known reason to its own advice', () => {
    expect(reasonAdvice('no-gesture')).toBe(REASON_ADVICE['no-gesture'])
  })

  // The one reason whose advice must warn about duplication: it covers both "nothing landed" and
  // "part of the gesture already landed", and a caller that repeats it may duplicate what did.
  it('warns that no-gesture may already have applied part of the input', () => {
    expect(REASON_ADVICE['no-gesture']).toMatch(/duplicate|already/i)
  })

  // Uniqueness alone lets two bodies be swapped, which is how a "retry this" could end up on a reason
  // that must never be retried. These pin the *direction* of each one without freezing its wording —
  // wording stays a judgement call, per the same rule the dashboard's notices follow.
  it.each([
    ['channel-starting', /again/i],          // the only reason whose action is to repeat the input
    ['dispatch-failed', /do not repeat/i],   // stricter than the protocol table, on purpose
    ['unsupported', /do not retry/i],
    ['malformed', /bug/i],
    ['not-booted', /boot_device/],
    ['channel-unavailable', /reconnect/i],
  ] as const)('points %s in the right direction', (reason, expected) => {
    expect(REASON_ADVICE[reason]).toMatch(expected)
  })

  // And the two that must not be confusable: one says send it again, the other says never.
  it('does not tell the caller to repeat an input that may have doubled', () => {
    expect(REASON_ADVICE['dispatch-failed']).not.toMatch(/safe to send again|try it again/i)
  })
})

describe('the socket identifies its client to the relay (#527, #579)', () => {
  // **Nothing else holds this.** The diff that added ownership changed no test in this package, so
  // deleting the `client` parameter — or minting it per `connect()` instead of per instance — passes the
  // whole suite while costing this client the half of the change it is the beneficiary of: a reconnect
  // that re-joins its own sessions rather than contending with the socket it is replacing.
  it('sends a stable client id on the handshake, and the same one after a reconnect', async () => {
    const relay = createMockRelay()
    const seen: string[] = []
    relay.wss.on('connection', (_ws, req) => {
      seen.push(new URL(req.url ?? '/', 'http://x').searchParams.get('client') ?? '')
    })
    const client = new TapflowClient(`ws://localhost:${relay.port}`, '')
    await client.connect()
    // Disconnect between the two, which is what a reconnect is — and what keeps the first socket from
    // outliving the mock relay's `close()`, which waits on its clients.
    client.disconnect()
    await client.connect()
    client.disconnect()
    await relay.close()

    expect(seen).toHaveLength(2)
    expect(seen[0], 'no client id was sent').not.toBe('')
    expect(seen[1], 'a reconnect introduced itself as a different client').toBe(seen[0])
  })
})

describe('disconnect_device settles what was waiting on the session (#514)', () => {
  let relay: ReturnType<typeof createMockRelay>
  let client: TapflowClient

  beforeEach(async () => {
    relay = createMockRelay()
    // Nothing acks here: every request has to run to its 30s deadline unless something else settles it,
    // which is the point — a test that waited for one would take half a minute.
    relay.setInputAck('none')
    client = new TapflowClient(`ws://localhost:${relay.port}`, '')
    await client.connect()
  })

  afterEach(async () => { client.disconnect(); await relay.close() })

  it('rejects a request that was in flight, instead of leaving it on its deadline', async () => {
    const boot = client.bootDevice('sess-1', 'dev-1').catch((e: unknown) => e)
    await waitForMessage(relay, 'device:boot')
    client.disconnectDevice('sess-1')
    expect(await boot).toBeInstanceOf(SessionLeftError)
  })

  it('names the caller as the cause, not the relay', async () => {
    const boot = client.bootDevice('sess-1', 'dev-1').catch((e: unknown) => e) as Promise<Error>
    await waitForMessage(relay, 'device:boot')
    client.disconnectDevice('sess-1')
    const err = await boot
    // Not `SessionEndedError`: nothing was terminated, and the two advise different next calls.
    expect(err).not.toBeInstanceOf(SessionEndedError)
    expect(err.message).toMatch(/left session sess-1/)
    expect(err.message).toMatch(/connect_device again/)
  })

  it("leaves another session's waiters alone", async () => {
    const a = client.bootDevice('sess-1', 'dev-1').catch(() => 'rejected')
    const b = client.bootDevice('sess-2', 'dev-2').catch(() => 'rejected')
    await waitForMessage(relay, 'device:boot')
    client.disconnectDevice('sess-1')
    expect(await a).toBe('rejected')
    // `sess-2` must still be pending. A leave that emptied the array would settle it too, and every other
    // assertion in this block would still pass.
    const outcome = await Promise.race([b, new Promise((r) => setTimeout(() => r('pending'), 60))])
    expect(outcome).toBe('pending')
  })

  it('a reply for the same session arriving after the leave settles nothing', async () => {
    // #514's measured defect: re-joining reproduces the `sessionId`, so the relay's replayed session state
    // could satisfy a predicate registered before the leave — `boot_device` answering success for a boot
    // the agent never performed. With the waiter gone there is nothing left to satisfy.
    const boot = client.bootDevice('sess-1', 'dev-1').catch((e: unknown) => e) as Promise<Error>
    await waitForMessage(relay, 'device:boot')
    client.disconnectDevice('sess-1')
    expect(await boot).toBeInstanceOf(SessionLeftError)

    // **Asserted on the waiter list, not on the promise.** A first version re-asserted the boot after the
    // late reply, which cannot fail: that promise settled two lines earlier, so a waiter left in the array
    // would `resolve` it to no observable effect. Deleting the `splice` and keeping the `reject` passed it
    // — the one behaviour in this change with the largest consequence, held by nothing.
    const waiters = (client as unknown as { waiters: unknown[] }).waiters
    expect(waiters, 'the leave left a waiter behind for a session it left').toHaveLength(0)

    relay.send({ type: 'device:ready', sessionId: 'sess-1', payload: { deviceId: 'dev-1' } })
    await new Promise((r) => setTimeout(r, 30))
    expect(waiters).toHaveLength(0)
  })

  it('keeps the "may have landed, do not repeat" warning on an input killed by the leave', async () => {
    // **The safety half, and the one a new error class silently removes.** `awaitInputAck` branches on
    // class: an unknown one falls through `if (!timedOut && !disconnected) throw e` and never reaches the
    // "Could not confirm" wording. A model told only that it left the session repeats the tap — the report
    // this package's AGENTS.md forbids, reached by adding a rejection source rather than editing a message.
    const tap = client.tap('sess-1', 100, 200).catch((e: unknown) => e) as Promise<Error>
    await waitForMessage(relay, 'input:touch:end')
    client.disconnectDevice('sess-1')
    const err = await tap
    expect(err.message).toMatch(/reached the device is unknown/)
    expect(err.message).toMatch(/do not repeat/)
    expect(err.message).toMatch(/left session sess-1/)
  })

  it('settles every waiter on the session, not every other one', async () => {
    // The walk splices while iterating, so it runs backwards. Forwards it would skip the element that
    // slides into the index it just removed — with one waiter per session every other test here passes
    // either way, and this is the shape that does not.
    const boot = client.bootDevice('sess-1', 'dev-1').catch(() => 'rejected')
    const url = client.openUrl('sess-1', 'https://example.test').catch(() => 'rejected')
    const clear = client.clearState('sess-1', 'com.example').catch(() => 'rejected')
    await waitForMessage(relay, 'app:clear-state')
    client.disconnectDevice('sess-1')
    expect(await Promise.all([boot, url, clear])).toEqual(['rejected', 'rejected', 'rejected'])
  })

  it('leaves an untagged waiter alone', async () => {
    // `agents:list` registers with no session tag, because it carries none on the wire. A filter widened
    // to `w.sessionId !== undefined && w.sessionId !== sessionId` sweeps it up, and every other test here
    // passes either way because they all use a second *tagged* session.
    const list = client.listDevices().catch(() => 'rejected')
    const boot = client.bootDevice('sess-1', 'dev-1').catch(() => 'rejected')
    await waitForMessage(relay, 'device:boot')
    client.disconnectDevice('sess-1')
    expect(await boot).toBe('rejected')
    const outcome = await Promise.race([list, new Promise((r) => setTimeout(() => r('pending'), 60))])
    expect(outcome).toBe('pending')
  })

  it('a leave that cannot be sent settles nothing, so the close handler still owns those waiters', async () => {
    // **The ordering, made observable.** The `disconnect()` test below cannot see it: the close handler has
    // already emptied the array by then, so both orders look identical. A socket in CLOSING is the state
    // that separates them — `send` throws, the close event has not fired, and the waiters are still there.
    //
    // Settling first would report a leave for a request the socket killed. The relay never saw the leave,
    // and `RelayClosedError` is the truthful diagnosis, so this waiter has to survive for the close
    // handler that is about to run.
    const boot = client.bootDevice('sess-1', 'dev-1').catch(() => 'rejected')
    await waitForMessage(relay, 'device:boot')
    const holder = client as unknown as { ws: { readyState: number } | null }
    const real = holder.ws!
    holder.ws = { readyState: WebSocket.CLOSING }
    try {
      expect(() => client.disconnectDevice('sess-1')).toThrow(/not connected/i)
      const outcome = await Promise.race([boot, new Promise((r) => setTimeout(() => r('pending'), 60))])
      expect(outcome, 'the failed leave settled a waiter it never left').toBe('pending')
    } finally {
      holder.ws = real
    }
  })

  it('a leave on a closed socket throws and settles nothing itself', async () => {
    const boot = client.bootDevice('sess-1', 'dev-1').catch(() => 'rejected')
    await waitForMessage(relay, 'device:boot')
    client.disconnect()
    // The close handler has already cleared every waiter, so `send` throwing must not be what settles
    // them — a leave that never left would otherwise take the waiters of a session it never left.
    expect(() => client.disconnectDevice('sess-1')).toThrow(/not connected/i)
    expect(await boot).toBe('rejected')
  })
})
