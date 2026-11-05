import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import {
  InputRefusedError,
  InputUnconfirmedError,
  LeaseRefusedError,
  leasedSessionOf,
  RelayClient,
  RelayClosedError,
  AdmissionRefusedError,
  RelayHttpError,
  SessionEndedError,
  SessionJoinError,
  SessionLeftError,
  SessionUnavailableError,
} from '../RelayClient.js'
import { RelayDriver } from '../RelayDriver.js'
import { DeviceLacksError, TransientQueryError, isEnvironmentStepFailure } from '../errors.js'

// Minimal Response stub for the ui-tree GET.
function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response
}

function client(): RelayClient {
  return new RelayClient('ws://localhost:4000', 'tok')
}

describe('RelayClient.queryUITree — transient vs permanent classification', () => {
  afterEach(() => vi.restoreAllMocks())

  it('200 → returns elements', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { elements: [{ role: 'button', label: 'x', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }] }))
    const els = await client().queryUITree('s1')
    expect(els).toHaveLength(1)
  })

  it.each([502, 504, 500, 503])('%d → TransientQueryError (retryable)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, { error: 'transient' }))
    await expect(client().queryUITree('s1')).rejects.toBeInstanceOf(TransientQueryError)
  })

  it.each([400, 401, 403, 404, 409])('%d → NOT transient (fail-fast)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, { error: 'nope' }))
    const err = await client().queryUITree('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayHttpError)
    expect(err).not.toBeInstanceOf(TransientQueryError)
  })

  it('network failure (fetch rejects) → TransientQueryError, preserving the original cause', async () => {
    const original = new Error('ECONNREFUSED')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original)
    const err = await client().queryUITree('s1').catch((e: unknown) => e) as Error
    expect(err).toBeInstanceOf(TransientQueryError)
    expect((err.cause as Error).cause).toBe(original) // original fetch error chained through the wrappers
  })

  it('a stalled request aborted by the signal → TransientQueryError (never hangs)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) =>
      new Promise<Response>((_resolve, reject) => {
        (opts as RequestInit | undefined)?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
      }),
    )
    await expect(client().queryUITree('s1', AbortSignal.timeout(10))).rejects.toBeInstanceOf(TransientQueryError)
  })

  it('carries the server error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, { error: 'is the app running in the foreground?' }))
    await expect(client().queryUITree('s1')).rejects.toThrow('is the app running in the foreground?')
  })

  it.each([
    {},
    { elements: [{}] },
    { elements: [{ role: 'button', label: 'x', frame: { x: -1, y: 0, width: 1, height: 1 }, enabled: true }] },
    { elements: [{ role: 'future-role', label: 'x', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }] },
  ])('classifies invalid response shapes as permanent relay errors', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response)
    const err = await client().queryUITree('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayHttpError)
    expect((err as RelayHttpError).permanent).toBe(true)
    expect((err as Error).message).toContain('invalid response shape')
  })

  it('classifies invalid JSON as a permanent relay error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('unexpected end of input') },
    } as unknown as Response)
    const err = await client().queryUITree('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayHttpError)
    expect((err as RelayHttpError).permanent).toBe(true)
    expect((err as Error).message).toContain('invalid JSON')
  })
})


