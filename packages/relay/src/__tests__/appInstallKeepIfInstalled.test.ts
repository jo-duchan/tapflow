import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AppInstallDone, AppInstallError } from '@tapflowio/protocol'

/**
 * **A viewer coming back to a device does not wipe the app it left there** (#1087).
 *
 * Every install clears the app's data first — iOS uninstalls, Android clears — and the dashboard sends one on every
 * `device:ready`, which a reconnect produces twice. So `keepIfInstalled` asks the relay to skip an install of a build
 * it last put on that device, and the relay is the side that can tell: it saw the install go out and come back, and
 * it sees what happens to the device in between. These tests walk each way the record can go stale.
 */
type AgentInstall = { type: 'app:install'; requestId: string; sessionId: string; payload: { filePath: string } }

describe('app:install with keepIfInstalled', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let buildA: number
  let buildB: number
  let fileA: string
  let agent: WebSocket
  let browser: WebSocket
  let sessionId: string
  let seq = 0
  const open: WebSocket[] = []

  const rid = () => `rq-${++seq}`

  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    open.push(ws)
    await waitForOpen(ws)
    return ws
  }

  async function registerAgent(name = 'keep-agent'): Promise<{ ws: WebSocket; sessionId: string }> {
    const ws = await connect()
    ws.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name,
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const registered = await waitForType<AgentRegistered>(ws, 'agent:registered')
    return { ws, sessionId: registered.registeredSessions[0]!.sessionId }
  }

  async function joinBrowser(): Promise<WebSocket> {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(ws, 'session:joined')
    return ws
  }

  function install(ws: WebSocket, buildId: number, requestId: string, keep: boolean): void {
    ws.send(JSON.stringify({ type: 'app:install', sessionId, requestId, buildId, ...(keep ? { keepIfInstalled: true } : {}) }))
  }

  /** Install, let the agent answer done, and wait for the browser to hear it: the relay now records the build. */
  async function installed(buildId: number): Promise<void> {
    const requestId = rid()
    install(browser, buildId, requestId, false)
    const sent = await waitForType<AgentInstall>(agent, 'app:install')
    agent.send(JSON.stringify({ type: 'app:install-done', sessionId, requestId: sent.requestId }))
    await waitForType<AppInstallDone>(browser, 'app:install-done')
  }

  /**
   * Nothing reached the agent. Both barriers, trigger side first: ordering holds only within one connection, so the
   * browser's round trip proves the relay handled the request and the agent's proves anything it sent has landed.
   */
  async function agentGotNoInstall(): Promise<boolean> {
    await barrier(browser)
    await barrier(agent)
    return (await waitForTypeOrNull(agent, 'app:install', 0)) === null
  }

  beforeAll(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-keep-install-')))
    uploadsDir = path.join(tmpDir, 'uploads')
    fs.mkdirSync(path.join(uploadsDir, 'builds'), { recursive: true })
    initDb(path.join(tmpDir, 'test.db'))
    // A short agent grace, so the disconnect case does not wait out the default.
    server = new RelayServer({ port: 0, uploadsDir, agentGraceMs: 2_000 })
    await server.start()
    port = (server.address() as { port: number }).port

    const db = getDb()
    db.prepare(`INSERT INTO apps (name, platform) VALUES ('Keep', 'ios')`).run()
    const app = db.prepare('SELECT id FROM apps ORDER BY id DESC LIMIT 1').get() as { id: number }
    const addBuild = (name: string): [number, string] => {
      const file = path.join(uploadsDir, 'builds', name)
      fs.writeFileSync(file, name)
      const id = Number(db.prepare(`
        INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path) VALUES (?, '1.0.0', '1', 'com.example.keep', ?)
      `).run(app.id, file).lastInsertRowid)
      return [id, file]
    }
    ;[buildA, fileA] = addBuild('a.app.zip')
    ;[buildB] = addBuild('b.app.zip')
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // A new agent name per test: each starts from a session the relay knows nothing about.
    ;({ ws: agent, sessionId } = await registerAgent(`keep-agent-${seq++}`))
    browser = await joinBrowser()
  })

  afterEach(() => {
    for (const ws of open.splice(0)) ws.terminate()
  })

  it('answers done itself when it last installed this build there', async () => {
    await installed(buildA)
    const requestId = rid()
    install(browser, buildA, requestId, true)

    const done = await waitForType<AppInstallDone>(browser, 'app:install-done')
    expect(done).toEqual({ type: 'app:install-done', sessionId, requestId })
    expect(await agentGotNoInstall()).toBe(true)
  })

  it('reinstalls without the flag, exactly as before', async () => {
    await installed(buildA)
    const requestId = rid()
    install(browser, buildA, requestId, false)

    expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
  })

  it('installs when it has no record of this build', async () => {
    const requestId = rid()
    install(browser, buildA, requestId, true)

    expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
  })

  it('installs a different build', async () => {
    await installed(buildA)
    const requestId = rid()
    install(browser, buildB, requestId, true)

    expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
  })

  it('joins an install of the same build already in flight, and answers both when it lands', async () => {
    const first = rid()
    install(browser, buildA, first, false)
    await waitForType<AgentInstall>(agent, 'app:install')
    const second = rid()
    install(browser, buildA, second, true)
    expect(await agentGotNoInstall()).toBe(true)

    agent.send(JSON.stringify({ type: 'app:install-done', sessionId, requestId: first }))
    const replies = [await waitForType<AppInstallDone>(browser, 'app:install-done'), await waitForType<AppInstallDone>(browser, 'app:install-done')]
    expect(replies.map((r) => r.requestId).sort()).toEqual([first, second].sort())
  })

  it('records an install that finished while no browser held the session', async () => {
    const first = rid()
    install(browser, buildA, first, false)
    await waitForType<AgentInstall>(agent, 'app:install')
    // A leave and a round trip on the same socket, not a terminate: the relay sees a socket close whenever it gets to
    // it, and a done that overtakes the close finds the browser still there, which is not the case under test.
    browser.send(JSON.stringify({ type: 'session:leave', sessionId }))
    await barrier(browser)
    agent.send(JSON.stringify({ type: 'app:install-done', sessionId, requestId: first }))
    await barrier(agent)

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    const again = rid()
    install(browser, buildA, again, true)
    expect((await waitForType<AppInstallDone>(browser, 'app:install-done')).requestId).toBe(again)
    expect(await agentGotNoInstall()).toBe(true)
  })

  // What a stale done must not do is mark the install still running as finished: B is not on the device yet.
  it('ignores the late done of an install that was replaced', async () => {
    const stale = rid()
    install(browser, buildA, stale, false)
    await waitForType<AgentInstall>(agent, 'app:install')
    const current = rid()
    install(browser, buildB, current, false)
    await waitForType<AgentInstall>(agent, 'app:install')
    agent.send(JSON.stringify({ type: 'app:install-done', sessionId, requestId: stale }))
    expect((await waitForType<AppInstallDone>(browser, 'app:install-done')).requestId).toBe(stale)

    const waiter = rid()
    install(browser, buildB, waiter, true)
    expect(await agentGotNoInstall()).toBe(true)
    expect(await waitForTypeOrNull(browser, 'app:install-done', 0)).toBeNull()

    agent.send(JSON.stringify({ type: 'app:install-done', sessionId, requestId: current }))
    const replies = [await waitForType<AppInstallDone>(browser, 'app:install-done'), await waitForType<AppInstallDone>(browser, 'app:install-done')]
    expect(replies.map((r) => r.requestId).sort()).toEqual([current, waiter].sort())
  })

  it('tells a waiter its install was replaced', async () => {
    install(browser, buildA, rid(), false)
    await waitForType<AgentInstall>(agent, 'app:install')
    const waiter = rid()
    install(browser, buildA, waiter, true)
    install(browser, buildB, rid(), false)

    expect((await waitForType<AppInstallError>(browser, 'app:install-error')).requestId).toBe(waiter)
  })

  it('forgets a failed install, and tells its waiters', async () => {
    await installed(buildA)
    const first = rid()
    install(browser, buildA, first, false)
    await waitForType<AgentInstall>(agent, 'app:install')
    const waiter = rid()
    install(browser, buildA, waiter, true)
    agent.send(JSON.stringify({ type: 'app:install-error', sessionId, requestId: first, message: 'simctl failed' }))

    const errors = [await waitForType<AppInstallError>(browser, 'app:install-error'), await waitForType<AppInstallError>(browser, 'app:install-error')]
    expect(errors.map((e) => e.requestId).sort()).toEqual([first, waiter].sort())
    // The agent's reason, not a generic one: the original reply goes to an id the viewer has already let go of.
    expect(errors.find((e) => e.requestId === waiter)!.message).toBe('simctl failed')
    const requestId = rid()
    install(browser, buildA, requestId, true)
    expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
  })

  it('treats the same build id over a different file as a different build', async () => {
    // `builds.id` has no AUTOINCREMENT, so deleting the newest build hands its id to the next upload.
    await installed(buildA)
    const reused = path.join(uploadsDir, 'builds', 'a-reuploaded.app.zip')
    fs.writeFileSync(reused, 'a different binary')
    getDb().prepare('UPDATE builds SET file_path = ? WHERE id = ?').run(reused, buildA)
    try {
      const requestId = rid()
      install(browser, buildA, requestId, true)
      expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
    } finally {
      getDb().prepare('UPDATE builds SET file_path = ? WHERE id = ?').run(fileA, buildA)
    }
  })

  describe('the record goes when the device may have lost the app', () => {
    async function expectReinstall(): Promise<void> {
      const requestId = rid()
      install(browser, buildA, requestId, true)
      expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
    }

    async function expectKept(): Promise<void> {
      const requestId = rid()
      install(browser, buildA, requestId, true)
      expect((await waitForType<AppInstallDone>(browser, 'app:install-done')).requestId).toBe(requestId)
      expect(await agentGotNoInstall()).toBe(true)
    }

    function ready(payload: Record<string, unknown>): void {
      agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1', ...payload } }))
    }

    it('keeps it across a warm ready', async () => {
      await installed(buildA)
      ready({ cold: false })
      await waitForType(browser, 'device:ready')
      await expectKept()
    })

    // Simulator.app or DeviceHub quit, a crash, a Mac restart: the relay saw none of it, and a cold boot can erase.
    it('drops it on a cold ready', async () => {
      await installed(buildA)
      ready({ cold: true })
      await waitForType(browser, 'device:ready')
      await expectReinstall()
    })

    it('drops it on a ready that does not say, as an agent predating the field sends', async () => {
      await installed(buildA)
      ready({})
      await waitForType(browser, 'device:ready')
      await expectReinstall()
    })

    // A toolbar restart is a shutdown and a boot, so this is also the path that covers it.
    it('drops it when the device shuts down', async () => {
      await installed(buildA)
      agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId }))
      await waitForType(browser, 'device:shutdown-done')
      await expectReinstall()
    })

    function boot(payload: Record<string, unknown>): void {
      browser.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: rid(), payload: { deviceId: 'dev-1', ...payload } }))
    }

    it('drops it on a full-erase boot', async () => {
      await installed(buildA)
      boot({ resetMode: 'full-erase' })
      await waitForType(agent, 'device:boot')
      await expectReinstall()
    })

    // Every boot the dashboard sends carries `app-only`, so a truthy check would drop the record on each reconnect.
    it('keeps it on an app-only boot', async () => {
      await installed(buildA)
      boot({ resetMode: 'app-only' })
      await waitForType(agent, 'device:boot')
      await expectKept()
    })

    it('drops it on a boot that carries a run reset', async () => {
      await installed(buildA)
      boot({ runReset: { uninstall: ['com.example.keep'], clear: [] } })
      await waitForType(agent, 'device:boot')
      await expectReinstall()
    })
  })

  describe('a request joined to an install in flight is answered when its agent goes away, not left waiting', () => {
    async function waiterInFlight(): Promise<string> {
      install(browser, buildA, rid(), false)
      await waitForType<AgentInstall>(agent, 'app:install')
      const waiter = rid()
      install(browser, buildA, waiter, true)
      await barrier(browser)
      return waiter
    }

    it('when the agent socket drops', async () => {
      const waiter = await waiterInFlight()
      agent.terminate()

      expect((await waitForType<AppInstallError>(browser, 'app:install-error')).requestId).toBe(waiter)
    })

    // The new install uninstalls the old build before it lands, so the old record must not outlive the agent's loss.
    it('and leaves no record of the build that install was replacing', async () => {
      const name = `replacing-${seq}`
      ;({ ws: agent, sessionId } = await registerAgent(name))
      browser.terminate()
      browser = await joinBrowser()
      await installed(buildA)
      install(browser, buildB, rid(), false)
      await waitForType<AgentInstall>(agent, 'app:install')

      agent = (await registerAgent(name)).ws
      const requestId = rid()
      install(browser, buildA, requestId, true)
      expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
    })

    // Restarted with the old socket still open: this path rebinds without ever passing through the hold.
    it('when the agent restarts and replaces its socket', async () => {
      const name = `replaced-${seq}`
      const first = await registerAgent(name)
      ;({ ws: agent, sessionId } = first)
      browser.terminate()
      browser = await joinBrowser()
      const waiter = await waiterInFlight()

      const second = await registerAgent(name)
      expect(second.sessionId).toBe(sessionId)
      agent = second.ws
      expect((await waitForType<AppInstallError>(browser, 'app:install-error')).requestId).toBe(waiter)

      const requestId = rid()
      install(browser, buildA, requestId, true)
      expect((await waitForType<AgentInstall>(agent, 'app:install')).requestId).toBe(requestId)
    })
  })
})
