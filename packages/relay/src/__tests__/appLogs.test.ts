import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { closeDb, initDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, BrowserInbound } from '@tapflowio/protocol'

describe('app log routing', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-app-logs-'))
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
})