// L5b′. `bootDevice` correlates by `requestId` when the reply carries one and by `sessionId` + type
// when it does not. Both halves are tested here rather than assumed from `mcp-server`, because
// `correlatesWith` is duplicated between the two clients — protocol cannot host it (its main entry has
// to erase under `import type`), so the one thing keeping the copies honest is that each has tests.
//
// Nothing else covers it: the correlator is optional, so `<Pair>ReplyBody` cannot exist for it and
// `correlatedRequestsGated` derives only required declarations.
// L5c. `tap`, `swipe` and `pressKey` await nothing, so the correlator they mint is the only thing standing
// between a flow and a silent no-op: the relay drops an acked input whose id is absent or `''`, without
// answering, and these three senders would never know. Review measured it — setting all three to `''` left
// all 63 tests passing, and a flow whose every tap, swipe and key press never left the relay reports **PASS**.
// The old code could not fail this way, because there was no id to get wrong.
//
// Read off the wire rather than asserted at the call site: what matters is what the relay would receive.
describe('RelayClient — the input senders mint a correlator and await the ack', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  // `ack` is what the agents and the relay do for every terminal input. A server that stays silent models an
  // agent older than the ack contract, which is not what these tests are about — the refusal tests below
  // pass their own reply instead.
  async function capture(ack: (msg: Record<string, unknown>) => Record<string, unknown> | null = (m) => ({
    type: 'input:done', sessionId: m['sessionId'], requestId: m['requestId'],
  }), withListener = false) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
        // The five acked requests, per protocol/AGENTS.md — the four terminal frames and `input:type`.
        // Opening and move frames are silent by contract.
        if (msg['type'] === 'input:touch:end' || msg['type'] === 'input:key' || msg['type'] === 'input:button' || msg['type'] === 'input:pinch:end') {
          const reply = ack(msg)
          if (reply) ws.send(JSON.stringify(reply))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    if (withListener) client.setStreamListener({ frame: () => {}, event: () => {} })
    await client.joinSession('s1')
    return { client, received }
  }

  // `clientKind` is what makes a CI run watchable by a teammate — without it the relay treats this client
  // as one that predates watching.
  it('says it is the flow runner when it joins', async () => {
    const { received } = await capture()
    expect(received.find((m) => m['type'] === 'session:start')).toMatchObject({ sessionId: 's1', clientKind: 'flow-runner' })
  })

  // X1: with nothing reading the stream the relay need not send it; a run that records video sets its listener first.
  it('asks for no stream unless a stream listener is set before joining', async () => {
    const without = await capture()
    expect(without.received.find((m) => m['type'] === 'session:start')).toMatchObject({ stream: false })
    expect(() => without.client.setStreamListener({ frame: () => {}, event: () => {} })).toThrow(/before joinSession/)
    expect(() => without.client.setStreamListener(null)).not.toThrow()
    without.client.disconnect()
    const first = wss!
    for (const c of first.clients) c.terminate()
    await new Promise<void>((r) => first.close(() => r()))
    const withListener = await capture(undefined, true)
    expect(withListener.received.find((m) => m['type'] === 'session:start')).not.toHaveProperty('stream')
  })

  // The relay gives a link only when it knows an address teammates can open; otherwise the address this
  // client dialled is one the person reading the run's output can open.
  it('builds the watch link from the relay address when the relay gives none, and takes the relay\'s when it does', async () => {
    const relaySays: { watchUrl?: string } = {}
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [], ...relaySays }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    expect(await client.joinSession('s1')).toEqual({ watchUrl: `http://localhost:${port}/automation/sessions/s1` })
    relaySays.watchUrl = 'https://relay.example.test/automation/sessions/s2'
    expect(await client.joinSession('s2')).toEqual({ watchUrl: relaySays.watchUrl })
    client.disconnect()
  })

  async function typeErrorClient(reason?: unknown) {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
        if (msg['type'] === 'input:type') {
          const reply: Record<string, unknown> = {
            type: 'input:type-error', sessionId: msg['sessionId'], requestId: msg['requestId'], message: 'no input channel',
          }
          if (reason !== undefined) reply['reason'] = reason
          ws.send(JSON.stringify(reply))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    return client
  }

  const usable = (m: Record<string, unknown> | undefined, what: string) => {
    expect(m, `no ${what} was sent`).toBeDefined()
    expect(typeof m!['requestId']).toBe('string')
    expect(m!['requestId']).not.toBe('')
  }

  it('tap sends a terminal frame with a usable id, and an opening frame with none', async () => {
    const { client, received } = await capture()
    await client.tap('s1', 0.5, 0.5)

    usable(received.find((m) => m['type'] === 'input:touch:end'), 'input:touch:end')
    // And the opening frame carries none — nothing acks it, so an id there would name a waiter that does
    // not exist. Pinned so a later edit cannot quietly add one.
    expect(received.find((m) => m['type'] === 'input:touch:start')).not.toHaveProperty('requestId')
  })

  it('swipe sends a terminal frame with a usable id, and its moves with none', async () => {
    const { client, received } = await capture()
    await client.swipe('s1', [0.1, 0.1], [0.9, 0.9], 40)

    usable(received.find((m) => m['type'] === 'input:touch:end'), 'input:touch:end')
    const moves = received.filter((m) => m['type'] === 'input:touch:move')
    expect(moves.length).toBeGreaterThan(0)
    for (const m of moves) expect(m).not.toHaveProperty('requestId')
  })

  it('pressKey sends a usable id', async () => {
    const { client, received } = await capture()
    await client.pressKey('s1', 'Enter')

    usable(received.find((m) => m['type'] === 'input:key'), 'input:key')
  })

  it('pressButton sends the name with a usable id', async () => {
    const { client, received } = await capture()
    await client.pressButton('s1', 'volume_up')
    const sent = received.find((m) => m['type'] === 'input:button')
    usable(sent, 'input:button')
    expect(sent!['payload']).toEqual({ name: 'volume_up' })
  })

  // A long press is the app's timer seeing a pointer stay down, so there is nothing to move.
  it('longPress holds one point for the duration, with no moves, and acks on the end', async () => {
    const { client, received } = await capture()
    const at: Record<string, number> = {}
    const started = Date.now()
    await client.longPress('s1', 0.3, 0.7, 120)
    at['done'] = Date.now() - started
    const start = received.find((m) => m['type'] === 'input:touch:start')
    const end = received.find((m) => m['type'] === 'input:touch:end')
    expect(start).toMatchObject({ payload: { x: 0.3, y: 0.7 } })
    expect(start).not.toHaveProperty('requestId')
    usable(end, 'input:touch:end')
    expect(end).toMatchObject({ payload: { x: 0.3, y: 0.7 } })
    expect(received.some((m) => m['type'] === 'input:touch:move')).toBe(false)
    expect(at['done']).toBeGreaterThanOrEqual(115)
  })

  // Android's adb path replays the hold after the end arrives, so the ack comes that much later than a tap's.
  it('longPress waits for its ack a hold longer than a tap does', async () => {
    const { client } = await capture()
    const timeouts: number[] = []
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      timeouts.push(ms ?? 0)
      return real(fn, ms)
    }) as typeof setTimeout)
    try {
      await client.tap('s1', 0.5, 0.5)
      await client.longPress('s1', 0.5, 0.5, 40)
    } finally {
      spy.mockRestore()
    }
    const tapWait = Math.max(...timeouts.slice(0, timeouts.indexOf(40)))
    expect(timeouts).toContain(tapWait + 40)
  })

  // A swipe that stays put is replayed as a long press there too, as long as the swipe lasted.
  it('swipe waits for its ack its own duration longer than a tap does', async () => {
    const { client } = await capture()
    const timeouts: number[] = []
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      timeouts.push(ms ?? 0)
      return real(fn, ms)
    }) as typeof setTimeout)
    try {
      await client.swipe('s1', [0.5, 0.5], [0.5, 0.5], 80)
    } finally {
      spy.mockRestore()
    }
    expect(timeouts).toContain(10_000 + 80)
  })

  // Both agents inject a move the moment it arrives, so a pinch sent at once is a jump. `pinch:end` carries no
  // position, so the last move has to be the end.
  it('pinch paces its moves over the duration, ends on the end position, and acks on pinch:end', async () => {
    const { client, received } = await capture()
    const stamps: number[] = []
    const started = Date.now()
    const done = client.pinch('s1', [[0.4, 0.5], [0.6, 0.5]], [[0.2, 0.5], [0.8, 0.5]], 160)
    const watch = setInterval(() => { stamps.push(received.filter((m) => m['type'] === 'input:pinch:move').length) }, 10)
    await done
    clearInterval(watch)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    const start = received.find((m) => m['type'] === 'input:pinch:start')
    expect(start).toEqual({ type: 'input:pinch:start', sessionId: 's1', payload: { f0: { x: 0.4, y: 0.5 }, f1: { x: 0.6, y: 0.5 } } })
    const moves = received.filter((m) => m['type'] === 'input:pinch:move')
    expect(moves).toHaveLength(8)
    for (const m of moves) expect(m).not.toHaveProperty('requestId')
    const last = moves.at(-1)!['payload'] as { f0: { x: number }; f1: { x: number } }
    expect(last.f0.x).toBeCloseTo(0.2, 9)
    expect(last.f1.x).toBeCloseTo(0.8, 9)
    usable(received.find((m) => m['type'] === 'input:pinch:end'), 'input:pinch:end')
    // Spread out rather than sent together: some sample saw a move count strictly between none and all.
    expect(stamps.some((n) => n > 0 && n < 8)).toBe(true)
  })

  // Nothing on the relay or the agent lifts a pointer its client left down, and a cancel lands inside a long press.
  it.each([
    ['longPress', (c: RelayClient) => c.longPress('s1', 0.3, 0.7, 2000), 'input:touch:end'],
    ['pinch', (c: RelayClient) => c.pinch('s1', [[0.4, 0.5], [0.6, 0.5]], [[0.2, 0.5], [0.8, 0.5]], 2000), 'input:pinch:end'],
    ['swipe', (c: RelayClient) => c.swipe('s1', [0.1, 0.1], [0.9, 0.9], 2000), 'input:touch:end'],
  ] as const)('leaving mid-%s ends the gesture before the leave, and sends nothing after it', async (_, gesture, end) => {
    const { client, received } = await capture()
    const running = gesture(client).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 300))
    client.leaveSession('s1')
    expect(await running).toBeInstanceOf(SessionLeftError)
    await new Promise((r) => setTimeout(r, 100))
    const types = received.map((m) => m['type'])
    const ends = types.filter((t) => t === end)
    expect(ends).toHaveLength(1)
    expect(types.indexOf(end)).toBeLessThan(types.indexOf('session:leave'))
    expect(types.slice(types.indexOf('session:leave') + 1)).toEqual([])
    if (end === 'input:touch:end') {
      expect(received.find((m) => m['type'] === end)).toHaveProperty('payload')
      // A touch is cancelled first, so an agent that knows the cancel has nothing left for the end (#1115).
      expect(types.filter((t) => t === 'input:touch:cancel')).toHaveLength(1)
      expect(types.indexOf('input:touch:cancel')).toBe(types.indexOf(end) - 1)
    } else expect(types).not.toContain('input:touch:cancel')
  })

  it('a gesture the leave ended does not touch one opened after a re-join', async () => {
    const { client, received } = await capture()
    const first = client.longPress('s1', 0.1, 0.1, 400).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 100))
    client.leaveSession('s1')
    await client.joinSession('s1')
    const second = client.longPress('s1', 0.9, 0.9, 600)
    expect(await first).toBeInstanceOf(SessionLeftError)
    await second
    const ends = received.filter((m) => m['type'] === 'input:touch:end').map((m) => m['payload'])
    // One end for the gesture the leave closed, one for the second gesture's own release, none sent by the first.
    expect(ends).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }])
  })

  it('a refused pinch names the reason', async () => {
    const { client } = await capture((m) => ({
      type: 'input:error', sessionId: m['sessionId'], requestId: m['requestId'], reason: 'unsupported', message: 'pinch is not available on this path',
    }))
    const err = await client.pinch('s1', [[0.4, 0.5], [0.6, 0.5]], [[0.2, 0.5], [0.8, 0.5]], 16).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputRefusedError)
    expect((err as InputRefusedError).reason).toBe('unsupported')
  })

  it('a refused input fails the step, naming the reason (#512)', async () => {
    // The whole point of awaiting the ack. Without it the tap is refused, nothing notices, and the next
    // `assertVisible` polls until its own deadline and fails with "selector not found" — an infrastructure
    // failure written into the report as a product failure, which for a test runner is the worst place to
    // lose a cause.
    const { client } = await capture((m) => ({
      type: 'input:error',
      sessionId: m['sessionId'],
      requestId: m['requestId'],
      reason: 'not-booted',
      message: 'device is not booted',
    }))
    await expect(client.tap('s1', 0.5, 0.5)).rejects.toThrow(/tap was refused by the device \(not-booted\): device is not booted/)
  })

  it('reads an ack with no reason as channel-unavailable, not as fine', async () => {
    // `reason` is required on the wire as of #491; what still omits it is an agent outside this repo predating that — and absence means
    // *unknown*. protocol/AGENTS.md makes the conservative reading the contract, and the failure still has
    // to name something rather than an empty parenthesis.
    const { client } = await capture((m) => ({
      type: 'input:error', sessionId: m['sessionId'], requestId: m['requestId'], message: 'no channel',
    }))
    await expect(client.pressKey('s1', 'Enter'))
      .rejects.toThrow(/pressKey Enter was refused by the device \(channel-unavailable\): no channel/)
  })

  // **The other half of the same rule, which the code did not have until CodeRabbit asked for it.** The
  // comment above the branch claimed absence *and a member this build does not know* both read as
  // `channel-unavailable`; the code tested `typeof === 'string'` and passed anything else through, so a
  // reason added to the union after this build shipped reached the step's message verbatim.
  it('reads a reason it does not know as channel-unavailable too', async () => {
    const { client } = await capture((m) => ({
      type: 'input:error', sessionId: m['sessionId'], requestId: m['requestId'],
      reason: 'invented-in-a-later-release', message: 'no channel',
    }))
    const err = await client.pressKey('s1', 'Enter').catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/\(channel-unavailable\)/)
    expect(err.message).not.toMatch(/invented-in-a-later-release/)
  })

  it('classifies type text refusals and preserves their reason', async () => {
    const client = await typeErrorClient('not-booted')
    const err = await client.typeText('s1', 'hello').catch((e: unknown) => e) as InputRefusedError
    expect(err).toBeInstanceOf(InputRefusedError)
    expect(err.reason).toBe('not-booted')
    expect(err.message).toContain('type text was refused by the device (not-booted)')
  })

  it('treats a missing type text reason as channel-unavailable', async () => {
    const client = await typeErrorClient()
    const err = await client.typeText('s1', 'hello').catch((e: unknown) => e) as InputRefusedError
    expect(err).toBeInstanceOf(InputRefusedError)
    expect(err.reason).toBe('channel-unavailable')
  })

  it('reports a lost relay as unconfirmed, and does not blame the agent for it', async () => {
    // `IOSAgent.ackInput` awaits an untimed `simctl list` on the first input after a boot, on the same Mac
    // the relay gates at 80% CPU — so an ack that never reaches this waiter can still belong to an input
    // that landed. "tap timed out" reads as *the tap did not happen*, which is the false certainty this
    // change removes, sign flipped.
    //
    // The step fails the same way a deadline would, but the **diagnosis** must not be the same: every
    // caller sends before awaiting, so the input has already left this process and the relay may have
    // forwarded it. A close says only that we stopped being able to hear — nothing about whether the
    // agent acks, and nothing about its version.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const { client } = await capture(() => null)
      const pending = client.tap('s1', 0.5, 0.5)
      for (const c of wss!.clients) c.terminate()
      const err = await pending.catch((e: unknown) => e) as Error
      expect(err.message).toContain('was not confirmed')
      expect(err.message).toContain('may have reached the device')
      expect(err.message).not.toContain('refused')
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('went unanswered'))).toHaveLength(0)
  })

  it('names the version-skew possibility when the deadline is what expired', async () => {
    // The half that *is* evidence about the agent: an agent predating input correlation acks with no
    // `requestId`, so its acks match nothing here and every input in the run burns the deadline. The
    // step's own failure says neither that nor "or it is slow", and this client cannot tell them apart,
    // so the log names both.
    //
    // Driven by the clock rather than ten real seconds. The socket stays up — only the timer `waitFor`
    // armed is advanced — so this exercises the deadline rather than a disconnect.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const { client } = await capture(() => null)
      vi.useFakeTimers()
      try {
        const timedOut = client.tap('s1', 0.5, 0.5).catch((e: unknown) => e as Error)
        // The literal, not an imported constant: exporting it would make this tautological, while a
        // number that stops matching fails here and the author has to look.
        await vi.advanceTimersByTimeAsync(10_000)
        expect((await timedOut as Error).message).toContain('was not confirmed')
      } finally { vi.useRealTimers() }
      expect(logged.filter((l) => l.includes('went unanswered'))).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('does not take another input\'s ack', async () => {
    // The correlator is the point, and it is why #499 exists: a gesture is dozens of frames and a late ack
    // from the previous input lands in this one's waiter. The stale reply is an **error** so resolving on it
    // is observable — two indistinguishable successes cannot fail this test.
    const { client } = await capture((m) => {
      const ws = [...wss!.clients][0]
      ws.send(JSON.stringify({
        type: 'input:error', sessionId: 's1', requestId: 'stale', reason: 'failed', message: 'a previous input',
      }))
      return { type: 'input:done', sessionId: m['sessionId'], requestId: m['requestId'] }
    })
    await expect(client.tap('s1', 0.5, 0.5)).resolves.toBeUndefined()
  })

  it('typeText correlates, so its waiter cannot take the previous typing\'s reply', async () => {
    // The one input sender here with a waiter. Dropping `requestId` from its predicate leaves #499 alive for
    // `input:type` specifically: a late `input:type-done` from the previous call lands in this one's waiter.
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
        if (msg['type'] === 'input:type') {
          // The stale reply is an **error** so that resolving on it is observable. A first version sent two
          // successes, which passed with the correlator check deleted — the mutation that removes the
          // property has to fail the test, and two indistinguishable successes cannot do that.
          ws.send(JSON.stringify({
            type: 'input:type-error', sessionId: 's1', requestId: 'stale', message: 'a previous call',
          }))
          setTimeout(() => ws.send(JSON.stringify({
            type: 'input:type-done', sessionId: 's1', requestId: msg['requestId'],
          })), 20)
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')

    await expect(client.typeText('s1', 'hi')).resolves.toBeUndefined()
    usable(received.find((m) => m['type'] === 'input:type'), 'input:type')
  })
})

describe('RelayClient.bootDevice — an optional correlator, with a fallback', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    // `close()` waits for every connection to go away, and the client keeps its socket open — so
    // without terminating them first this hook times out rather than the test failing, which reads as
    // five broken tests instead of one broken teardown.
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay that answers `device:boot` however the test asks it to, and records what it received. */
  /** `listener` is set before the join, as a recording run does: a join without one asks for no stream. */
  async function relay(reply: (msg: Record<string, unknown>) => Record<string, unknown> | null, listener?: Parameters<RelayClient['setStreamListener']>[0]) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
          return
        }
        if (msg['type'] !== 'device:boot') return
        const answer = reply(msg)
        if (answer) ws.send(JSON.stringify(answer))
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    if (listener) client.setStreamListener(listener)
    await client.joinSession('s1')
    return { client, received }
  }

  const pendingAfter = (p: Promise<unknown>, ms = 150) =>
    Promise.race([
      p.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-waiting'), ms)),
    ])

  it('mints a correlator on the boot it sends', async () => {
    const { client, received } = await relay((m) => ({
      type: 'device:ready', sessionId: 's1', requestId: m['requestId'], payload: { deviceId: 'dev-1' },
    }))
    await client.bootDevice('s1', 'dev-1')

    const boot = received.find((m) => m['type'] === 'device:boot')!
    expect(typeof boot['requestId']).toBe('string')
    expect(boot['requestId']).not.toBe('')
  })

  it('asks for H.264 only when told to, so a run without video boots as before', async () => {
    const ready = (m: Record<string, unknown>) => ({ type: 'device:ready', sessionId: 's1', requestId: m['requestId'], payload: { deviceId: 'dev-1' } })
    const { client, received } = await relay(ready)
    await client.bootDevice('s1', 'dev-1')
    await client.bootDevice('s1', 'dev-1', { acceptH264: true })
    const boots = received.filter((m) => m['type'] === 'device:boot').map((m) => m['payload'])
    expect(boots).toEqual([{ deviceId: 'dev-1' }, { deviceId: 'dev-1', acceptH264: true }])
  })

  it('sends a run reset only when asked, and returns what the ready said about it', async () => {
    const report = { done: ['keychain'], failed: ['location'] }
    const { client, received } = await relay((m) => ({
      type: 'device:ready', sessionId: 's1', requestId: m['requestId'],
      payload: { deviceId: 'dev-1', cold: false, ...((m['payload'] as Record<string, unknown>)['runReset'] ? { runReset: report } : {}) },
    }))
    expect(await client.bootDevice('s1', 'dev-1')).toEqual({ cold: false })
    expect(await client.bootDevice('s1', 'dev-1', { runReset: { uninstall: ['a'], clear: [] } })).toEqual({ cold: false, runReset: report })
    const boots = received.filter((m) => m['type'] === 'device:boot').map((m) => m['payload'])
    expect(boots).toEqual([{ deviceId: 'dev-1' }, { deviceId: 'dev-1', runReset: { uninstall: ['a'], clear: [] } }])
  })

  // A malformed report reads as no report: the run warns that the reset is unconfirmed rather than trusting it.
  it('reads a malformed reset report as absent', async () => {
    const { client } = await relay((m) => ({
      type: 'device:ready', sessionId: 's1', requestId: m['requestId'], payload: { deviceId: 'dev-1', runReset: { done: 'keychain', failed: [] } },
    }))
    expect(await client.bootDevice('s1', 'dev-1', { runReset: { uninstall: [], clear: [] } })).toEqual({})
  })

  it('hands the held stream\'s frames, chrome and device info to a listener, and nothing once it is removed', async () => {
    const frames: Buffer[] = []
    const events: [string, unknown][] = []
    const { client } = await relay(() => null, { frame: (d) => frames.push(d), event: (t, p) => events.push([t, p]) })
    const socket = [...wss!.clients][0]!
    const send = async () => {
      socket.send(Buffer.from('TFFE-frame'), { binary: true })
      socket.send(JSON.stringify({ type: 'session:chrome', sessionId: 's1', payload: { model: 'x' } }))
      socket.send(JSON.stringify({ type: 'session:deviceInfo', sessionId: 's1', payload: { deviceName: 'd', osVersion: '1' } }))
      await new Promise((r) => setTimeout(r, 50))
    }
    await send()
    expect(frames.map(String)).toEqual(['TFFE-frame'])
    expect(events).toEqual([['chrome', { model: 'x' }], ['deviceInfo', { deviceName: 'd', osVersion: '1' }]])
    client.setStreamListener(null)
    await send()
    expect(frames).toHaveLength(1)
    expect(events).toHaveLength(2)
  })

  it('keeps answering requests when the stream listener throws', async () => {
    const { client } = await relay(
      (m) => ({ type: 'device:ready', sessionId: 's1', requestId: m['requestId'], payload: { deviceId: 'dev-1' } }),
      { frame: () => { throw new Error('tap broke') }, event: () => { throw new Error('tap broke') } },
    )
    const socket = [...wss!.clients][0]!
    socket.send(Buffer.from('TFFE-frame'), { binary: true })
    socket.send(JSON.stringify({ type: 'session:chrome', sessionId: 's1', payload: {} }))
    await expect(client.bootDevice('s1', 'dev-1')).resolves.toEqual({})
  })

  it('reports the boot gate\'s refusal as an AdmissionRefusedError carrying its reason', async () => {
    const { client } = await relay((m) => ({
      type: 'device:boot-error', sessionId: 's1', requestId: m['requestId'], reason: 'host-booting', message: 'busy',
    }))
    const failure = client.bootDevice('s1', 'dev-1')
    await expect(failure).rejects.toBeInstanceOf(AdmissionRefusedError)
    await expect(failure).rejects.toMatchObject({ reason: 'host-booting' })
  })

  it('reports a boot error with no reason as a plain failure', async () => {
    const { client } = await relay((m) => ({ type: 'device:boot-error', sessionId: 's1', requestId: m['requestId'], message: 'boot failed' }))
    const failure = client.bootDevice('s1', 'dev-1')
    await expect(failure).rejects.toThrow('boot failed')
    await expect(failure).rejects.not.toBeInstanceOf(AdmissionRefusedError)
  })

  // Only the relay's admission gate puts a reason on a boot error, and it refuses only a busy Mac. A run built
  // before a newer relay added a reason must wait that one out too, not fail red on a Mac that is merely busy.
  it('waits out a refusal whose reason it does not know, keeping the reason in the message', async () => {
    const { client } = await relay((m) => ({ type: 'device:boot-error', sessionId: 's1', requestId: m['requestId'], reason: 'some-future-reason', message: 'busy' }))
    const failure = client.bootDevice('s1', 'dev-1')
    await expect(failure).rejects.toBeInstanceOf(AdmissionRefusedError)
    await expect(failure).rejects.toMatchObject({ reason: 'unrecognised-refusal', message: expect.stringContaining('some-future-reason') })
  })

  it('is not satisfied by a ready carrying another boot\'s correlator', async () => {
    const { client } = await relay(() => ({
      type: 'device:ready', sessionId: 's1', requestId: 'someone-elses', payload: { deviceId: 'dev-1' },
    }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('is satisfied by a ready with no correlator, so an agent predating the echo still boots', async () => {
    // Rejecting this would trade a misattribution for the full 120s deadline — and this waiter is the
    // only thing between a flow run and that deadline.
    const { client } = await relay(() => ({
      type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' },
    }))
    await expect(client.bootDevice('s1', 'dev-1')).resolves.toEqual({})
  })

  it('is not satisfied by the relay\'s replay, which carries no sessionId', async () => {
    // Staged as an answer to the boot rather than during the join, because in the ordinary sequence the
    // waiter does not exist yet when the replay goes out — so a test that only joins would pass with
    // the `sessionId` comparison deleted. That comparison, not the correlator, is what excludes this
    // frame: an optional field can make a match more precise, never make it fail.
    const { client } = await relay(() => ({ type: 'device:ready', payload: { deviceId: 'dev-1' } }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('waits through a boot-error raised for some other boot', async () => {
    // The mirror of the deadline defect: accepting a diagnosis that answers a different request fails a
    // boot still perfectly capable of succeeding.
    const { client } = await relay(() => ({
      type: 'device:boot-error', sessionId: 's1', requestId: 'not-mine', message: 'other',
    }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('fails on the boot-error that does answer it', async () => {
    const { client } = await relay((m) => ({
      type: 'device:boot-error', sessionId: 's1', requestId: m['requestId'], message: 'emulator gone',
    }))
    await expect(client.bootDevice('s1', 'dev-1')).rejects.toThrow('emulator gone')
  })
})


// L5d. `error` is the answer to a `session:start` the relay refused, and it carries the session it refuses.
// This file had **no `error` fixture at all** before, so removing the waiter's `sessionId === undefined`
// escape was untested in both directions — the review that found that is why these exist.
describe('RelayClient.joinSession — a refusal is addressed', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay that answers `session:start` with whatever the test returns — one frame, or several. */
  async function relay(
    reply: (msg: Record<string, unknown>) => Record<string, unknown> | Record<string, unknown>[],
  ) {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'session:start') return
        const out = reply(msg)
        for (const frame of Array.isArray(out) ? out : [out]) ws.send(JSON.stringify(frame))
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    return client
  }

  it('fails the join on a refusal that names its session', async () => {
    const client = await relay((m) => ({
      type: 'error', sessionId: m['sessionId'], message: 'Session busy', reason: 'session-busy',
    }))
    await expect(client.joinSession('s1')).rejects.toThrow('Session busy')
  })

  it('carries the machine reason, not just the prose (#512)', async () => {
    // `reason` is what #506 added the field for — the dashboard was branching on the prose, handled two of
    // three wordings, and dropped `Session busy` silently. This client was still reading the prose, so the
    // three outcomes were indistinguishable to a caller: retry works, nothing is ever coming, or the Mac is
    // over its ceiling.
    for (const reason of ['session-busy', 'session-not-found', 'agent-resources-exhausted'] as const) {
      const client = await relay((m) => ({ type: 'error', sessionId: m['sessionId'], message: 'refused', reason }))
      const err = await client.joinSession('s1').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SessionJoinError)
      expect((err as SessionJoinError).reason).toBe(reason)
      expect((err as Error).message).toContain(reason)
      const s = wss
      wss = null
      for (const c of s!.clients) c.terminate()
      await new Promise<void>((r) => s!.close(() => r()))
    }
  })

  it('reads a reason it does not know as unknown rather than passing it through', async () => {
    // The guard's member list lives in this package — `protocol`'s entry erases under `import type` — so a
    // string off the wire that is not a member must not be reported as if it were one. `Record<
    // SessionStartFailure, true>` is what makes falling behind a compile error rather than a silent widening.
    const client = await relay((m) => ({
      type: 'error', sessionId: m['sessionId'], message: 'refused', reason: 'a-reason-from-the-future',
    }))
    const err = await client.joinSession('s1').catch((e: unknown) => e) as SessionJoinError
    expect(err.reason).toBe('unknown')
  })

  it('does not take a refusal meant for another session', async () => {
    // The other half of #512's first finding: with the old `sessionId === undefined` escape this resolved,
    // and the caller was told a failure that belonged to a join it had not made.
    const client = await relay(() => ({
      type: 'error', sessionId: 'someone-else', message: 'Session busy', reason: 'session-busy',
    }))
    const settled = await Promise.race([
      client.joinSession('s1').then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
    ])
    expect(settled).toBe('still-waiting')
  })

  it('logs once when a refusal carries no address, and still times out', async () => {
    // A relay older than L5d. There is no version handshake anywhere, so this frame is the only signal that
    // the two sides disagree — and without the log the join simply times out with no stated reason, which is
    // #512's complaint arriving through a different door.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const client = await relay(() => ({ type: 'error', message: 'Session busy', reason: 'session-busy' }))
      const settled = await Promise.race([
        client.joinSession('s1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 200)),
      ])
      expect(settled).toBe('still-waiting')
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
  })

  it('logs the skew once even when the old relay refuses more than once', async () => {
    // The once-guard above was **free**: the harness answered a single `session:start`, so "once" and "every
    // time" produced the same one line and removing `!this.addressSkewLogged` passed all 70 tests. An old
    // relay refuses *every* join this way, and a client driving a flow of many steps would get a line per
    // refusal — the volume that buries the one message telling the operator what to fix. Two frames is the
    // smallest fixture where the guard is observable.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const client = await relay(() => [
        { type: 'error', message: 'Session busy', reason: 'session-busy' },
        { type: 'error', message: 'Session busy', reason: 'session-busy' },
      ])
      await Promise.race([
        client.joinSession('s1').catch(() => 'rejected'),
        new Promise((r) => setTimeout(r, 200)),
      ])
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
  })
})


// #512, finding 4. The relay reports a session's fate on three messages and sends them **without closing
// the socket**, so before this the `close` handler never ran, no waiter was settled, and a flow learned
// that its agent had died by burning a 120s install deadline.
//
// The shape of the fix is the part worth pinning, because it is the part a later reader would most
// plausibly "simplify": only `session:terminated` rejects anything. The other two are ambiguous about the
// request in flight — both agents reconnect **without restarting the process**, so a request that finishes
// after the reconnect still answers on the new socket — and rejecting on them would fail requests that
// succeed today. They are held as state and read at the deadline instead.
describe('RelayClient — session lifecycle (#512, finding 4)', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    // Two tests here spy on `console.error`, and the second one silences it. Without this the silence
    // outlives the test and any later assertion about what was logged would pass for the wrong reason.
    vi.restoreAllMocks()
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  async function harness(): Promise<{
    client: RelayClient
    push: (msg: Record<string, unknown>) => void
    settle: () => Promise<void>
    reply: (requestType: string, body: Record<string, unknown>, sessionId?: string) => Promise<void>
  }> {
    let conn: WebSocket | null = null
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      conn = ws
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        // Only `s1` is answered, so a join naming anything else runs to its deadline — which is how the
        // note-on-timeout path is observed without waiting out a 120s request.
        if (msg['type'] === 'session:start' && msg['sessionId'] === 's1') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')

    // Correlators are minted by the client, so a reply has to wait for the request and echo the id it
    // actually sent. Inventing one would only demonstrate that the waiter rejects invented ids — and
    // reading `received` synchronously does not work either, since the request reaches the server on its
    // own schedule. That was this harness's first shape and six tests timed out on it.
    const awaitRequest = (type: string, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const started = Date.now()
      const tick = setInterval(() => {
        const found = received
          .filter((m) => m['type'] === type && (sessionId === undefined || m['sessionId'] === sessionId))
          .at(-1)
        if (found) { clearInterval(tick); resolve(found) }
        else if (Date.now() - started > 2_000) { clearInterval(tick); reject(new Error(`no ${type} arrived`)) }
      }, 5)
    })

    const push = (msg: Record<string, unknown>) => conn!.send(JSON.stringify(msg))

    return {
      // Safe to call the moment a request method has been *called*: every one of them registers its waiter
      // synchronously before awaiting, so the waiter exists by the time the promise is handed back. That is
      // what lets a lifecycle message be pushed at a request that is genuinely in flight.
      push,
      // Waits until everything pushed so far has been **dispatched by the client**, for the tests that need
      // a lifecycle message to have landed *before* the request they are about. A round trip the client
      // completes itself, not a sleep: `agents:list` carries no session, so no lifecycle message can settle
      // its waiter, and same-socket frames are ordered — so once this resolves, everything pushed ahead of
      // it has been through `dispatch`. A 20ms sleep here would be a guess about scheduling.
      settle: async () => {
        const listing = client.listDevices()
        push({ type: 'agents:listed', sessions: [] })
        await listing
      },
      client,
      reply: async (requestType, body, sessionId) => {
        const req = await awaitRequest(requestType, sessionId)
        conn!.send(JSON.stringify({ sessionId: req['sessionId'], requestId: req['requestId'], ...body }))
      },
    }
  }

  const terminated = (sessionId: string) =>
    ({ type: 'session:terminated', sessionId, reason: 'agent-disconnected' })

  // Settles to 'resolved'/'rejected' when the promise does, or 'still-waiting' after a short
  // window — long enough for a socket round trip, orders shorter than any deadline under test, so
  // a waiter that survives is observably still pending rather than merely slow.
  const raceSettled = (p: Promise<unknown>, ms = 150): Promise<'resolved' | 'rejected' | 'still-waiting'> =>
    Promise.race([
      p.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'still-waiting'>((r) => setTimeout(() => r('still-waiting'), ms)),
    ])

  it('settles an in-flight install the moment the session is terminated, instead of at the 120s deadline', async () => {
    const { client, push } = await harness()
    const install = client.installApp('s1', 7)
    push(terminated('s1'))
    const err = await install.catch((e: unknown) => e) as SessionEndedError
    expect(err).toBeInstanceOf(SessionEndedError)
    expect(err.reason).toBe('agent-disconnected')
    // Names the operation and the session. `Waiter.what` exists only for this, so without asserting it the
    // whole field could be deleted with the suite green.
    expect(err.message).toMatch(/^app install failed:/)
    expect(err.message).toContain('s1')
  })

  // What the caller is allowed to conclude, and what it is not. The session being gone is a fact the relay
  // states; whether the request reached the device before the agent went is not knowable from here, and a
  // message that read as a clean failure would invite a repeat of a command that may already have run.
  it('separates what is certain from what is not', async () => {
    const { client, push } = await harness()
    const install = client.installApp('s1', 7)
    push(terminated('s1'))
    const err = await install.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/session is gone is certain/i)
    expect(err.message).toMatch(/whether the request reached the device is not/i)
    expect(err.message).toMatch(/do not repeat it blindly/i)
  })

  // The reason `Waiter` gained a `sessionId`. Matching on the predicate cannot do this — the predicates
  // match *replies*, so a lifecycle message satisfies none of them — and rejecting the whole array would
  // fail a request on a device that is perfectly healthy.
  it("leaves another session's waiter alone", async () => {
    const { client, push, reply } = await harness()
    const install = client.installApp('s1', 7)
    push(terminated('other-session'))
    await reply('app:install', { type: 'app:install-done' })
    await expect(install).resolves.toBeUndefined()
  })

  // `agents:list` carries no session on the wire, so no session ending can be about it.
  it('leaves a session-less waiter alone', async () => {
    const { client, push } = await harness()
    const listing = client.listDevices()
    push(terminated('s1'))
    push({ type: 'agents:listed', sessions: [] })
    await expect(listing).resolves.toEqual([])
  })

  // **The mutation guard for the non-boot half of the design.** Rejecting a non-boot request here is the
  // obvious-looking change and it is a regression: the agent reconnects without restarting, its reply
  // closure reads the socket at completion time, and a request that finishes after the reconnect lands
  // on the new socket and matches on `requestId`. The relay's 15s grace exists to keep exactly this
  // alive. Boots are answered by the relay rather than settled here — see the #885 block below.
  it('does NOT settle an in-flight request on rebound — the reply can still arrive', async () => {
    const { client, push, reply } = await harness()
    const install = client.installApp('s1', 7)
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await reply('app:install', { type: 'app:install-done' })
    await expect(install).resolves.toBeUndefined()
  })

  it('does NOT settle an in-flight request on agent-away — the relay is still holding the session', async () => {
    const { client, push, reply } = await harness()
    const install = client.installApp('s1', 7)
    push({ type: 'session:agent-away', sessionId: 's1' })
    await reply('app:install', { type: 'app:install-done' })
    await expect(install).resolves.toBeUndefined()
  })

  // A rebound session answers commands with `No booted device`, which is true and points nowhere: the
  // simulator is booted and the app is on screen. What the agent lost is its own binding, cleared by its
  // reconnect. Saying "the device reset" would send a runner at a reinstall it does not need.
  it('explains a later failure on a rebound session as a reconnect, not as a device reset', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'No booted device' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/No booted device/)
    expect(err.message).toMatch(/agent reconnected/i)
    expect(err.message).toMatch(/still running/i)
    expect(err.message).not.toMatch(/reset/i)
  })

  it('clears the away state when the agent comes back', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:agent-away', sessionId: 's1' })
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'No booted device' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err).toBeInstanceOf(SessionUnavailableError)
    expect(err.message).toMatch(/agent reconnected/i)
    expect(err.message).not.toMatch(/went away/i)
  })

  // A boot is the one thing that answers what a rebound cost the session, so it is the one thing that
  // clears the note. If anything else cleared it, the advice would go quiet while still being true.
  it('stops asking for a reboot once one has happened', async () => {
    const { client, push, settle, reply } = await harness()
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    // Without this the rebound may still be queued behind the boot request on its way out; the
    // settle puts the rebound first, so the boot below is unambiguously the recovery one.
    await settle()
    const boot = client.bootDevice('s1', 'dev-1')
    await reply('device:boot', { type: 'device:ready' })
    await boot

    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'nope' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toBe('nope')
  })

  // The frame that arrives with nothing pending is the one that has to be kept, because it is the *next*
  // request that would otherwise be unexplainable — so arriving early must not be an error either.
  it('takes all three with nothing pending', async () => {
    const { client, push } = await harness()
    push({ type: 'session:agent-away', sessionId: 's1' })
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    push(terminated('s1'))
    // Still alive and still dispatching: a reply on a session-less request resolves normally.
    const listing = client.listDevices()
    push({ type: 'agents:listed', sessions: [] })
    await expect(listing).resolves.toEqual([])
  })

  // `warnInputAckSilence` accuses the agent of predating input correlation or of being slow. Both are false
  // when the relay has said the agent is gone, and this is the one place an operator goes looking — the
  // same reason `RelayClosedError` was split out of the silence path in the first place.
  it('does not blame the agent for an unanswered input while the relay says it is away', async () => {
    const { client, push, settle } = await harness()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })

    push({ type: 'session:agent-away', sessionId: 's1' })
    await settle()
    const err = await client.tap('s1', 0.5, 0.5).catch((e: unknown) => e) as Error

    expect(err).toBeInstanceOf(InputUnconfirmedError)
    expect(err.message).toMatch(/not confirmed/i)
    expect(err.message).toMatch(/went away/i)
    expect(errors.join('\n')).not.toMatch(/predates input correlation/)

    // **And the narrowing is deliberate, so it is pinned in both directions.** The guard is `away`, not
    // "any lifecycle note": once the agent is back, an unanswered input is the agent's to explain again.
    // Widening it to `!this.sessionNote(...)` would leave the half above green and silently drop this.
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await settle()
    await client.tap('s1', 0.5, 0.5).catch((e: unknown) => e)
    expect(errors.join('\n')).toMatch(/predates input correlation/)
  }, 40_000)

  // The away clause has two possible sources — `waitFor`'s deadline message and the wrapper around it —
  // and a draft had both, so the sentence carried it twice. One source.
  it('says why once, not twice', async () => {
    const { client, push, settle } = await harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    push({ type: 'session:agent-away', sessionId: 's1' })
    await settle()
    const err = await client.tap('s1', 0.5, 0.5).catch((e: unknown) => e) as Error
    expect(err.message.match(/went away/g)).toHaveLength(1)
  }, 20_000)

  // `SessionTerminatedReason` has one member, so anything else means a relay newer than this client. The
  // comment on that branch says inventing `agent-disconnected` for a cause we cannot name is what `reason`
  // exists to stop — and with every test sending `agent-disconnected`, collapsing the ternary to that
  // constant was green. The sibling one `describe` up (`SessionJoinError`) already had this test.
  it('reads a reason it does not know as unknown rather than inventing one', async () => {
    const { client, push } = await harness()
    const install = client.installApp('s1', 7)
    push({ type: 'session:terminated', sessionId: 's1', reason: 'evicted-by-something-newer' })
    const err = await install.catch((e: unknown) => e) as SessionEndedError
    expect(err.reason).toBe('unknown')
    expect(err.message).not.toMatch(/agent-disconnected/)
  })

  // **A join is not a boot.** A draft deleted the whole lifecycle entry here, which undid `needsReboot`
  // silently — and a re-join is ordinary, so the reason for every later failure went with it.
  it('keeps the reboot note across a re-join', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await client.joinSession('s1')
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'No booted device' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/agent reconnected/i)
  })

  // The half of a re-join that *does* reset: a socket that dropped inside the hold window missed whichever
  // outcome arrived while it was gone, so it starts from "not away" and lets the relay restate it.
  it('starts a re-join from not-away', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:agent-away', sessionId: 's1' })
    await client.joinSession('s1')
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'nope' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toBe('nope')
  })

  // `needsReboot` is cleared only by a boot, so a flapping agent has it and `away` set at once. Only `away`
  // is current, and advising a boot there names something nothing can carry out.
  it('reports a live agent-away over a stale rebound', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:agent-away', sessionId: 's1' })
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    push({ type: 'session:agent-away', sessionId: 's1' })
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'nope' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/went away/i)
    expect(err.message).not.toMatch(/agent reconnected/i)
  })

  // The note decorates seven refusals, and only `app:launch-error` was covered — so six call sites could
  // be reverted to a bare error with the suite green. This is the one that matters most: a refused input
  // is what #512's third finding was about.
  it('explains a refused input on a rebound session too', async () => {
    const { client, push, reply } = await harness()
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    const tap = client.tap('s1', 0.5, 0.5)
    // `reply` waits for the terminal frame to arrive and echoes its correlator, so the refusal reaches a
    // waiter that is genuinely pending rather than landing on nothing.
    await reply('input:touch:end', { type: 'input:error', reason: 'not-booted', message: 'nope' })
    const err = await tap.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/refused by the device \(not-booted\)/)
    expect(err.message).toMatch(/agent reconnected/i)
  })

  // `sessionNote`'s three branches are ordered, and the terminated one sits on top. Nothing read it: the
  // rejection builds its own prose, so the branch was reachable only through a command issued *after* the
  // termination — which is exactly what a caller that missed the rejection does next.
  it('explains a command issued after the session ended', async () => {
    const { client, push, settle, reply } = await harness()
    push(terminated('s1'))
    await settle() // without this the launch waiter is in flight when the rejection fires, which is a different test
    const launch = client.launchApp('s1', 7)
    await reply('app:launch', { type: 'app:launch-error', message: 'Session not found' })
    const err = await launch.catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/Session not found/)
    expect(err.message).toMatch(/relay ended this session \(agent-disconnected\)/)
  })

  // The deadline is the moment the state was held for: a waiter shorter than the relay's 15s grace never
  // hears the outcome message, so the note is the only thing that can say why it gave up.
  it('carries the note on a deadline, not only on a refusal', async () => {
    const { client, push, settle } = await harness()
    push({ type: 'session:agent-away', sessionId: 's2' })
    await settle()
    // `s2` is never answered by the harness, so this join runs its full 5s.
    const err = await client.joinSession('s2').catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/session join timed out/)
    expect(err.message).toMatch(/went away/i)
  }, 15_000)

  // #885. A rebound settles nothing client-side: the relay answers the boots the rebind
  // stranded with a correlated `device:boot-error`, because it is the only layer that knows which
  // agent socket each boot went to. Settling here as well would fail a boot the new agent was
  // already handling. What the rebound still does is record `needsReboot`, so the relay's error
  // is classified with the cause attached.
  it('leaves a pending boot alone on rebound — the relay answers it', async () => {
    const { client, push, reply } = await harness()
    const boot = client.bootDevice('s1', 'dev-1')
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await expect(raceSettled(boot)).resolves.toBe('still-waiting')
    // The relay's answer to the stranded boot, correlated to this request:
    await reply('device:boot', {
      type: 'device:boot-error',
      message: 'session s1 rebounded to a new agent while this boot was in flight',
    }, 's1')
    const err = await boot.catch((e: unknown) => e) as SessionUnavailableError
    expect(err).toBeInstanceOf(SessionUnavailableError)
    // Not `SessionEndedError`: the session is alive, only its device binding is gone.
    expect(err).not.toBeInstanceOf(SessionEndedError)
    expect(err.message).toMatch(/rebounded/)
    expect(err.message).toContain('s1')
    expect(err.message).toContain('the agent reconnected and cleared its device binding')
  })

  // The rejection above would be worthless if the driver read it as product: the run would blame
  // the test and exit 1 for a relay event. This feeds the exact rejection through `RelayDriver`'s
  // guard — the path every engine step failure travels — and holds the exit-2 marking there instead
  // of trusting the class name.
  it('classifies a relay-settled stranded boot as environmental, not product', async () => {
    const { client, push, reply } = await harness()
    const boot = client.bootDevice('s1', 'dev-1')
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await reply('device:boot', {
      type: 'device:boot-error',
      message: 'session s1 rebounded to a new agent while this boot was in flight',
    }, 's1')
    const bootErr = await boot.catch((e: unknown) => e)
    const stub = { queryUITreeWithTurn: async (): Promise<never> => { throw bootErr } } as unknown as RelayClient
    const err = await new RelayDriver(stub, 's1').queryUITree().catch((e: unknown) => e)
    expect(err).toBe(bootErr) // the guard marks without replacing the object
    expect(isEnvironmentStepFailure(err)).toBe(true)
  })

  // A boot issued *after* the rebound is the recovery boot that restores the binding. The rebound
  // settles nothing here, so this one must survive it and still be answerable — and the stranded
  // boot it replaces is answered by the relay, not by this dispatch.
  it('answers a boot issued after the rebound normally — it is the recovery boot', async () => {
    const { client, push, reply } = await harness()
    const stale = client.bootDevice('s1', 'dev-1')
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    await expect(raceSettled(stale)).resolves.toBe('still-waiting')
    await reply('device:boot', {
      type: 'device:boot-error',
      message: 'session s1 rebounded to a new agent while this boot was in flight',
    }, 's1')
    await expect(stale).rejects.toBeInstanceOf(SessionUnavailableError)
    const recovery = client.bootDevice('s1', 'dev-1')
    await expect(raceSettled(recovery)).resolves.toBe('still-waiting')
    await reply('device:boot', { type: 'device:ready' }, 's1')
    await expect(recovery).resolves.toEqual({})
  })

  // `agent-away` is the relay's hold window, not an answer: the agent may come back on the same
  // binding, so even a boot keeps waiting through it.
  it('does not cancel a pending boot on agent-away — the grace may still answer it', async () => {
    const { client, push, reply } = await harness()
    const boot = client.bootDevice('s1', 'dev-1')
    push({ type: 'session:agent-away', sessionId: 's1' })
    await expect(raceSettled(boot)).resolves.toBe('still-waiting')
    await reply('device:boot', { type: 'device:ready' })
    await expect(boot).resolves.toEqual({})
  })

  it("leaves another session's boot waiter alone on rebound", async () => {
    const { client, push, reply } = await harness()
    const mine = client.bootDevice('s1', 'dev-1')
    const other = client.bootDevice('s2', 'dev-2')
    push({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    // Neither settles on the rebound itself; the other session's boot answers normally.
    await expect(raceSettled(mine)).resolves.toBe('still-waiting')
    await reply('device:boot', { type: 'device:ready' }, 's2')
    await expect(other).resolves.toEqual({})
    // And this session's stranded boot is answered by the relay, with the cause attached.
    await reply('device:boot', {
      type: 'device:boot-error',
      message: 'session s1 rebounded to a new agent while this boot was in flight',
    }, 's1')
    const err = await mine.catch((e: unknown) => e) as SessionUnavailableError
    expect(err).toBeInstanceOf(SessionUnavailableError)
    expect(err.message).toContain('the agent reconnected and cleared its device binding')
  })
})

