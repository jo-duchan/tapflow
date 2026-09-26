import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer, IDR_REQUEST_THROTTLE_MS, ownerKeyFor } from '../RelayServer'
import { signJwt, hashPat } from '../middleware/auth'
import type { JoinResult } from '../SessionManager'
import { initDb, closeDb, getDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type {
  AgentRegistered, AgentsListed, DeviceShutdown, DeviceShutdownError, GenericError, SessionChrome,
  SessionJoined,
} from '@tapflowio/protocol'

// Three defects that share a subject — who holds a session — and **not** the question of who *should*.
// That one is #527/#507(2) and needs a definition of owner that survives a reconnect, which is a
// different slice. What is here is the part that needed no such decision:
//
//  - #515 a socket re-joining the session it already holds was told `session-not-found`
//  - #507 the reverse index held one session per socket while the relation is one-to-many
//  - #542 `device:shutdown` was the one browser command the relay never answered
describe('session ownership seam', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ownership-seam-'))
    initDb(path.join(tmpDir, 'test.db'))
    // `browserSocket(…, userId)` signs a cookie, and the cookie check reads the users row.
    for (const id of [1, 2]) {
      getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'Admin', 'x')").run(id, `u${id}@example.test`)
    }
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  async function registerAgent(name: string, devices = 1, capabilities?: string[]) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name,
      ...(capabilities ? { capabilities } : {}),
      devices: Array.from({ length: devices }, (_, i) => ({
        id: `dev${i}`, name: `iPhone ${i}`, platform: 'ios', status: 'shutdown',
      })),
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    return { agent, sessionIds: reply.registeredSessions.map((s) => s.sessionId) }
  }

  /** A browser socket, optionally speaking for a named client. Omitting the id is what an older build or
   *  a third-party client does, and the relay mints one per connection — so two anonymous sockets are two
   *  owners, which is exactly today's behaviour. */
  async function browserSocket(client?: string, userId?: number) {
    const url = new URL(`ws://localhost:${port}`)
    if (client) url.searchParams.set('client', client)
    // A cookie is the only way to give a connection a *principal* here — every socket in this file is
    // otherwise a localhost connection with no auth, so all of them are `anon` and any rule keyed on the
    // user is trivially satisfied. Two mutations survived on exactly that before this parameter existed.
    const headers = userId === undefined
      ? undefined
      : { cookie: `tapflow_token=${signJwt({ userId, email: `u${userId}@example.test`, role: 'Admin' })}` }
    const ws = new WebSocket(url.toString(), { headers })
    await waitForOpen(ws)
    return ws
  }

  // ── #515 — re-joining a session this socket already holds ─────────────────────────────────────────

  it('answers a re-join by the owning socket with session:joined, not an error', async () => {
    const { agent, sessionIds } = await registerAgent('seam-rejoin')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType<SessionJoined>(browser, 'session:joined')

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const again = await waitForType<SessionJoined>(browser, 'session:joined')
    expect(again.sessionId).toBe(sessionId)

    // The refusal is the thing being ruled out, so it is waited for rather than assumed absent: the
    // relay used to send `error` with `reason: 'session-not-found'` here, for a session this socket was
    // holding — `DeviceViewer` maps that reason to `onSessionEnded('agent-disconnected')` and takes the
    // viewer off a session that is fine.
    expect(await waitForTypeOrNull<GenericError>(browser, 'error', 200)).toBeNull()

    agent.close(); browser.close()
  })

  it('replays the session cache to a re-joining owner, as it does for a fresh join', async () => {
    const { agent, sessionIds } = await registerAgent('seam-replay')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    agent.send(JSON.stringify({
      type: 'session:chrome', sessionId, payload: { platform: 'ios', model: 'iPhone 15' },
    }))
    await waitForType<SessionChrome>(browser, 'session:chrome')

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    // Idempotent means the *whole* handler runs again, not just its reply. A re-join that answered and
    // returned early would leave a reconnecting viewer with no bezel — which is the state #515's
    // consumers were in for a different reason.
    const chrome = await waitForType<SessionChrome>(browser, 'session:chrome')
    expect(chrome.payload).toMatchObject({ model: 'iPhone 15' })

    agent.close(); browser.close()
  })

  it('a re-join leaves the socket owning the session, and holding it exactly once', async () => {
    const { agent, sessionIds } = await registerAgent('seam-keeps')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    // Ownership survived: an acked input from this socket is forwarded rather than refused. Asserted
    // through the wire because `ownsSession` is what every command consults, and a re-join that dropped
    // the binding would leave the viewer connected and unable to touch anything.
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-1', payload: { x: 0.5, y: 0.5 },
    }))
    const forwarded = await waitForType(agent, 'input:touch:end')
    expect(forwarded.sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(browser, 'input:error', 200)).toBeNull()

    agent.close(); browser.close()
  })

  it('still refuses a socket that does not hold the session', async () => {
    const { agent, sessionIds } = await registerAgent('seam-busy')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket()
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const other = await browserSocket()
    other.send(JSON.stringify({ type: 'session:start', sessionId }))
    const refusal = await waitForType<GenericError>(other, 'error')
    expect(refusal.reason).toBe('session-busy')

    agent.close(); holder.close(); other.close()
  })

  // `join()`'s two failures are answered above it in the handler, so nothing reaches its result branch by
  // ordinary means — and an arm no input can reach is an arm whose reply drifts. `RelayServer.test.ts`
  // forces the `catch` next door with the same technique and for the same stated reason. The mapping is
  // what is under test: reporting `held-by-another` as `session-not-found` is #515's defect exactly, and
  // without this the mutation that reintroduces it survives the whole suite.
  it.each([
    ['not-found', 'session-not-found', 'Session not found'],
    ['held-by-another', 'session-busy', 'Session busy'],
  ] as const)('maps a %s from join() to %s', async (failure, reason, message) => {
    const { agent, sessionIds } = await registerAgent(`seam-map-${failure}`)
    const sessionId = sessionIds[0]!
    // Typed against the exported result rather than a local shape plus `as never`: the mocked value is
    // then checked, so widening the failure union without widening this mapping fails here.
    const sessions = (server as unknown as {
      sessions: { join(id: string, ws: WebSocket): JoinResult }
    }).sessions
    const spy = vi.spyOn(sessions, 'join').mockReturnValue({ ok: false, failure })
    try {
      const browser = await browserSocket()
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      const err = await waitForType<GenericError>(browser, 'error')
      expect(err.reason).toBe(reason)
      expect(err.message).toBe(message)
      expect(err.sessionId).toBe(sessionId)
      browser.close()
    } finally { spy.mockRestore() }
    agent.close()
  })

  // ── #507 — one socket, several sessions ───────────────────────────────────────────────────────────

  it('releases every session a closing socket held, not just the last one joined', async () => {
    // `mcp-server` runs one WebSocket for the whole process and joins a session per device, so this is
    // the ordinary shape rather than an edge case. With the old one-slot index the close handler found
    // only `b`: `a` kept a `browserSocket` pointing at a dead socket, stayed `busy: true` for the life of
    // the relay, and never got an idle timer — a booted device with nobody watching and nothing to stop
    // it. The relay is built with a 50ms idle timeout here so the timer's effect is observable.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-multi', 2)
    const [a, b] = sessionIds as [string, string]
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: a }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId: b }))
    await waitForType(browser, 'session:joined')

    browser.close()

    // Both idle timers fire, so the agent is asked to shut both devices down. Collected by session id
    // rather than counted: the failure this replaces produced exactly one of these, and a count of two
    // would also pass if the same session were released twice.
    const first = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    const second = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect([first.sessionId, second.sessionId].sort()).toEqual([a, b].sort())

    agent.close()
  })

  it('keeps the first session usable while the same socket holds a second', async () => {
    const { agent, sessionIds } = await registerAgent('seam-both-live', 2)
    const [a, b] = sessionIds as [string, string]
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: a }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId: b }))
    await waitForType(browser, 'session:joined')

    // The first design for #507 released `a` here, which would refuse this input and, five minutes on,
    // shut a device down under a caller that is still driving it. Two independent design reviews found
    // that before it was written; this is what says so afterwards.
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId: a, requestId: 'rq-a', payload: { x: 0.1, y: 0.1 },
    }))
    const forwarded = await waitForType(agent, 'input:touch:end')
    expect(forwarded.sessionId).toBe(a)

    agent.close(); browser.close()
  })

  it('arms no idle timer for a socket closed by stop() itself', async () => {
    // `stop()` sets `stopping` and then terminates every client, so the release loop runs during
    // shutdown with as many sessions as the socket held — and each `clearBrowser(id, cb)` arms a timer
    // that outlives the promise `stop()` resolves. `holdAgentSocket` carries the same guard with the
    // same reason beside it; the browser side did not, and #507 turned one stray timer into N.
    //
    // **The agent has to be inside its reconnect hold, and finding that out is the test.** A first
    // version just stopped a healthy relay and found the sessions already gone: `stop()` terminates the
    // agent socket too, its close hits `holdAgentSocket`'s own `stopping` guard, and `evictAgentSocket`
    // removes every session — which clears any timer the browser's close had armed a moment earlier.
    // So the guard is load-bearing in exactly one state, and it is a state #426 made ordinary: the
    // agent dropped uncleanly, its socket is no longer in `wss.clients`, so nothing evicts on the way
    // out and the sessions — with their timers — survive the server.
    //
    // **Asserted on `session.idleTimer`, not on the absence of a shutdown.** A test that waits out the
    // timeout and finds nothing passes when nothing happens, which is its definition: it cannot tell a
    // working guard from a relay that has stopped answering. The field is a positive statement.
    const own = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await own.start()
    const ownPort = (own.address() as { port: number }).port

    const agent = new WebSocket(`ws://localhost:${ownPort}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'seam-stopping',
      devices: [
        { id: 'dev0', name: 'iPhone 0', platform: 'ios', status: 'shutdown' },
        { id: 'dev1', name: 'iPhone 1', platform: 'ios', status: 'shutdown' },
      ],
    }))
    const reg = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const ids = reg.registeredSessions.map((s) => s.sessionId)

    const browser = new WebSocket(`ws://localhost:${ownPort}`)
    await waitForOpen(browser)
    for (const id of ids) {
      browser.send(JSON.stringify({ type: 'session:start', sessionId: id }))
      await waitForType(browser, 'session:joined')
    }

    // Into the hold. `session:agent-away` is the relay saying it kept the sessions rather than ending
    // them, so waiting for it is what proves the state is set up — a sleep would not.
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await waitForType(browser, 'session:agent-away')

    // `stop()` resolves only after `wss.close()` has seen every remaining client close, so the handler
    // under test has run by the time this returns. No sleep, and nothing to race.
    await own.stop()

    const sessions = (own as unknown as {
      sessions: { get(id: string): { idleTimer: unknown; browserSocket: unknown } | undefined }
    }).sessions
    for (const id of ids) {
      // Present, which is the premise — an evicted session would make the timer assertion vacuous, and
      // that is precisely how the first version of this test passed against the unguarded code.
      expect(sessions.get(id), `${id} was evicted, so this proves nothing`).toBeDefined()
      expect(sessions.get(id)?.idleTimer, `${id} armed a timer during stop()`).toBeNull()
    }
    // The cost of the guard, stated rather than left implicit: the sessions stay bound to a socket that
    // is gone. Correct here and only here — the process is on its way out, and the alternative is a
    // timer firing at a relay that no longer exists.
    expect(sessions.get(ids[0]!)?.browserSocket).not.toBeNull()

    browser.close()
  })

  it('does not let repeated re-joins force one keyframe each', async () => {
    // #515 made a re-join run the handler's whole body, and the tail of that body asks the agent for an
    // IDR when the session is streaming. That line was unreachable for a socket already holding the
    // session — `join()` threw and the handler answered above it — so making the re-join succeed opened
    // a request-per-frame path on the direction a viewer with devtools controls. A 1080p IDR is two
    // orders of magnitude larger than the P-frames around it, so the cost lands on the tester watching.
    //
    // Counted rather than sampled: the assertion that discriminates a throttled call from a bare
    // `sendTo` is **how many** arrive, and no shape of "did one arrive" can see the difference.
    //
    // **Time is frozen rather than the count loosened.** Review proposed `< 5`, on the grounds that five
    // round trips could cross the 500ms window on a loaded runner — a real risk, and a fix that spends
    // the assertion to buy it: `< 5` passes on four, so a throttle shortened to 1ms would survive, and
    // that mutation is the one this test exists for. Faking `Date` alone removes the dependency instead
    // of trading it away. `setTimeout` stays real, so the sockets and the relay's own timers are
    // untouched — it is only `Date.now()` that the throttle reads.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await runIdrCount()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── #614: the network condition a re-joining viewer cannot otherwise learn ──────────────────
  //
  // Sibling of the IDR block above and deliberately not folded into it: the two share a window size
  // and not a policy. IDR drops inside the window because the next periodic keyframe repairs it;
  // nothing re-produces a `network:state`, so this one coalesces onto the trailing edge.

  /** What an agent must announce for the relay to ask it anything about the network. */
  const NETWORK_AGENT = ['clipboard', 'network-control']

  /** Collect `network:request-state` frames arriving at an agent socket. */
  function watchRequests(agent: WebSocket) {
    const seen: unknown[] = []
    agent.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type?: string }
      if (m.type === 'network:request-state') seen.push(m)
    })
    return seen
  }

  type NetworkRequester = (() => void) & { dispose(): void }

  function networkRequesterFor(sessionId: string): NetworkRequester | undefined {
    const requesters = (server as unknown as {
      networkStateRequesters: Map<string, NetworkRequester>
    }).networkStateRequesters
    return requesters.get(sessionId)
  }

  /** Join, then make the agent announce a ready device — `readySent` is what gates the request.
   *
   *  Deliberately stops before re-joining: the request rides the *replay* to a viewer that comes back,
   *  and on the first join there is nothing to replay yet. Each test re-joins for itself, so the
   *  control below is the same shape as the positives with one thing removed. */
  async function joinReady(sessionId: string, agent: WebSocket, browser: WebSocket) {
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(browser, 'device:ready')
  }

  async function rejoin(sessionId: string, browser: WebSocket) {
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
  }

  it('asks the agent what the device network is doing when a viewer re-joins', async () => {
    const { agent, sessionIds } = await registerAgent('seam-net-1', 1, NETWORK_AGENT)
    const sessionId = sessionIds[0]!
    const seen = watchRequests(agent)
    const browser = await browserSocket()
    await joinReady(sessionId, agent, browser)
    await rejoin(sessionId, browser)
    await barrier(agent)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ type: 'network:request-state', sessionId })

    agent.close(); browser.close()
  })

  it('asks nothing for a session that never announced a ready device', async () => {
    // The control. Without it the assertion above passes on a relay that fires the request from the
    // top of `handleSessionStart`, which would reach a session with no device at all.
    //
    // Mutation: hoisting the call out of the `readySent` block fails here.
    const { agent, sessionIds } = await registerAgent('seam-net-2', 1, NETWORK_AGENT)
    const sessionId = sessionIds[0]!
    const seen = watchRequests(agent)
    const browser = await browserSocket()
    await rejoin(sessionId, browser)
    await rejoin(sessionId, browser)
    // `session:joined` is the trigger's echo, so the barrier is a round trip on the agent's own socket
    // — anything the relay sent it before answering the join has reached this end by the time it
    // returns.
    await barrier(agent)

    expect(seen).toHaveLength(0)

    agent.close(); browser.close()
  })

  it('keeps one requester across repeated re-joins', async () => {
    // The deterministic helper test owns the timing policy. This integration seam proves each re-join
    // reaches the same per-session requester, rather than silently making a new budget each time.
    const { agent, sessionIds } = await registerAgent('seam-net-3', 1, NETWORK_AGENT)
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    await joinReady(sessionId, agent, browser)
    await rejoin(sessionId, browser)

    const requester = networkRequesterFor(sessionId)
    expect(requester).toBeDefined()

    const reached = vi.fn()
    const requesters = (server as unknown as {
      networkStateRequesters: Map<string, NetworkRequester>
    }).networkStateRequesters
    const observedRequester = Object.assign(
      () => { reached(); requester!() },
      { dispose: () => requester!.dispose() },
    )
    requesters.set(sessionId, observedRequester)

    await rejoin(sessionId, browser)
    await rejoin(sessionId, browser)
    expect(reached).toHaveBeenCalledTimes(2)
    expect(networkRequesterFor(sessionId)).toBe(observedRequester)

    agent.close(); browser.close()
  })

  it('disposes a requester when the session is forgotten', async () => {
    // The helper's unit test proves that dispose cancels a pending trailing edge. This seam holds the
    // RelayServer half: every session-removal path must invoke that method before dropping the map entry.
    const { agent, sessionIds } = await registerAgent('seam-net-4', 1, NETWORK_AGENT)
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    await joinReady(sessionId, agent, browser)
    await rejoin(sessionId, browser)

    const requester = networkRequesterFor(sessionId)
    expect(requester).toBeDefined()
    const dispose = vi.spyOn(requester!, 'dispose')

    browser.send(JSON.stringify({ type: 'session:leave', sessionId }))
    await barrier(browser)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(networkRequesterFor(sessionId)).toBeUndefined()

    agent.close(); browser.close()
  })

  it('asks nothing of an agent that never claimed it could do this', async () => {
    // The control the capability gate needs, and the reason it is not the IDR's blind send: an agent
    // without the code never answers, and an unanswered ask is indistinguishable from a failed read —
    // so a viewer arming a deadline would report "could not read" on every re-join for an agent that
    // already said, in `session:joined`, that it cannot. iOS is that agent until #607's last slice.
    //
    // Registered exactly like the positives with the one string removed, so what differs is the claim
    // and not the setup. Mutation: dropping the `agentCapabilities` check fires here.
    const { agent, sessionIds } = await registerAgent('seam-net-nocap', 1, ['clipboard'])
    const sessionId = sessionIds[0]!
    const seen = watchRequests(agent)
    const browser = await browserSocket()
    await joinReady(sessionId, agent, browser)
    await rejoin(sessionId, browser)
    await barrier(agent)

    expect(seen).toHaveLength(0)

    agent.close(); browser.close()
  })

  it('serves a viewer that comes back on a new socket after a dirty disconnect', async () => {
    // **The path this whole slice exists for, and the one the other tests do not walk.** They re-join
    // on the same live socket (#515), which `session:leave` and a clean close both clear. A browser
    // that dies in its close handler runs `clearBrowser` and *not* `forgetSessionState`, so its
    // requester survives into the re-join. That is the ordinary case: a laptop lid, a Wi-Fi blip, a
    // tab reload. The deterministic helper test owns the timing policy; this one pins that lifecycle.
    const { agent, sessionIds } = await registerAgent('seam-net-blip', 1, NETWORK_AGENT)
    const sessionId = sessionIds[0]!
    const first = await browserSocket('same-client')
    await joinReady(sessionId, agent, first)
    await rejoin(sessionId, first)

    const requesters = (server as unknown as {
      networkStateRequesters: Map<string, NetworkRequester>
    }).networkStateRequesters
    const retained: NetworkRequester = Object.assign(vi.fn(), { dispose: vi.fn() })
    requesters.set(sessionId, retained)

    // Dies without saying goodbye. `terminate` rather than `close` so no close frame is negotiated.
    const closed = new Promise<void>((resolve) => first.once('close', resolve))
    first.terminate()
    await closed

    const second = await browserSocket('same-client')
    await rejoin(sessionId, second)

    expect(retained).toHaveBeenCalledTimes(1)
    expect(networkRequesterFor(sessionId)).toBe(retained)

    // The reply belongs to whichever socket holds the session when it arrives, not the one that armed
    // the requester before the dirty disconnect.
    agent.send(JSON.stringify({
      type: 'network:state', sessionId, payload: { offline: true, available: true },
    }))
    const state = await waitForType(second, 'network:state')
    expect(state['payload']).toEqual({ offline: true, available: true })

    agent.close(); second.close()
  })

  async function runIdrCount() {
    const { agent, sessionIds } = await registerAgent('seam-idr')
    const sessionId = sessionIds[0]!
    const idrs: unknown[] = []
    agent.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type?: string }
      if (m.type === 'stream:request-idr') idrs.push(m)
    })

    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    // `readySent` is what gates the IDR, and only a `device:ready` from the agent sets it.
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(browser, 'device:ready')

    for (let i = 0; i < 5; i++) {
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')
    }
    // The relay answered all five; a round trip on the agent's own socket proves anything it sent them
    // has been flushed to this end too.
    await barrier(agent)

    expect(idrs).toHaveLength(1)

    // **The window's size, not just its existence.** With `Date.now()` frozen, `now - lastAt` is always
    // zero, so *any* positive threshold coalesces the burst — a throttle shortened to 1ms would pass the
    // assertion above, and that mutation survived until these two steps existed. Moving the clock inside
    // the window and then past it pins both edges against the constant rather than against wall time.
    vi.setSystemTime(Date.now() + Math.floor(IDR_REQUEST_THROTTLE_MS / 5))
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    await barrier(agent)
    expect(idrs, 'the throttle window is shorter than it declares').toHaveLength(1)

    vi.setSystemTime(Date.now() + IDR_REQUEST_THROTTLE_MS)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    await barrier(agent)
    // And it does reopen — a throttle that never lets a second one through would starve a viewer that
    // re-joins minutes later, which is the case the IDR exists for.
    expect(idrs, 'the throttle window never reopens').toHaveLength(2)

    agent.close(); browser.close()
  }

  it('forgets a session\'s stream state when the session is evicted, not only on end/leave', async () => {
    // The four per-session maps were emptied inline in `session:end` and `session:leave` and nowhere
    // else, so a session ending any other way left all four behind for the life of the process.
    // Pre-existing — and this slice is why it is fixed here rather than filed: `idrRequesters` used to
    // be populated only by the binary drop path, i.e. only under backpressure, and the re-join above
    // now creates an entry for any streaming session. The leak went from rare to ordinary.
    //
    // Eviction is reached the way a restarted agent reaches it: the same identity registering a
    // *different* device list, so nothing is rebound and the old session is replaced outright.
    const { agent, sessionIds } = await registerAgent('seam-evict')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(browser, 'device:ready')
    // The re-join is what creates the entry — the premise, asserted rather than assumed.
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    // **All three maps have to be populated or the assertion below cannot see them.** A first version
    // checked four empty maps and passed against a helper that deleted only one of them — the vacuity
    // that mutation testing keeps finding in this slice. `droppers` and `dropHandlers` are created by
    // the binary path, which reads the *stream* socket, so the frame has to come from one.
    const stream = await browserSocket()
    stream.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForType(stream, 'stream:registered')
    stream.send(Buffer.from([0x01, 0x02, 0x03]), { binary: true })
    // **On `stream`, not on `browser`.** A barrier only orders against traffic on its own socket —
    // WebSocket guarantees ordering within a connection and says nothing across two. Barriering the
    // browser here proved the relay had handled a frame *that socket* sent, which is not the frame the
    // assertions below depend on, so they could run before the binary handler had written the maps.
    await barrier(stream)

    const maps = server as unknown as Record<string, Map<string, unknown>>
    for (const name of ['idrRequesters', 'droppers', 'dropHandlers']) {
      expect(maps[name]!.has(sessionId), `${name} has no entry, so clearing it proves nothing`).toBe(true)
    }

    const replacement = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(replacement)
    replacement.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'seam-evict',
      devices: [{ id: 'devZ', name: 'iPhone Z', platform: 'ios', status: 'shutdown' }],
    }))
    await waitForType(replacement, 'agent:registered')
    await waitForType(browser, 'session:terminated')

    for (const name of ['idrRequesters', 'droppers', 'dropHandlers']) {
      expect(maps[name]!.has(sessionId), `${name} kept the evicted session`).toBe(false)
    }
    // `audioDropHandlers` is the fourth and is **not** asserted: populating it needs an audio-tagged
    // envelope, which is a frame-format fixture this file has no other use for. It is cleared by the
    // same line as the three above, so what is unheld here is one map's membership in a four-line
    // helper rather than a behaviour of its own. Said plainly instead of asserted vacuously.

    agent.close(); browser.close(); stream.close(); replacement.close()
  })

  it('forgets stream state when a session is dropped by the device relist, not the eviction path', async () => {
    // The *other* new call site. `evictAgentSocket` covers a restarting agent that keeps its identity;
    // this loop covers a device that turns up under a **different** agent while its old session sits on
    // a socket that has gone. One line apart in the source and reached by different inputs, so the
    // mutation that deletes this one survives the test above.
    const { agent, sessionIds } = await registerAgent('seam-relist-a')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(browser, 'device:ready')
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const maps = server as unknown as Record<string, Map<string, unknown>>
    expect(maps['idrRequesters']!.has(sessionId), 'the re-join created no entry').toBe(true)

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await waitForType(browser, 'session:agent-away')

    // A different name, so the rebind block finds no socket for this identity and nothing is rebound —
    // the device is then picked up by the relist loop instead.
    const other = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(other)
    other.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'seam-relist-b',
      devices: [{ id: 'dev0', name: 'iPhone 0', platform: 'ios', status: 'shutdown' }],
    }))
    await waitForType(other, 'agent:registered')
    await waitForType(browser, 'session:terminated')

    expect(maps['idrRequesters']!.has(sessionId), 'the relist path kept the session\'s stream state')
      .toBe(false)

    browser.close(); other.close()
  })

  it('releases the sessions a socket that also registered a stream was holding', async () => {
    // The close handler tried the stream branch first and **returned** from it, so a socket that was both
    // never reached the release below — the exact state the loop above exists to end, reachable because
    // the role gate refuses a `browser`-role socket sending a non-browser type and says nothing about a
    // `stream`-role one sending `session:start`. Order matters: `stream:register` first is what makes the
    // socket stream-role, and a socket that joined first would be closed with 1008 for registering.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-stream-holder')
    const sessionId = sessionIds[0]!
    const both = await browserSocket()
    both.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForType(both, 'stream:registered')
    both.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(both, 'session:joined')

    both.close()

    const fired = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect(fired.sessionId).toBe(sessionId)

    agent.close()
  })

  // ── #579 · #527 — the owner is a client, and occupancy is judged by liveness ──────────────────────

  it('a second socket of the same client may command the session the first holds', async () => {
    // #527. The dashboard opens four sockets per tab and the one that holds the session is not the one
    // that sends the teardown, which is why this could not be answered with a socket.
    const { agent, sessionIds } = await registerAgent('owner-two-sockets')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const sibling = await browserSocket('tab-a')
    sibling.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdown>(agent, 'device:shutdown')).sessionId).toBe(sessionId)

    agent.close(); holder.close(); sibling.close()
  })

  it('an unheld session stays shutdownable, so the unmount teardown survives the race', async () => {
    // The reason the gate is "not someone else's" rather than "mine". The viewer's socket close and the
    // teardown's `device:shutdown` travel on different connections with no ordering between them; if the
    // close lands first the session is unheld, and an owns-it gate would refuse the teardown and leave the
    // device booted until the idle timer. #527 named that path as the reason a gate could not be added.
    const { agent, sessionIds } = await registerAgent('owner-unheld')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const closed = new Promise<void>((r) => holder.on('close', () => r()))
    holder.close()
    await closed

    const teardown = await browserSocket('tab-a')
    teardown.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdown>(agent, 'device:shutdown')).sessionId).toBe(sessionId)

    agent.close(); teardown.close()
  })

  it('a live holder still refuses another client', async () => {
    const { agent, sessionIds } = await registerAgent('owner-live-holder')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const other = await browserSocket('tab-b')
    other.send(JSON.stringify({ type: 'session:start', sessionId }))
    expect((await waitForType<GenericError>(other, 'error')).reason).toBe('session-busy')

    agent.close(); holder.close(); other.close()
  })

  it('the same client re-joins on a new socket without waiting for the holder to be noticed', async () => {
    // #579's ordinary shape: `useRelay` reconnects inside the same document after 2s, so the returning
    // socket is a different socket and the same client. Before this it contended with its own predecessor.
    const { agent, sessionIds } = await registerAgent('owner-rejoin')
    const sessionId = sessionIds[0]!
    const first = await browserSocket('tab-a')
    first.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(first, 'session:joined')

    // The old socket is left open and alive — the point is that being the same client is enough.
    const second = await browserSocket('tab-a')
    second.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(second, 'session:joined')

    // Ownership moved: the new socket commands, and replies go to it.
    second.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-1', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await waitForType(agent, 'input:touch:end')).sessionId).toBe(sessionId)

    agent.close(); first.close(); second.close()
  })

  it('a holder that has stopped answering is not occupancy', async () => {
    // #579's root: the check read `readyState`, which a sleeping laptop leaves OPEN. Liveness is the
    // relay's own pong record, reached here the way the other private-field tests in this file reach one.
    const { agent, sessionIds } = await registerAgent('owner-dead-holder')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const internals = server as unknown as {
      sessions: { get(id: string): { browserSocket: object | null } | undefined }
      lastPongAt: WeakMap<object, number>
    }
    const holderWs = internals.sessions.get(sessionId)!.browserSocket!
    internals.lastPongAt.set(holderWs, Date.now() - 10 * 60_000)

    const other = await browserSocket('tab-b')
    other.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(other, 'session:joined')
    expect(await waitForTypeOrNull<GenericError>(other, 'error', 200)).toBeNull()

    agent.close(); holder.close(); other.close()
  })

  it('busy answers the asker, and agrees with occupancy about liveness', async () => {
    const { agent, sessionIds } = await registerAgent('owner-busy')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const listOn = async (ws: WebSocket) => {
      ws.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType<AgentsListed>(ws, 'agents:listed')
      return listed.sessions[0]!.devices.find((d) => d.sessionId === sessionId)!.busy
    }
    const stranger = await browserSocket('tab-b')
    expect(await listOn(stranger), 'another client should see it as taken').toBe(true)
    expect(await listOn(holder), 'the holder should not be locked out of its own device').toBe(false)

    // And the same liveness rule the join uses — otherwise the card flashes free while a join is refused.
    const internals = server as unknown as { lastPongAt: WeakMap<object, number> }
    const holderWs = (server as unknown as {
      sessions: { get(id: string): { browserSocket: object } | undefined }
    }).sessions.get(sessionId)!.browserSocket
    internals.lastPongAt.set(holderWs, Date.now() - 10 * 60_000)
    expect(await listOn(stranger), 'a holder that stopped answering does not keep the card locked').toBe(false)

    agent.close(); holder.close(); stranger.close()
  })

  it('a sibling socket may issue a correlated command, which is what an owner being a client means', async () => {
    // R2, and the assertion `mayShutDown` cannot make: `device:shutdown` has its own weaker gate, so a
    // test using only that one passes with ownership still keyed on the socket. Measured — it did.
    const { agent, sessionIds } = await registerAgent('owner-sibling-input')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const sibling = await browserSocket('tab-a')
    sibling.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-sib', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await waitForType(agent, 'input:touch:end')).sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(sibling, 'input:error', 200)).toBeNull()

    // And a socket of another client is still refused by that same gate.
    const stranger = await browserSocket('tab-b')
    stranger.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-str', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await waitForType(stranger, 'input:error')).reason).toBe('not-session-owner')

    agent.close(); holder.close(); sibling.close(); stranger.close()
  })

  it('a holder whose socket is closing is not busy, because a join for it would succeed', async () => {
    // `busy` and occupancy have to carry **the same** conditions. A socket in CLOSING has not fired
    // `close`, so its pong is still fresh and `isAlive` says yes — but `readyState` is not OPEN, so the
    // join succeeds. `busy` was missing that clause, which locked every other tester out of a device the
    // relay was ready to hand them, for as long as the close took.
    const { agent, sessionIds } = await registerAgent('owner-busy-closing')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const stranger = await browserSocket('tab-b')
    const isBusy = async () => {
      stranger.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType<AgentsListed>(stranger, 'agents:listed')
      return listed.sessions[0]!.devices.find((d) => d.sessionId === sessionId)!.busy
    }
    expect(await isBusy()).toBe(true)

    // Force the holder's server-side socket into a non-OPEN state without letting `close` run, which is
    // what a lost FIN looks like from the relay's side.
    const held = (server as unknown as {
      sessions: { get(id: string): { browserSocket: { readyState: number } } | undefined }
    }).sessions.get(sessionId)!.browserSocket
    const real = held.readyState
    Object.defineProperty(held, 'readyState', { value: WebSocket.CLOSING, configurable: true })
    try {
      expect(await isBusy(), 'busy disagreed with the occupancy test').toBe(false)
    } finally {
      Object.defineProperty(held, 'readyState', { value: real, configurable: true })
    }

    agent.close(); holder.close(); stranger.close()
  })

  it('the owner key pairs the user with the claimed id', () => {
    // Held here because the handler's inline version was unreachable without an authenticated handshake,
    // and a mutation dropping the user id survived the entire suite. Two accounts claiming the same id is
    // the case the pairing exists for: a leaked client id must be useless to anyone else.
    expect(ownerKeyFor(7, 'tab-a').key).toBe('7:tab-a')
    expect(ownerKeyFor(7, 'tab-a').key).not.toBe(ownerKeyFor(8, 'tab-a').key)
    // No claim → a fresh identity each time, which is per-socket, which is what it replaced.
    expect(ownerKeyFor(7, null).key).not.toBe(ownerKeyFor(7, null).key)
    expect(ownerKeyFor(7, '').key).not.toBe(ownerKeyFor(7, '').key)
    // Unauthenticated (localhost) connections still differ by their claim.
    expect(ownerKeyFor(undefined, 'tab-a').key).toBe('anon:tab-a')
  })

  it('mintedness cannot be claimed, only granted', () => {
    // **The forgery a first version admitted.** It marked minted keys with a `minted-` prefix and had the
    // shutdown gate recover the fact with `includes(':minted-')` — but the claim comes off the handshake
    // query unvalidated, so `?client=minted-1` handed the caller its own exemption, and
    // `?client=x:minted-y` did it while keeping a real user id, which let a *different* user power the
    // device off. It is a field now, and a field cannot be spelled into existence.
    expect(ownerKeyFor(7, 'minted-1').minted, 'a claim named like a mint is still a claim').toBe(false)
    expect(ownerKeyFor(7, 'x:minted-y').minted).toBe(false)
    expect(ownerKeyFor(7, null).minted, 'no claim is the only way to be minted').toBe(true)
    expect(ownerKeyFor(7, '').minted).toBe(true)
    // And the principal is the part before the first delimiter, whatever the claim contains.
    expect(ownerKeyFor(7, 'x:minted-y').user).toBe('7')
  })

  it('a socket the handshake never recorded matches nothing, not even another one', () => {
    // **The gates rest on this accessor, not on the seeding being total.** `handleConnection` records every
    // accepted socket before a message can arrive, so nothing reaches the fallback today — but the answer it
    // gives is what decides whether that stays a defence or becomes a dependency. A shared `'unidentified'`
    // made any two unrecorded sockets equal, and equal is exactly what `ownsSession` tests for; equal users
    // are what the shutdown exemption tests for. So a future path that accepted a socket without recording
    // it would not fail closed — it would hand every such socket ownership of every other's session.
    //
    // Reaching in past `private` is deliberate: there is no wire that produces this state, which is the
    // point. A test that could only drive it through a connection would be a test of the seeding instead.
    const relay = new RelayServer({ port: 0 })
    const reach = relay as unknown as {
      ownerRecord(ws: object): { key: string; user: string; minted: boolean }
      ownerOf(ws: object): string
      userOf(ws: object): string
    }
    const [a, b] = [{}, {}]

    expect(reach.ownerOf(a)).not.toBe(reach.ownerOf(b))
    expect(reach.userOf(a), 'equal principals would pass the shutdown exemption').not.toBe(reach.userOf(b))
    expect(reach.ownerRecord(a).minted, 'unrecorded is not the same as unidentified').toBe(false)
    // Stored, not freshly minted per call — otherwise a socket would not own the session it just bound.
    expect(reach.ownerOf(a)).toBe(reach.ownerOf(a))
    expect(reach.ownerOf(a)).toBe(reach.ownerRecord(a).key)
  })

  it('a client that sends no id keeps the behaviour each gate had before it', async () => {
    // R6, and it is **two different answers** because the two gates are different.
    //
    // An unidentified connection is minted an identity, so its sockets are strangers to each other —
    // which is the ownership `ownsSession` always had, and input stays refused. But the *shutdown* gate
    // cannot be applied to such a client at all: it would refuse that client's own teardown every time,
    // not as a race, because its teardown socket is minted a different identity from the one holding the
    // session. An older dashboard bundle re-attaching to an upgraded relay is exactly that shape, and
    // gating it would leave a device booted until the idle timer on every Back press.
    const { agent, sessionIds } = await registerAgent('owner-anonymous')
    const sessionId = sessionIds[0]!
    const one = await browserSocket()
    one.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(one, 'session:joined')

    const two = await browserSocket()
    two.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-anon', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await waitForType(two, 'input:error')).reason, 'input is still socket-shaped').toBe('not-session-owner')

    two.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdown>(agent, 'device:shutdown')).sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(two, 'device:shutdown-error', 200)).toBeNull()

    agent.close(); one.close(); two.close()
  })

  it('an unidentified holder is exempt only for its own user, not across users', async () => {
    // The exemption exists so a legacy client's own teardown works, and its own teardown is by definition
    // the same signed-in user. Extending it further would leave one tester able to power off another's
    // device for as long as anyone runs an older build — unchanged from before the gate existed, which is
    // not a reason to carry it forward when the narrower rule costs one comparison.
    //
    // Both sockets here are unauthenticated localhost connections, so both are the `anon` principal and
    // the exemption applies — which is what makes this the *permissive* half. Its restrictive twin is the
    // unit assertion above: mintedness cannot be claimed, so an identified holder never reaches this path.
    const { agent, sessionIds } = await registerAgent('owner-minted-same-user')
    const sessionId = sessionIds[0]!
    const legacy = await browserSocket()
    legacy.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(legacy, 'session:joined')

    const sibling = await browserSocket()
    sibling.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdown>(agent, 'device:shutdown')).sessionId).toBe(sessionId)

    agent.close(); legacy.close(); sibling.close()
  })

  it('a claim that looks minted is still a claim, and is gated', async () => {
    // The forgery in wire form. A first version marked minted keys inside the owner string and recovered
    // the fact with `includes(':minted-')`, so connecting as this would have handed the caller its own
    // exemption — the claim comes off the handshake query and is never validated.
    const { agent, sessionIds } = await registerAgent('owner-fake-mint')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('minted-1')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const stranger = await browserSocket('tab-b')
    stranger.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType<DeviceShutdownError>(stranger, 'device:shutdown-error')
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 200)).toBeNull()

    agent.close(); holder.close(); stranger.close()
  })

  it('a PAT connection gets its own principal, not `anon`', async () => {
    // `getAuth` reads the cookie only, so a first version made every agent, `mcp-server` and
    // `flow-runner` connection `anon:` — the whole population whose handshake URL is most likely to end
    // up in a reverse proxy's access log, and the one the user pairing exists to protect. The handler was
    // already resolving the PAT and discarding it.
    const db = getDb()
    const addUser = db.prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'Admin')")
    addUser.run(41, 'pat41@example.test')
    addUser.run(42, 'pat42@example.test')
    const mint = (raw: string, userId: number) =>
      db.prepare("INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)")
        .run(userId, `t${userId}`, hashPat(raw), 'view')

    const rawA = 'tflw_pat_ownerA'
    const rawB = 'tflw_pat_ownerB'
    mint(rawA, 41)
    mint(rawB, 42)

    // **A local connection never reaches the PAT path** — `verifyPat` is consulted only when the caller is
    // neither local nor cookie-authenticated, so on the default server every socket here would be `anon`
    // and this test would assert nothing. Trusting the loopback proxy is what lets `x-forwarded-for` make
    // the connection look remote, which is the state a real PAT client is in.
    await server.stop()
    server = new RelayServer({ port: 0, trustedProxies: ['127.0.0.1', '::1'] })
    await server.start()
    port = (server.address() as { port: number }).port

    const withPat = async (raw: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { authorization: `Bearer ${raw}`, 'x-forwarded-for': '203.0.113.7' },
      })
      await waitForOpen(ws)
      return ws
    }

    const { agent, sessionIds } = await registerAgent('owner-pat')
    const sessionId = sessionIds[0]!
    const holder = await withPat(rawA)
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    // A different PAT is a different principal, so it does not inherit the holder's exemption.
    const other = await withPat(rawB)
    other.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType<DeviceShutdownError>(other, 'device:shutdown-error')
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 200)).toBeNull()

    agent.close(); holder.close(); other.close()
  })

  it('the legacy exemption does not reach across users', async () => {
    // The holder identifies itself with nothing, so it is exempt — but only for its own principal. User 2
    // must not inherit user 1's exemption, or one tester could power off another's device for as long as
    // anyone is running a build that predates the `client` parameter.
    const { agent, sessionIds } = await registerAgent('owner-cross-user')
    const sessionId = sessionIds[0]!
    const legacy = await browserSocket(undefined, 1)
    legacy.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(legacy, 'session:joined')

    const sameUser = await browserSocket(undefined, 1)
    sameUser.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdown>(agent, 'device:shutdown')).sessionId).toBe(sessionId)

    const otherUser = await browserSocket(undefined, 2)
    otherUser.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType<DeviceShutdownError>(otherUser, 'device:shutdown-error')
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 200)).toBeNull()

    agent.close(); legacy.close(); sameUser.close(); otherUser.close()
  })

  it('a client that does send an id is gated on shutdown', async () => {
    // The other side of the same rule: the gate holds between clients that say who they are. Paired with
    // the test above so neither can be read as the whole story.
    const { agent, sessionIds } = await registerAgent('owner-identified-gate')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const stranger = await browserSocket('tab-b')
    stranger.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType<DeviceShutdownError>(stranger, 'device:shutdown-error')
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 200)).toBeNull()

    agent.close(); holder.close(); stranger.close()
  })

  // ── #542 — device:shutdown is answered when it cannot be dispatched ───────────────────────────────

  it('answers a shutdown addressed to a session that does not exist', async () => {
    const { agent } = await registerAgent('seam-shutdown-missing')
    const browser = await browserSocket()

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId: 'no-such-session', requestId: 'rq-gone',
      payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    expect(err.message).toBe('Session not found')
    expect(err.sessionId).toBe('no-such-session')
    // Echoed by the relay itself, the obligation `device:boot-error` carries next door: a caller that
    // receives this uncorrelated reads it as unsolicited and waits out its 30s anyway.
    expect(err.requestId).toBe('rq-gone')

    agent.close(); browser.close()
  })

  it('answers a shutdown whose agent has gone', async () => {
    const { agent, sessionIds } = await registerAgent('seam-shutdown-away')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await waitForType(browser, 'session:agent-away')

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId, requestId: 'rq-away', payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    // The two prose strings are one distinction #492 settled: a held session with a dead socket is the
    // agent's fault, a missing session is not, and telling them apart is what stops a caller chasing the
    // wrong problem.
    expect(err.message).toBe('agent offline')

    browser.close()
  })

  it('leaves the correlator absent when the request carried none', async () => {
    // The dashboard's three teardown senders mint no id, deliberately — nothing there waits on the
    // reply. Inventing one would produce a frame that correlates with a request nobody made, and the
    // declaration is `requestId?` on both sides precisely so this can stay absent.
    const { agent } = await registerAgent('seam-shutdown-uncorrelated')
    const browser = await browserSocket()

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId: 'no-such-session', payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    expect(err.message).toBe('Session not found')
    expect('requestId' in err).toBe(false)

    agent.close(); browser.close()
  })

  it('refuses a shutdown for a session another client is holding', async () => {
    // **This test used to assert the opposite**, and deliberately: it pinned #527's omission so that
    // closing it would be a decision someone made rather than a line that drifted in. The decision is
    // made — a session is owned by a client rather than a socket — so the assertion flips. Kept in place,
    // rather than deleted and rewritten elsewhere, because the inversion is the record of the change.
    const { agent, sessionIds } = await registerAgent('seam-shutdown-nonowner')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket('tab-a')
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const stranger = await browserSocket('tab-b')
    stranger.send(JSON.stringify({
      type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' },
    }))
    const refusal = await waitForType<DeviceShutdownError>(stranger, 'device:shutdown-error')
    expect(refusal.message).toMatch(/held by another client/)
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 200)).toBeNull()

    agent.close(); holder.close(); stranger.close()
  })

  it('does not answer the shutdown the relay originates from its own idle timer', async () => {
    // There is no browser behind that one — it is built and sent inside the timer callback and never
    // enters `route()`, so `reachableTarget` cannot see it. Worth pinning because the obvious way to
    // implement #542 is to answer inside a shared helper, and this is the caller that has nobody to
    // answer.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-idle')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const observer = await browserSocket()
    await barrier(observer)
    browser.close()

    const fired = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect(fired.sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(observer, 'device:shutdown-error', 200)).toBeNull()

    agent.close(); observer.close()
  })
})
