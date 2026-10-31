import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'


// #445: every failure of app:install / app:launch has to reach the caller, carrying the sessionId
// it was asked about. A dashboard viewer holds one session per socket so an unattributed error
// still lands somewhere sensible; an MCP caller waits for its own sessionId and cannot tell an
// unattributed error from silence. The worst of the three paths sent nothing at all.
const DEFAULTS = { arguments: { a: 1, b: 2 }, env: { LOG_LEVEL: 'debug' } }

describe('app command failures reach the caller (#445)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  // The relay stats the build before it mints a download ticket, so a row pointing at nothing is
  // now answered rather than forwarded — which is the point, and which this fixture has to satisfy
  // to keep exercising the success path.
  let buildFile: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-app-errors-test-'))
    buildFile = path.join(tmpDir, 'demo.app.zip')
    fs.writeFileSync(buildFile, 'not a real archive, but a real file')
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    // Defaults for an app of its own, so every other test here launches an app with none.
    server = new RelayServer({ port: 0, launchDefaults: new Map([['com.example.defaults', DEFAULTS]]) })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
  })

  async function connectAgentAndBrowser(capabilities?: string[]) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'appCommandErrors-1',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
      ...(capabilities ? { capabilities } : {}),
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions[0]!.sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  /** Blocks until the relay stops offering the agent's devices.
   *
   *  Nothing orders that against the browser's next request, and without this the same request
   *  answers differently depending on which won — measured at roughly 1 run in 10, which is exactly
   *  the kind of flake that gets a real assertion deleted instead of fixed.
   *
   *  It watches `agents:list`, which filters on the socket's `readyState` — so it flips at
   *  close-frame time, strictly earlier than the relay's close handler runs. That is enough here
   *  because the assertion below keys off the same `readyState`, but it is NOT a barrier for
   *  anything that needs the sessions to have been held or evicted. */
  async function untilAgentLeavesTheList(browser: WebSocket) {
    await vi.waitFor(async () => {
      const listed = waitForType(browser, 'agents:listed')
      browser.send(JSON.stringify({ type: 'agents:list' }))
      expect((await listed).sessions ?? []).toHaveLength(0)
    }, { timeout: 2000 })
  }

  function insertBuild(bundleId: string | null): number {
    const db = getDb()
    db.prepare(`INSERT INTO apps (name, platform) VALUES ('Demo', 'ios')`).run()
    const app = db.prepare('SELECT id FROM apps ORDER BY id DESC LIMIT 1').get() as { id: number }
    const r = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (?, '1.0.0', '1', ?, ?)
    `).run(app.id, bundleId, buildFile)
    return Number(r.lastInsertRowid)
  }

  it('answers an unknown session with an app-specific error, not a generic one', async () => {
    const { agent, browser } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-1', sessionId: 'no-such-session', buildId: 1 }))
    // A generic `error` cannot be correlated by construction — the caller cannot tell whose
    // request it answers, so it keeps waiting.
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe('no-such-session')
    expect(msg?.requestId).toBe('rq-1')

    agent.close(); browser.close()
  })

  it('carries the sessionId when the build is missing', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-2', sessionId, buildId: 999999 }))
    const msg = await waitForType(browser, 'app:install-error')
    // The correlator on this exit is held by nothing else: the compiler sees the field is
    // present, not that it is the request's, and a wrong value now *latches* the dashboard
    // rather than merely misattributing — the gate discards it and nothing clears `installing`.
    expect(msg.requestId).toBe('rq-2')

    expect(msg.message).toBe('Build not found')
    expect(msg.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  it('carries the sessionId when the build has no bundle id', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild(null)

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-3', sessionId, buildId }))
    const msg = await waitForType(browser, 'app:launch-error')
    // The correlator on this exit is held by nothing else: the compiler sees the field is
    // present, not that it is the request's, and a wrong value now *latches* the dashboard
    // rather than merely misattributing — the gate discards it and nothing clears `installing`.
    expect(msg.requestId).toBe('rq-3')

    expect(msg.message).toBe('Bundle ID not available for this build')
    expect(msg.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  // Losing the agent takes the session with it — the relay drops every session that agent owned —
  // so this arrives as `Session not found` rather than `agent offline`. Which of the two strings it
  // is does not matter to the caller; what matters is that something arrives, promptly, wearing the
  // sessionId that was asked about. Before this change the caller got a `type: 'error'` it could
  // not attribute, and waited out its deadline instead.
  it('answers promptly and correlatably after the agent disappears — install', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-4', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)
    expect(msg?.requestId).toBe('rq-4')

    browser.close()
  })

  it('answers promptly and correlatably after the agent disappears — launch', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-5', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:launch-error')

    expect(msg?.type).toBe('app:launch-error')
    expect(msg?.sessionId).toBe(sessionId)
    expect(msg?.requestId).toBe('rq-5')

    browser.close()
  })

  it('answers a boot the agent will never receive', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await untilAgentLeavesTheList(browser)

    browser.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-boot-offline', payload: { deviceId: 'dev-1' } }))
    // Without this the viewer sits on "Waiting for first frame…" with nothing said.
    const msg = await waitForTypeOrNull(browser, 'device:boot-error')

    expect(msg).not.toBeNull()
    expect(msg!.sessionId).toBe(sessionId)
    // The session outlives its agent's socket now (#426), so this really is a live session with a
    // dead socket and `agent offline` is the accurate half of that pair. It used to be
    // `Session not found`, which was accurate then and would be misleading now — the id is valid,
    // and an MCP caller retrying it in a second may well succeed.
    //
    // The other half — an id that is genuinely gone, after the hold expires — is covered in
    // `agentReconnectGrace.test.ts`, where the window is short enough to wait out.
    expect(msg!.message).toBe('agent offline')

    browser.close()
  })

  // A missing or non-numeric buildId no longer reaches the DB query at all: `buildId` is
  // `z.number().int()` at the door, so the frame is refused there and answered by `refuseMalformed`.
  // These assert that an answer still arrives — the property they were written for — rather than
  // which prose it carries. Historically better-sqlite3 treated both as "no row" rather than throwing, so the
  // caller still gets a correlated answer instead of an exception killing the handler — which is
  // the property this PR is about. The message is imprecise, not absent.
  it.each([
    ['no buildId', undefined],
    ['a non-numeric buildId', 'abc'],
  ])('answers %s without going silent', async (_label, buildId) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-6', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)
    expect(msg?.requestId).toBe('rq-6')

    agent.close(); browser.close()
  })

  // Answered by the door rather than by the handler, and with a different diagnosis: `malformed
  // app:install payload` rather than `Build not found`, because no lookup ran. These assert the
  // correlation and the type, which is the property that matters — a caller that gets *some* addressed,
  // correlated reply stops waiting.
  // An object or array makes better-sqlite3 throw, and that exception used to be caught by the
  // message loop alongside genuine parse failures — the caller got nothing at all. This is the
  // same silence the rest of the file is about, reached through the type system's blind spot.
  it.each([
    ['an object', {}],
    ['an array', []],
    ['a populated object', { a: 1 }],
  ])('answers a buildId that is %s', async (_label, buildId) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-7', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)
    expect(msg?.requestId).toBe('rq-7')

    agent.close(); browser.close()
  })

  it('answers an object buildId on the launch path too', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-8', sessionId, buildId: {} }))
    const msg = await waitForTypeOrNull(browser, 'app:launch-error')

    expect(msg?.type).toBe('app:launch-error')
    expect(msg?.sessionId).toBe(sessionId)
    expect(msg?.requestId).toBe('rq-8')

    agent.close(); browser.close()
  })

  // `JSON.parse` accepts bare `null`, numbers and strings without throwing, so a payload that is
  // valid JSON but not a message still reaches the routing path. Splitting the parse and route
  // catches — which is what stops a handler throw from vanishing — meant the error branch started
  // reading `.type` off those, raising an unhandled TypeError out of the socket callback. The
  // silence fix must not become a crash.
  it.each(['null', '123', '"str"', 'true'])('survives a bare %s payload', async (raw) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(raw)
    // Still serving afterwards is the assertion: a thrown TypeError here would surface as an
    // unhandled error and, in production, take the process with it.
    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-9', sessionId, buildId: 999999 }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')

    agent.close(); browser.close()
  })

  // `bootDevice` is the first call an MCP caller makes, so a stale session id reported as a dead
  // Mac sends the reader after the wrong problem. An id that was never real is the case where the
  // distinction is decidable — no teardown to race against.
  it('calls an unknown session by its name, not a dead agent', async () => {
    const { agent, browser } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({
      type: 'device:boot', sessionId: 'no-such-session', requestId: 'rq-boot-unknown', payload: { deviceId: 'dev-1' },
    }))
    const msg = await waitForTypeOrNull(browser, 'device:boot-error')

    expect(msg?.message).toBe('Session not found')
    expect(msg?.sessionId).toBe('no-such-session')

    agent.close(); browser.close()
  })

  it('still forwards a valid install to the agent, carrying the request\'s correlator', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:install', requestId: 'rq-10', sessionId, buildId }))
    // The error paths are only correct if the success path is untouched.
    const forwarded = await waitForType(agent, 'app:install')

    expect(forwarded.sessionId).toBe(sessionId)
    const payload = forwarded.payload as {
      filePath: string; buildTicket?: string; buildName?: string; buildBytes?: number
    }
    // Still sent, and still first: an agent that predates downloading reads only this field, so
    // dropping it would break every install against a co-located relay at once.
    expect(payload.filePath).toBe(buildFile)
    // The three that make a remote install possible. `buildName` carries the extension both agents
    // branch on, and `buildBytes` is what a truncated transfer is caught against — `Content-Length`
    // cannot be, because a proxy is free to drop it.
    expect(payload.buildTicket).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.buildName).toBe('demo.app.zip')
    expect(payload.buildBytes).toBe(fs.statSync(buildFile).size)
    // This is the whole guard for the rebuild. The relay does not forward this message — it builds a
    // different one from a DB row — and the agent's reply comes back through a generic forward the relay
    // never inspects, so an id that does not survive the rebuild makes the reply unattributable. The
    // compiler catches the field being *absent*; nothing catches the wrong value being copied, because a
    // brand names a kind and provenance is a property of the instance. Hence this line.
    //
    // `rq-10` is deliberately unlike `sessionId` (a UUID), `filePath` and `bundleId`: a fixture that
    // reused any of those would pass the mutation this exists to fail.
    expect(forwarded.requestId).toBe('rq-10')

    agent.close(); browser.close()
  })

  it('forwards a valid launch to the agent, carrying the request\'s correlator', async () => {
    // `app:launch` is a separate handler with its own rebuild, so it needs its own assertion — the two
    // are not one code path with a parameter.
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-11', sessionId, buildId }))
    const forwarded = await waitForType(agent, 'app:launch')

    expect(forwarded.sessionId).toBe(sessionId)
    expect((forwarded.payload as { bundleId: string }).bundleId).toBe('com.example.demo')
    expect(forwarded.requestId).toBe('rq-11')
    // No options asked for, none invented: an agent of any version reads this payload as it always did.
    expect(forwarded.payload).toEqual({ bundleId: 'com.example.demo' })

    agent.close(); browser.close()
  })

  // #1047. The relay forwards the parse product, so these fields reach the agent only because the schema names them.
  it('forwards launch arguments and env to an agent that applies them', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser(['launch-options'])
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-12', sessionId, buildId, arguments: { FIRDebugEnabled: true }, env: { API_HOST: 'x' } }))
    const forwarded = await waitForType(agent, 'app:launch')

    expect(forwarded.payload).toEqual({ bundleId: 'com.example.demo', arguments: { FIRDebugEnabled: true }, env: { API_HOST: 'x' } })

    agent.close(); browser.close()
  })

  // An agent without the capability ignores both fields and launches anyway, answering done — so the launch the
  // caller asked for never happens and nothing says so.
  it('refuses launch arguments for an agent that predates them, and still forwards a plain launch', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-13', sessionId, buildId, arguments: { a: 1 } }))
    const msg = await waitForType(browser, 'app:launch-error')
    expect(msg.requestId).toBe('rq-13')
    expect(msg.message).toMatch(/too old to pass launch arguments/)
    // What lets a flow runner count it as a version mismatch (exit 2) rather than the app failing.
    expect(msg.reason).toBe('agent-outdated')

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-14', sessionId, buildId, arguments: {}, env: {} }))
    expect((await waitForType(agent, 'app:launch')).requestId).toBe('rq-14')

    agent.close(); browser.close()
  })

  it('refuses options the shared check refuses, naming the key, without forwarding', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser(['launch-options'])
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-15', sessionId, buildId, env: { SIMULATOR_UDID: 'other' } }))
    const msg = await waitForType(browser, 'app:launch-error')
    expect(msg.requestId).toBe('rq-15')
    expect(msg.message).toMatch(/^env\.SIMULATOR_UDID: reserved/)
    expect(msg.reason).toBeUndefined()
    await barrier(agent)
    expect(await waitForTypeOrNull(agent, 'app:launch', 0)).toBeNull()

    agent.close(); browser.close()
  })

  // #1047, PR 2: tapflow.config.json's per-app defaults, merged here so the dashboard, MCP and flows all get them.
  describe('launch defaults', () => {
    const launch = async (caps: string[] | undefined, extra: Record<string, unknown> = {}) => {
      const { agent, browser, sessionId } = await connectAgentAndBrowser(caps)
      const buildId = insertBuild('com.example.defaults')
      browser.send(JSON.stringify({ type: 'app:launch', requestId: 'rq-d', sessionId, buildId, ...extra }))
      return { agent, browser }
    }

    it('sends them on a plain launch, marked as defaults only', async () => {
      const { agent, browser } = await launch(['launch-options', 'launch-env'])
      expect((await waitForType(agent, 'app:launch')).payload).toEqual({ bundleId: 'com.example.defaults', ...DEFAULTS, defaultsOnly: true })
      agent.close(); browser.close()
    })

    it('merges the caller\'s options per key, the caller winning, and is no longer defaults only', async () => {
      const { agent, browser } = await launch(['launch-options', 'launch-env'], { arguments: { b: 3 }, env: { X: '1' } })
      expect((await waitForType(agent, 'app:launch')).payload).toEqual({
        bundleId: 'com.example.defaults', arguments: { a: 1, b: 3 }, env: { LOG_LEVEL: 'debug', X: '1' },
      })
      agent.close(); browser.close()
    })

    it('leaves env defaults out for an agent that cannot set an app\'s environment', async () => {
      const { agent, browser } = await launch(['launch-options'])
      expect((await waitForType(agent, 'app:launch')).payload).toEqual({ bundleId: 'com.example.defaults', arguments: DEFAULTS.arguments, defaultsOnly: true })
      agent.close(); browser.close()
    })

    // Refusing would fail every dashboard Launch of the app on that Mac until it is updated.
    it('launches plainly on an agent that predates options, instead of refusing', async () => {
      const { agent, browser } = await launch(undefined)
      expect((await waitForType(agent, 'app:launch')).payload).toEqual({ bundleId: 'com.example.defaults' })
      agent.close(); browser.close()
    })

    it('refuses when the caller\'s options and the defaults together pass a limit, naming the config', async () => {
      const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
      const { agent, browser } = await launch(['launch-options', 'launch-env'], { arguments: many })
      const msg = await waitForType(browser, 'app:launch-error')
      expect(msg.message).toMatch(/at most 32 .*launch defaults in tapflow\.config\.json/)
      await barrier(agent)
      expect(await waitForTypeOrNull(agent, 'app:launch', 0)).toBeNull()
      agent.close(); browser.close()
    })
  })

  it('advertises launch options to clients', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    const listed = waitForType(browser, 'agents:listed')
    browser.send(JSON.stringify({ type: 'agents:list' }))
    expect((await listed).features).toContain('launch-options')
    browser.close()
  })

  // Door drops. Each asserts the request does not reach the agent, which is the half a compile error
  // cannot cover: `requestId: ''` type-checks against a required `string`, and nothing validates inbound
  // JSON (#444).
  //
  // **A real build row is load-bearing.** The first version of these passed `buildId: 1` with nothing in
  // the table, so `app:launch` never reached the agent because the *lookup* failed — and the test stayed
  // green under a mutation that opened the door. The request has to be one that would otherwise be
  // forwarded, or the assertion is about the wrong thing.
  //
  // Two barriers, on two sockets: order holds *within* a connection, so a round-trip on the agent proves
  // nothing about a message sent on the browser. Browser first — the relay has now processed the request
  // and forwarded it if it was going to — then the agent, then read.
  // Both halves of the predicate, not just one: the first version sent only `requestId: ''`, so dropping
  // the `typeof` half — which lets an **absent** correlator through — left all of these green and only the
  // previous slice's `open-url` tests failed. The predicate is shared, so each half needs a case.
  for (const [type, body, correlator] of [
    ['app:install', 'build', ''],
    ['app:launch', 'build', undefined],
    ['app:clear-state', 'bundle', ''],
  ] as const) {
    it(`drops a ${type} whose correlator is ${correlator === undefined ? 'absent' : 'an empty string'}`, async () => {
      const { agent, browser, sessionId } = await connectAgentAndBrowser()
      const extra = body === 'build'
        ? { buildId: insertBuild('com.example.demo') }
        : { payload: { bundleId: 'com.example.demo' } }

      browser.send(JSON.stringify({ type, sessionId, ...(correlator === undefined ? {} : { requestId: correlator }), ...extra }))
      await barrier(browser)
      await barrier(agent)
      expect(await waitForTypeOrNull(agent, type, 0)).toBeNull()

      agent.close(); browser.close()
    })
  }
})