describe('RelayClient — the socket identifies its client to the relay (#527, #579)', () => {
  let wss: WebSocketServer | null = null
  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  // The twin of `mcp-server`'s, and here for the same reason: the ownership change touched this file and
  // no test in this package, so removing the parameter would be silent.
  it('sends a stable client id on the handshake, and the same one after a reconnect', async () => {
    const seen: string[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (_ws, req) => {
      seen.push(new URL(req.url ?? '/', 'http://x').searchParams.get('client') ?? '')
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.connect()
    client.disconnect()

    expect(seen).toHaveLength(2)
    expect(seen[0], 'no client id was sent').not.toBe('')
    expect(seen[1], 'a reconnect introduced itself as a different client').toBe(seen[0])
  })
})

describe('RelayClient — leaving a session settles what was waiting on it (#514)', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay that answers a join and then says nothing, so every request runs to its deadline unless
   *  something else settles it. The deadline here is 120s, which is exactly why nothing may wait for it. */
  async function silent(): Promise<{ client: RelayClient; ack: (m: Record<string, unknown>) => void }> {
    let conn: WebSocket | null = null
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      conn = ws
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    await client.joinSession('s2')
    return { client, ack: (m) => conn?.send(JSON.stringify(m)) }
  }

  it('rejects a request that was in flight, instead of leaving it on its deadline', async () => {
    const { client } = await silent()
    const boot = client.bootDevice('s1', 'dev-1').catch((e: unknown) => e)
    // Give the send a tick so the waiter is registered before the leave.
    await new Promise((r) => setTimeout(r, 10))
    client.leaveSession('s1')
    const err = await boot
    expect(err).toBeInstanceOf(SessionLeftError)
  })

  it('names the caller as the cause, not the relay', async () => {
    const { client } = await silent()
    const boot = client.bootDevice('s1', 'dev-1').catch((e: unknown) => e) as Promise<Error>
    await new Promise((r) => setTimeout(r, 10))
    client.leaveSession('s1')
    const err = await boot
    // Not `SessionEndedError`: nobody terminated anything. The two want different next moves, and this
    // one is the caller's own doing.
    expect(err).not.toBeInstanceOf(SessionEndedError)
    expect(err.message).toMatch(/left session s1/)
    // And it names the request, which is what `settleSessionWaiters` taking the waiter is for — a version
    // taking only the session id would have dropped this from the terminate path too.
    expect(err.message).toMatch(/^device boot failed:/)
  })

  it('leaves another session\'s waiters alone', async () => {
    const { client } = await silent()
    const a = client.bootDevice('s1', 'dev-1').catch(() => 'rejected')
    const b = client.bootDevice('s2', 'dev-2').catch(() => 'rejected')
    await new Promise((r) => setTimeout(r, 10))
    client.leaveSession('s1')
    expect(await a).toBe('rejected')
    // `s2` must still be pending — a leave that emptied the array would settle it too, and nothing else
    // in this suite would say so.
    const outcome = await Promise.race([b, new Promise((r) => setTimeout(() => r('pending'), 60))])
    expect(outcome).toBe('pending')
  })

  it('a reply arriving for the same session after the leave settles nothing', async () => {
    // The defect #514 measured: re-joining reproduces the same `sessionId`, so a reply for the *new* join
    // could satisfy a predicate registered before the leave. With the waiter gone there is nothing to satisfy.
    const { client, ack } = await silent()
    const boot = client.bootDevice('s1', 'dev-1').catch((e: unknown) => e) as Promise<Error>
    await new Promise((r) => setTimeout(r, 10))
    client.leaveSession('s1')
    await boot

    // **Asserted on the waiter list, not on the promise.** A first version awaited the boot and then
    // re-asserted it after the late reply, which cannot fail: a settled promise is settled, so a waiter
    // left in the array would `resolve` it to no observable effect and the test stayed green against the
    // very defect it names. Deleting the `splice` and keeping the `reject` passed it.
    const waiters = (client as unknown as { waiters: unknown[] }).waiters
    expect(waiters, 'the leave left a waiter behind for a session it left').toHaveLength(0)

    // And the late reply lands on nothing. This is the frame #514 measured — re-joining reuses the id, so
    // the relay's replayed session state could satisfy a predicate registered before the leave.
    ack({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } })
    await new Promise((r) => setTimeout(r, 30))
    expect(waiters).toHaveLength(0)
  })

  it('keeps the "may have reached the device" warning on an input killed by the leave', async () => {
    // The safety half. `awaitInputAck` branches on class, so an error class it does not know falls
    // through to a wrapper — or past every branch — and the warning never runs. A model told only that it
    // left the session will repeat the tap.
    const { client } = await silent()
    const tap = client.tap('s1', 0.5, 0.5).catch((e: unknown) => e) as Promise<Error>
    await new Promise((r) => setTimeout(r, 10))
    client.leaveSession('s1')
    const err = await tap
    expect(err.message).toMatch(/reached the device is unknown/)
    expect(err.message).toMatch(/do not repeat/)
    // **And the class survives**, which is the half the wording cannot show. Without the guard this is
    // wrapped in a bare `PlatformError`: the message would still read correctly — the wrapper adds its own
    // copy of the same warning — while a caller lost every way to tell a leave from anything else.
    expect(err).toBeInstanceOf(SessionLeftError)
  })

  it('a leave that cannot be sent settles nothing, so the close handler still owns those waiters', async () => {
    // **The class is the assertion.** A first version caught to a string, which erased it — with the settle
    // moved ahead of the send, the waiter rejects with `SessionLeftError`, `send` still throws, and both
    // of that version's assertions still passed. `disconnect()` nulls the socket synchronously while the
    // `close` event is still queued, so at this instant the waiter is very much still there, and the
    // truthful diagnosis for a socket that died is the close handler's, not a leave's.
    const { client } = await silent()
    const boot = client.bootDevice('s1', 'dev-1').catch((e: unknown) => e) as Promise<Error>
    await new Promise((r) => setTimeout(r, 10))
    client.disconnect()
    expect(() => client.leaveSession('s1')).toThrow(/not connected/i)
    expect(await boot).not.toBeInstanceOf(SessionLeftError)
  })
})

