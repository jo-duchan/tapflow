import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { closeDb, getDb, initDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AppLogsUnwatch, AppLogsWatch, BrowserInbound } from '@tapflowio/protocol'

describe('app log routing', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let buildFile: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-app-logs-'))
    buildFile = path.join(tmpDir, 'demo.app.zip')
    fs.writeFileSync(buildFile, 'test build')
    initDb(path.join(tmpDir, 'test.db'))
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

  afterEach(async () => {
    await server.stop()
  })

  function insertBuild(): number {
    const db = getDb()
    db.prepare(`INSERT INTO apps (name, platform) VALUES ('Demo', 'ios')`).run()
    const app = db.prepare('SELECT id FROM apps ORDER BY id DESC LIMIT 1').get() as { id: number }
    const result = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (?, '1.0.0', '1', 'com.example.logs', ?)
    `).run(app.id, buildFile)
    return Number(result.lastInsertRowid)
  }

  it('delivers text to the holder and refuses a different agent claiming that session', async () => {
    const open = async () => {
      const socket = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(socket)
      return socket
    }
    const register = async (name: string) => {
      const agent = await open()
      agent.send(
        JSON.stringify({
          type: 'agent:register',
          platform: 'ios',
          agentName: name,
          devices: [{ id: 'device-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
        })
      )
      const registered = await waitForType<AgentRegistered>(agent, 'agent:registered')
      return { agent, sessionId: registered.registeredSessions[0]!.sessionId }
    }

    const first = await register('app-log-owner')
    const other = await register('app-log-outsider')
    const browser = await open()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: first.sessionId }))
    await waitForType(browser, 'session:joined')

    const buildId = insertBuild()
    const forwardedLaunch = waitForType(first.agent, 'app:launch')
    browser.send(JSON.stringify({ type: 'app:launch', requestId: 'launch-1', sessionId: first.sessionId, buildId }))
    await forwardedLaunch
    const launchDone = waitForType(browser, 'app:launch-done')
    first.agent.send(JSON.stringify({ type: 'app:launch-done', requestId: 'launch-1', sessionId: first.sessionId }))
    await launchDone

    const text = 'raw app output\nnext line\t\u0000🚀'
    first.agent.send(JSON.stringify({ type: 'app:log', sessionId: first.sessionId, launchId: 'launch-1', text }))
    const delivered = await waitForType<BrowserInbound>(browser, 'app:log')
    expect(delivered).toEqual({ type: 'app:log', sessionId: first.sessionId, launchId: 'launch-1', text })

    other.agent.send(
      JSON.stringify({ type: 'app:log', sessionId: first.sessionId, launchId: 'launch-1', text: 'spoofed' })
    )
    await barrier(other.agent)
    await barrier(browser)
    expect(await waitForTypeOrNull(browser, 'app:log', 0)).toBeNull()

    first.agent.close()
    other.agent.close()
    browser.close()
  })

  describe('app log watch', () => {
    const open = async () => {
      const socket = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(socket)
      return socket
    }
    const register = async (capabilities: string[] = ['app-logs', 'app-log-watch']) => {
      const agent = await open()
      agent.send(JSON.stringify({
        type: 'agent:register', platform: 'ios', agentName: 'watcher', capabilities,
        devices: [{ id: 'device-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
      }))
      const registered = await waitForType<AgentRegistered>(agent, 'agent:registered')
      return { agent, sessionId: registered.registeredSessions[0]!.sessionId, features: registered.features }
    }
    const join = async (sessionId: string, clientKind: 'dashboard' | 'mcp' = 'dashboard') => {
      const browser = await open()
      browser.send(JSON.stringify({ type: 'session:start', sessionId, clientKind }))
      await waitForType(browser, 'session:joined')
      return browser
    }
    /** Installs a build through the relay and answers it from the agent, as a dashboard does after a boot. */
    const install = async (agent: WebSocket, browser: WebSocket, sessionId: string) => {
      const buildId = insertBuild()
      const forwarded = waitForType(agent, 'app:install')
      browser.send(JSON.stringify({ type: 'app:install', requestId: 'install-1', sessionId, buildId }))
      await forwarded
      const done = waitForType(browser, 'app:install-done')
      agent.send(JSON.stringify({ type: 'app:install-done', requestId: 'install-1', sessionId }))
      await done
      return buildId
    }

    it('says it takes watches, and watches the installed app for a dashboard holder', async () => {
      const { agent, sessionId, features } = await register()
      expect(features).toContain('app-log-watch')
      const browser = await join(sessionId)
      const watch = waitForType<AppLogsWatch>(agent, 'app:logs:watch')
      await install(agent, browser, sessionId)
      const { watchId, bundleId } = await watch
      expect(bundleId).toBe('com.example.logs')

      agent.send(JSON.stringify({ type: 'app:log:run', sessionId, watchId, event: 'started', pid: 4521 }))
      expect(await waitForType(browser, 'app:log:run')).toEqual({ type: 'app:log:run', sessionId, watchId, event: 'started', pid: 4521 })
      agent.send(JSON.stringify({ type: 'app:log', sessionId, watchId, text: 'hello\n' }))
      expect(await waitForType(browser, 'app:log')).toEqual({ type: 'app:log', sessionId, watchId, text: 'hello\n' })

      // Another watch's output, from before an install changed it or from a confused agent, is not this one's.
      agent.send(JSON.stringify({ type: 'app:log', sessionId, watchId: 'stale', text: 'old\n' }))
      agent.send(JSON.stringify({ type: 'app:log:run', sessionId, watchId: 'stale', event: 'exited', pid: 1 }))
      await barrier(agent)
      await barrier(browser)
      expect(await waitForTypeOrNull(browser, 'app:log', 0)).toBeNull()
      expect(await waitForTypeOrNull(browser, 'app:log:run', 0)).toBeNull()
      agent.close(); browser.close()
    })

    it('sends the same watch again on a warm ready, since a restarted agent has lost it', async () => {
      const { agent, sessionId } = await register()
      const browser = await join(sessionId)
      const first = waitForType<AppLogsWatch>(agent, 'app:logs:watch')
      await install(agent, browser, sessionId)
      const { watchId } = await first
      const again = waitForType<AppLogsWatch>(agent, 'app:logs:watch')
      agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { cold: false } }))
      expect((await again).watchId).toBe(watchId)
      agent.close(); browser.close()
    })

    it('does not watch for an MCP holder: CI streams nothing, and a borrowed session is not its person\'s logs', async () => {
      const { agent, sessionId } = await register()
      const browser = await join(sessionId, 'mcp')
      await install(agent, browser, sessionId)
      await barrier(agent)
      expect(await waitForTypeOrNull(agent, 'app:logs:watch', 0)).toBeNull()
      agent.close(); browser.close()
    })

    it('does not watch for an agent without the capability, which keeps the per-launch stream', async () => {
      const { agent, sessionId } = await register(['app-logs'])
      const browser = await join(sessionId)
      await install(agent, browser, sessionId)
      await barrier(agent)
      expect(await waitForTypeOrNull(agent, 'app:logs:watch', 0)).toBeNull()
      agent.close(); browser.close()
    })

    it('watches before a Launch when nothing installed through this relay named the app', async () => {
      const { agent, sessionId } = await register()
      const browser = await join(sessionId)
      const buildId = insertBuild()
      const order: string[] = []
      agent.on('message', (data) => {
        const type = (JSON.parse(String(data)) as { type: string }).type
        if (type === 'app:logs:watch' || type === 'app:launch') order.push(type)
      })
      const launched = waitForType(agent, 'app:launch')
      browser.send(JSON.stringify({ type: 'app:launch', requestId: 'launch-1', sessionId, buildId }))
      await launched
      expect(order).toEqual(['app:logs:watch', 'app:launch'])
      agent.close(); browser.close()
    })

    it('ends the watch when the session ends', async () => {
      const { agent, sessionId } = await register()
      const browser = await join(sessionId)
      const watch = waitForType<AppLogsWatch>(agent, 'app:logs:watch')
      await install(agent, browser, sessionId)
      const { watchId } = await watch
      const unwatch = waitForType<AppLogsUnwatch>(agent, 'app:logs:unwatch')
      browser.send(JSON.stringify({ type: 'session:end', sessionId }))
      expect((await unwatch).watchId).toBe(watchId)
      agent.close(); browser.close()
    })
  })
})