describe('RelayClient.queryUITree — the session record decides retryability (#545, #573)', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A client that has joined `s1` and been told `msg` about it. */
  async function told(msg: Record<string, unknown> | null): Promise<RelayClient> {
    let conn: WebSocket | null = null
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      conn = ws
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>
        if (m['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: m['sessionId'], capabilities: [] }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    if (msg) { conn!.send(JSON.stringify(msg)); await new Promise((r) => setTimeout(r, 20)) }
    return client
  }

  it('a terminated session fails now, and says why', async () => {
    // The relay removes the session as it sends this, so the next poll gets 404 `Session not found` —
    // already permanent. What changes is the *cause*: the symptom named a missing session, not a session
    // that ended a moment ago for a reason this client was told.
    const c = await told({ type: 'session:terminated', sessionId: 's1', reason: 'agent-disconnected' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, { error: 'Session not found' }))
    const err = await c.queryUITree('s1').catch((e: unknown) => e) as Error
    expect(err).not.toBeInstanceOf(TransientQueryError)
    expect(err.message).toMatch(/the relay ended this session \(agent-disconnected\)/)
  })

  it('a rebound session fails now, and blames the binding rather than the selector', async () => {
    // #573. `session:rebound` clears the agent's device binding and only a boot restores it — the CLI
    // boots once before `runFlow` and the engine has no boot step, so every remaining poll returns 504.
    // 504 is not in the permanent set, so each remaining step used to burn its whole timeout and fail as
    // `no element matched`, naming the selector.
    const c = await told({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(504, { error: 'ui-tree query timed out' }))
    const err = await c.queryUITree('s1').catch((e: unknown) => e) as Error
    expect(err).not.toBeInstanceOf(TransientQueryError)
    expect(err.message).toMatch(/needs booting again/)
  })

  it('a flapping agent is reported by the binding, not by the away-ness', async () => {
    // `away` and `needsReboot` can both be set at once — away, back, away again — because only a boot
    // clears the second and nothing in a flow boots. `sessionNote` ranks `away` first, deliberately: for a
    // caller that can still act, the away-ness is what is current. Here the caller cannot act, the step is
    // being failed permanently, and taking that precedence would print the sentence for a transient
    // condition on a permanent failure and never mention the binding — #573's mis-blame, one layer up.
    let conn: WebSocket | null = null
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      conn = ws
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>
        if (m['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: m['sessionId'], capabilities: [] }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const c = new RelayClient(`ws://localhost:${port}`, '')
    await c.connect()
    await c.joinSession('s1')
    for (const m of [
      { type: 'session:agent-away', sessionId: 's1' },
      { type: 'session:rebound', sessionId: 's1', capabilities: [] },
      { type: 'session:agent-away', sessionId: 's1' },
    ]) { conn!.send(JSON.stringify(m)); await new Promise((r) => setTimeout(r, 20)) }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, { error: 'Agent offline' }))
    const err = await c.queryUITree('s1').catch((e: unknown) => e) as Error
    expect(err).not.toBeInstanceOf(TransientQueryError)
    expect(err.message).toMatch(/needs booting again/)
    expect(err.message).not.toMatch(/went away/)
  })

  it('an away session keeps polling — that is what the retry is for', async () => {
    // The relay's 15s hold. Cutting here would kill a session a `session:rebound` was about to restore,
    // which is the opposite defect and the one this rule must not cause.
    const c = await told({ type: 'session:agent-away', sessionId: 's1' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, { error: 'Agent offline' }))
    await expect(c.queryUITree('s1')).rejects.toBeInstanceOf(TransientQueryError)
  })

  it('a session with no record is classified by status, exactly as before', async () => {
    const c = await told(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, { error: 'Agent offline' }))
    await expect(c.queryUITree('s1')).rejects.toBeInstanceOf(TransientQueryError)
  })

  it('a permanent status on a session with no record still fails now', async () => {
    const c = await told(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, { error: 'Device is not booted' }))
    const err = await c.queryUITree('s1').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(TransientQueryError)
  })

  it('a successful query is untouched by any record', async () => {
    const c = await told({ type: 'session:rebound', sessionId: 's1', capabilities: [] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { elements: [] }))
    await expect(c.queryUITree('s1')).resolves.toEqual([])
  })
})

// Typed environment failures (#543): the same messages as before, carrying the
// machine reason so the engine can classify without branching on prose.
describe('RelayClient — typed environment failures', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  async function rigged(ack: (m: Record<string, unknown>) => Record<string, unknown> | null) {
    let conn: WebSocket | null = null
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      conn = ws
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>
        if (m['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: m['sessionId'], capabilities: [] }))
        }
        if (m['type'] === 'input:touch:end' || m['type'] === 'input:key') {
          const reply = ack(m)
          if (reply) ws.send(JSON.stringify(reply))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    return {
      client,
      push: async (msg: Record<string, unknown>) => {
        conn!.send(JSON.stringify(msg))
        await new Promise((r) => setTimeout(r, 20))
      },
    }
  }

  const refusal = (reason: string) => (m: Record<string, unknown>) => ({
    type: 'input:error',
    sessionId: m['sessionId'],
    requestId: m['requestId'],
    reason,
    message: 'device is not booted',
  })

  it('a refused input throws InputRefusedError with the reason, message unchanged', async () => {
    const { client } = await rigged(refusal('not-booted'))
    const err = await client.tap('s1', 0.5, 0.5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputRefusedError)
    expect((err as InputRefusedError).reason).toBe('not-booted')
    expect((err as Error).message).toMatch(/tap was refused by the device \(not-booted\): device is not booted/)
  })

  it('a product refusal stays typed with its own reason', async () => {
    const { client } = await rigged(refusal('malformed'))
    const err = await client.tap('s1', 0.5, 0.5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InputRefusedError)
    expect((err as InputRefusedError).reason).toBe('malformed')
  })

  it('a terminated ui-tree query throws SessionUnavailableError naming the ending', async () => {
    const { client, push } = await rigged(() => null)
    await push({ type: 'session:terminated', sessionId: 's1', reason: 'agent-disconnected' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, { error: 'Session not found' }))
    const err = await client.queryUITree('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionUnavailableError)
    expect((err as Error).message).toMatch(/the relay ended this session \(agent-disconnected\)/)
    expect((err as Error).cause).toBeInstanceOf(Error)
  })
})

// A relay that refuses a token accepts the upgrade and closes 1008 with a reason right after, so
// `connect()` resolves and the first request fails. Both ways it can fail name the relay's code and
// reason; otherwise a token without `view` reads as "not connected to relay" with nothing to act on.
//
// Mutations: `closeDetail()` dropped from the "not connected" error → the first case; dropped from
// `RelayClosedError` → the second.
describe('RelayClient — a relay close carries its code and reason', () => {
  let wss: WebSocketServer | null = null
  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  it('closed right after open, then a join → the error names 1008 and the reason', async () => {
    const server = new WebSocketServer({ port: 0 })
    wss = server
    const serverSideClosed = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.once('close', () => resolve())
        ws.close(1008, 'Forbidden: this token lacks the view scope')
      })
    })
    const port = (server.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, 'tflw_pat_x')
    await client.connect()
    await serverSideClosed
    // The server's close event can land before the client's; wait until the client has handled its own
    // close (its handler lets go of the socket), so this case is the "not connected" path and not the
    // CLOSING one below. A condition, not a fixed delay: a slow runner would otherwise take the CLOSING
    // path and pass for the wrong reason.
    await vi.waitFor(() => {
      expect((client as unknown as { ws: WebSocket | null }).ws).toBeNull()
    })
    const err = await client.joinSession('s1').catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/not connected/)
    expect(err.message).toContain('1008')
    expect(err.message).toContain('lacks the view scope')
  })

  // The sequence `tapflow flow run` actually has: the join goes out while the socket is still closing.
  // Mutation: `sendFirstRequest` throwing while CLOSING (plain `send`) turns this red intermittently —
  // it is how the gap was found — and the case above covers the CLOSED path deterministically.
  it('refused at once and joined at once → the error still names 1008 and the reason', async () => {
    const server = new WebSocketServer({ port: 0 })
    wss = server
    server.on('connection', (ws) => ws.close(1008, 'Forbidden: this token lacks the view scope'))
    const port = (server.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, 'tflw_pat_x')
    await client.connect()
    const err = await client.joinSession('s1').catch((e: unknown) => e) as Error
    expect(err.message).toContain('1008')
    expect(err.message).toContain('lacks the view scope')
  })

  it('closed while a join is pending → RelayClosedError names 1008 and the reason', async () => {
    const server = new WebSocketServer({ port: 0 })
    wss = server
    server.on('connection', (ws) => {
      ws.on('message', () => ws.close(1008, 'Unauthorized: X'))
    })
    const port = (server.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, 'tflw_pat_x')
    await client.connect()
    const err = await client.joinSession('s1').catch((e: unknown) => e) as Error
    expect(err).toBeInstanceOf(RelayClosedError)
    expect(err.message).toContain('1008')
    expect(err.message).toContain('Unauthorized: X')
  })

  it('a close this client asked for is not reported as the relay\'s', async () => {
    const server = new WebSocketServer({ port: 0 })
    wss = server
    const serverSideClosed = new Promise<void>((resolve) => server.on('connection', (ws) => ws.once('close', () => resolve())))
    const port = (server.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    client.disconnect()
    // After the close has landed on both ends, so recording it regardless of who asked would show here.
    await serverSideClosed
    await new Promise((r) => setTimeout(r, 20))
    const err = await client.joinSession('s1').catch((e: unknown) => e) as Error
    expect(err.message).toBe('not connected to relay')
  })
})

describe('RelayClient.lease', () => {
  let wss: WebSocketServer | null = null
  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay answering each lease with `answer`'s frames, **all sent in the same tick**, as the real relay sends the
   *  lease, the join and an early boot refusal: they reach the client in one read. */
  async function relay(answer: (lease: Record<string, unknown>) => Record<string, unknown>[], opts: { clientId?: string; features?: string[] } = {}) {
    const received: Record<string, unknown>[] = []
    const urls: string[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws, req) => {
      urls.push(req.url ?? '')
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'agents:list') ws.send(JSON.stringify({ type: 'agents:listed', sessions: [], ...(opts.features ? { features: opts.features } : {}) }))
        if (msg['type'] === 'device:lease') for (const f of answer(msg)) ws.send(JSON.stringify(f))
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '', opts.clientId ? { clientId: opts.clientId } : {})
    await client.connect()
    return { client, received, urls }
  }

  const leasedThen = (m: Record<string, unknown>, ...rest: Record<string, unknown>[]) => [
    { type: 'device:leased', requestId: m['requestId'], sessionId: 's9', deviceId: 'dev-9', deviceName: 'iPhone 9', platform: 'ios', source: 'pool' },
    ...rest,
  ]

  it('takes the join and the boot that arrive in the same read as the lease', async () => {
    const { client, received } = await relay((m) => leasedThen(m,
      { type: 'session:joined', sessionId: 's9', capabilities: [], watchUrl: 'http://relay/watch/s9' },
      { type: 'device:ready', sessionId: 's9', requestId: m['requestId'], payload: { deviceId: 'dev-9', cold: false, runReset: { done: ['keychain'], failed: [] } } },
    ))
    const got = await client.lease({ platform: 'ios', buildId: 4, runReset: { uninstall: ['a'], clear: [] }, exclude: ['s1'] })
    expect(got).toEqual({
      sessionId: 's9', deviceId: 'dev-9', deviceName: 'iPhone 9', platform: 'ios', source: 'pool',
      watchUrl: 'http://relay/watch/s9', boot: { cold: false, runReset: { done: ['keychain'], failed: [] } },
    })
    expect(received.find((m) => m['type'] === 'device:lease')!['payload']).toEqual({
      platform: 'ios', buildId: 4, runReset: { uninstall: ['a'], clear: [] }, exclude: ['s1'], stream: false,
    })
  })

  it('waits out a busy Mac and every device in use, as a refused boot is', async () => {
    for (const reason of ['host-booting', 'host-at-capacity', 'agent-resources-exhausted', 'all-held'] as const) {
      const { client } = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason, message: 'no', retryable: true }])
      const err = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AdmissionRefusedError)
      expect((err as AdmissionRefusedError).reason).toBe(reason)
      client.disconnect()
      for (const c of wss!.clients) c.terminate()
      await new Promise<void>((r) => wss!.close(() => r()))
      wss = null
    }
  })

  it('fails at once on a lease waiting cannot help', async () => {
    const { client } = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason: 'no-device', message: 'no android device', retryable: false }])
    const err = await client.lease({ platform: 'android' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LeaseRefusedError)
    expect((err as LeaseRefusedError).reason).toBe('no-device')
  })

  it('reports a boot the gate refused after the lease as a refusal to wait out, and leaves the session', async () => {
    const { client, received } = await relay((m) => leasedThen(m,
      { type: 'session:joined', sessionId: 's9', capabilities: [] },
      { type: 'device:boot-error', sessionId: 's9', requestId: m['requestId'], reason: 'host-booting', message: 'busy' },
    ))
    const err = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdmissionRefusedError)
    // The caller has no session id to leave with, so the lease leaves it: a retry must not find it still held.
    await vi.waitFor(() => expect(received.filter((m) => m['type'] === 'session:leave')).toEqual([{ type: 'session:leave', sessionId: 's9' }]))
  })

  // A real boot failure carries no reason. The lease has left the session; the caller is told which it was, so a run
  // sharing devices can keep it out of its later leases.
  it('says which session a lease failed on after it was chosen, and nothing for one refused before', async () => {
    const { client } = await relay((m) => leasedThen(m,
      { type: 'session:joined', sessionId: 's9', capabilities: [] },
      { type: 'device:boot-error', sessionId: 's9', requestId: m['requestId'], message: 'simulator failed to boot' },
    ))
    const err = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('simulator failed to boot')
    expect(leasedSessionOf(err)).toBe('s9')
    client.disconnect()
    for (const c of wss!.clients) c.terminate()
    await new Promise<void>((r) => wss!.close(() => r()))
    wss = null

    const refused = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason: 'no-device', message: 'no', retryable: false }])
    expect(leasedSessionOf(await refused.client.lease({ platform: 'ios' }).catch((e: unknown) => e))).toBeUndefined()
  })

  it('fails with the join\'s refusal, leaving the session and no boot waiter behind', async () => {
    const { client, received } = await relay((m) => leasedThen(m, { type: 'error', sessionId: 's9', reason: 'agent-resources-exhausted', message: 'busy' }))
    const err = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionJoinError)
    expect((client as unknown as { waiters: unknown[] }).waiters).toEqual([])
    await vi.waitFor(() => expect(received.some((m) => m['type'] === 'session:leave')).toBe(true))
  })

  it('leaves no session behind when the lease itself is refused', async () => {
    const { client, received } = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason: 'all-held', message: 'no', retryable: true }])
    await client.lease({ platform: 'ios' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(received.some((m) => m['type'] === 'session:leave')).toBe(false)
  })

  // What a relay newer than this client may say: a reason it does not know is waited out when the relay says
  // waiting helps, and fails the run when it says it does not.
  it('reads a refusal it does not know by what the relay says about waiting', async () => {
    const { client } = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason: 'host-on-fire', message: 'no', retryable: true }])
    const waits = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
    expect(waits).toBeInstanceOf(AdmissionRefusedError)
    expect((waits as AdmissionRefusedError).reason).toBe('unrecognised-refusal')
  })

  it('fails on a refusal it does not know that the relay says waiting cannot help', async () => {
    const { client } = await relay((m) => [{ type: 'device:lease-refused', requestId: m['requestId'], reason: 'host-on-fire', message: 'no', retryable: false }])
    const fails = await client.lease({ platform: 'ios' }).catch((e: unknown) => e)
    expect(fails).toBeInstanceOf(LeaseRefusedError)
    expect((fails as LeaseRefusedError).reason).toBe('unrecognised')
  })

  it('reads that the relay leases from its listing', async () => {
    expect(await (await relay(() => [], { features: ['device-lease'] })).client.canLease()).toBe(true)
  })

  it('reads a listing with no features as a relay that does not lease', async () => {
    expect(await (await relay(() => [])).client.canLease()).toBe(false)
  })

  it('identifies as the client id it is given, so sibling clients are one holder', async () => {
    const { client, urls } = await relay(() => [], { clientId: 'run-7' })
    expect(client.clientId).toBe('run-7')
    expect(urls[0]).toContain('client=run-7')
  })
})

// #1047. Two places can drop launch options without a word: an older relay's validator strips them, and an older
// agent behind a newer relay ignores them. Both still answer done, so the client checks before and after.
describe('RelayClient launch options', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  async function relay(opts: { features?: string[]; applied?: boolean | unknown; refuse?: Record<string, unknown> }) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'agents:list') ws.send(JSON.stringify({ type: 'agents:listed', sessions: [], ...(opts.features ? { features: opts.features } : {}) }))
        if (msg['type'] === 'app:launch' && opts.refuse) {
          ws.send(JSON.stringify({ type: 'app:launch-error', sessionId: msg['sessionId'], requestId: msg['requestId'], ...opts.refuse }))
        } else if (msg['type'] === 'app:launch') {
          const applied = opts.applied === true ? { applied: { arguments: Object.keys((msg['arguments'] as object) ?? {}), env: [] } }
            : opts.applied ? { applied: opts.applied } : {}
          ws.send(JSON.stringify({ type: 'app:launch-done', sessionId: msg['sessionId'], requestId: msg['requestId'], ...applied }))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    return { client, received }
  }

  it('sends the options to a relay that carries them, and accepts the applied keys', async () => {
    const { client, received } = await relay({ features: ['launch-options'], applied: true })
    expect(await client.launchApp('s1', 7, { arguments: { flag: true } })).toEqual({ arguments: ['flag'], env: [] })
    expect(received.find((m) => m['type'] === 'app:launch')).toMatchObject({ buildId: 7, arguments: { flag: true } })
  })

  // The relay's per-app defaults reach a plain launch too, and their names are what the run record shows.
  // The engine reads both lists after the app is up; a malformed reply would throw there and count as the app failing.
  it.each([[{ arguments: ['a'] }], [{ arguments: 'a', env: [] }], [{ arguments: [1], env: [] }]])('fails as environment on a malformed applied %j', async (malformed) => {
    const { client } = await relay({ features: ['launch-options'], applied: malformed })
    const err = await client.launchApp('s1', 7).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/malformed list of applied options/)
    expect(isEnvironmentStepFailure(err)).toBe(true)
  })

  it('returns the applied keys of a launch that sent none', async () => {
    const { client } = await relay({ features: ['launch-options'], applied: true })
    expect(await client.launchApp('s1', 7)).toEqual({ arguments: [], env: [] })
  })

  it('refuses before sending when the relay does not carry them', async () => {
    const { client, received } = await relay({ features: ['device-lease'] })
    const err = await client.launchApp('s1', 7, { arguments: { flag: true } }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/relay is too old/)
    // An environment failure (exit 2), not a product one: the app did nothing wrong.
    expect(isEnvironmentStepFailure(err)).toBe(true)
    expect(received.some((m) => m['type'] === 'app:launch')).toBe(false)
  })

  it('fails a launch the agent answered without naming what it applied', async () => {
    const { client } = await relay({ features: ['launch-options'] })
    const err = await client.launchApp('s1', 7, { env: { A: '1' } }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/without the launch arguments/)
    expect(isEnvironmentStepFailure(err)).toBe(true)
  })

  // The relay supports the options but the device's agent does not: a version mismatch, so exit 2. Any other
  // refusal stays what a launch failure always was.
  it('counts the relay\'s agent-outdated refusal as an environment failure, and no other', async () => {
    const outdated = await relay({ features: ['launch-options'], refuse: { message: 'agent too old', reason: 'agent-outdated' } })
    expect(isEnvironmentStepFailure(await outdated.client.launchApp('s1', 7, { arguments: { a: 1 } }).catch((e: unknown) => e))).toBe(true)
    outdated.client.disconnect()
    for (const c of wss!.clients) c.terminate()
    await new Promise<void>((r) => wss!.close(() => r()))
    wss = null
    const other = await relay({ features: ['launch-options'], refuse: { message: 'env is iOS-only' } })
    const err = await other.client.launchApp('s1', 7, { env: { A: '1' } }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/env is iOS-only/)
    expect(isEnvironmentStepFailure(err)).toBe(false)
  })

  it('asks the relay nothing for a plain launch, and needs no applied keys', async () => {
    const { client, received } = await relay({})
    await client.launchApp('s1', 7)
    expect(received.some((m) => m['type'] === 'agents:list')).toBe(false)
    expect(Object.keys(received.find((m) => m['type'] === 'app:launch')!)).toEqual(['type', 'sessionId', 'requestId', 'buildId'])
  })
})

describe('RelayClient.chrome — the device\'s buttons, for checking a flow before it runs', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  async function joined(chromeAfterMs: number | null) {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'session:start') return
        ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        if (chromeAfterMs !== null) {
          setTimeout(() => ws.send(JSON.stringify({ type: 'session:chrome', sessionId: msg['sessionId'], payload: { buttons: [], streamType: 'h264' } })), chromeAfterMs)
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    return client
  }

  it('keeps the chrome the relay sent at join, with nothing waiting for it', async () => {
    const client = await joined(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(await client.chrome('s1', 1)).toEqual({ buttons: [], streamType: 'h264' })
    client.disconnect()
  })

  it('waits for one still to come, and answers null when none does', async () => {
    const late = await joined(40)
    expect(await late.chrome('s1', 2000)).toEqual({ buttons: [], streamType: 'h264' })
    late.disconnect()
    const first = wss!
    for (const c of first.clients) c.terminate()
    await new Promise<void>((r) => first.close(() => r()))
    const never = await joined(null)
    expect(await never.chrome('s1', 30)).toBeNull()
    never.disconnect()
  })
})

describe('RelayClient.setOrientation / setPosture — wait for the state, not the first event', () => {
  let wss: WebSocketServer | null = null
  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  const iosChrome = (streamRotation?: number, extra: Record<string, unknown> = {}) => ({
    framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
    padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
    screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1, buttons: [], ...(streamRotation === undefined ? {} : { streamRotation }), ...extra,
  })

  /** A relay that sends `initial` after the join and answers each request with the frames `answer` returns. */
  async function relay(initial: Record<string, unknown>[], answer: (m: Record<string, unknown>) => Record<string, unknown>[]) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: 's1', capabilities: [] }))
          for (const f of initial) ws.send(JSON.stringify({ sessionId: 's1', ...f }))
          return
        }
        for (const f of answer(msg)) setTimeout(() => ws.send(JSON.stringify({ sessionId: 's1', ...f })), 20)
      })
    })
    const client = new RelayClient(`ws://localhost:${(wss.address() as { port: number }).port}`, '')
    await client.connect()
    await client.joinSession('s1')
    await new Promise((r) => setTimeout(r, 30))
    return { client, received }
  }

  it('sends nothing when the device is already held that way', async () => {
    const { client, received } = await relay([{ type: 'session:chrome', payload: iosChrome(270) }], () => [])
    await client.setOrientation('s1', 'landscape', 500)
    expect(received.some((m) => m['type'] === 'input:rotate')).toBe(false)
  })

  // An Android body coming upright sends several chromes on the way; only the one that names the target ends the wait.
  it('turns, and waits past an intermediate chrome for the one that names the target', async () => {
    const { client, received } = await relay([{ type: 'session:chrome', payload: { buttons: [], streamType: 'h264', bodyRotation: 90 } }], (m) =>
      m['type'] === 'input:rotate'
        ? [{ type: 'session:chrome', payload: { buttons: [], streamType: 'h264', bodyRotation: 90 } }, { type: 'session:chrome', payload: { buttons: [], streamType: 'h264', bodyRotation: 0 } }]
        : [])
    await client.setOrientation('s1', 'portrait', 1000)
    expect(received.find((m) => m['type'] === 'input:rotate')).toMatchObject({ payload: { orientation: 'portrait' } })
  })

  it('turns an upside-down device to portrait rather than calling it done', async () => {
    const { client, received } = await relay([{ type: 'session:chrome', payload: iosChrome(180) }], (m) =>
      m['type'] === 'input:rotate' ? [{ type: 'session:chrome', payload: iosChrome(0) }] : [])
    await client.setOrientation('s1', 'portrait', 1000)
    expect(received.some((m) => m['type'] === 'input:rotate')).toBe(true)
  })

  it('refuses a device that cannot say which way it is held, as a device that lacks it', async () => {
    const { client } = await relay([{ type: 'session:chrome', payload: iosChrome(90, { scaleBasis: 2000 }) }], () => [])
    await expect(client.setOrientation('s1', 'landscape', 300)).rejects.toBeInstanceOf(DeviceLacksError)
  })

  it('fails as the environment when the turn never shows', async () => {
    const { client } = await relay([{ type: 'session:chrome', payload: iosChrome(0) }], () => [])
    const err = await client.setOrientation('s1', 'landscape', 200).catch((e: unknown) => e)
    expect(isEnvironmentStepFailure(err)).toBe(true)
    expect(err).not.toBeInstanceOf(DeviceLacksError)
    expect((err as Error).message).toMatch(/did not report landscape/)
  })

  const two = (currentId: string) => ({ type: 'device:postures', payload: { postures: [{ id: 'closed', label: 'Folded' }, { id: 'open', label: 'Unfolded' }], currentId } })

  // iOS sends an empty list before the device is ready and in the middle of a fold (measured).
  it('waits past an empty list, then folds and waits for the posture to be current', async () => {
    const { client, received } = await relay([{ type: 'device:postures', payload: { postures: [], currentId: null } }], (m) =>
      m['type'] === 'input:posture' ? [{ type: 'device:postures', payload: { postures: [], currentId: null } }, two('closed')] : [])
    const pending = client.setPosture('s1', 'folded', 1000)
    // A second empty list while it waits must not end the wait either: only one with postures in it does.
    const push = (f: Record<string, unknown>) => { for (const c of wss!.clients) c.send(JSON.stringify({ sessionId: 's1', ...f })) }
    setTimeout(() => push({ type: 'device:postures', payload: { postures: [], currentId: null } }), 30)
    setTimeout(() => push(two('open')), 80)
    await pending
    expect(received.find((m) => m['type'] === 'input:posture')).toMatchObject({ payload: { postureId: 'closed' } })
  })

  it('sends nothing when the device is already in that posture', async () => {
    const { client, received } = await relay([two('closed')], () => [])
    await client.setPosture('s1', 'folded', 500)
    expect(received.some((m) => m['type'] === 'input:posture')).toBe(false)
  })

  it('refuses a device with no postures as one that lacks them, and a list of three as uncertain', async () => {
    const none = await relay([{ type: 'device:postures', payload: { postures: [], currentId: null } }], () => [])
    await expect(none.client.setPosture('s1', 'unfolded', 200)).rejects.toBeInstanceOf(DeviceLacksError)
    none.client.disconnect()
    const first = wss!
    for (const c of first.clients) c.terminate()
    await new Promise<void>((r) => first.close(() => r()))
    const three = await relay([{ type: 'device:postures', payload: { postures: [{ id: '1', label: 'a' }, { id: '2', label: 'b' }, { id: '3', label: 'c' }], currentId: '1' } }], () => [])
    const err = await three.client.setPosture('s1', 'unfolded', 200).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/offers 3 postures/)
    expect(err).not.toBeInstanceOf(DeviceLacksError)
  })
})
