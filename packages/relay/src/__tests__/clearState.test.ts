import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<RelayMessage>((resolve) => {
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === type) {
        ws.off('message', listener)
        resolve(msg)
      }
    }
    ws.on('message', listener)
  })

describe('app:clear-state relay routing', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-clearstate-test-'))
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

  async function setup() {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  it('forwards app:clear-state to the agent and the done reply back to the browser', async () => {
    const { agent, browser, sessionId } = await setup()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'app:clear-state') {
        expect((msg.payload as { bundleId: string }).bundleId).toBe('com.example.app')
        agent.send(JSON.stringify({ type: 'app:clear-state-done', sessionId: msg.sessionId }))
      }
    })

    browser.send(JSON.stringify({ type: 'app:clear-state', sessionId, payload: { bundleId: 'com.example.app' } }))
    const done = await waitForType(browser, 'app:clear-state-done')
    expect(done.sessionId).toBe(sessionId)

    agent.close()
    browser.close()
  })

  it('forwards the error reply back to the browser', async () => {
    const { agent, browser, sessionId } = await setup()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'app:clear-state') {
        agent.send(JSON.stringify({ type: 'app:clear-state-error', sessionId: msg.sessionId, message: 'pm clear failed' }))
      }
    })

    browser.send(JSON.stringify({ type: 'app:clear-state', sessionId, payload: { bundleId: 'x' } }))
    const err = await waitForType(browser, 'app:clear-state-error')
    expect(err.message).toBe('pm clear failed')

    agent.close()
    browser.close()
  })

  it('replies app:clear-state-error immediately when the agent is offline', async () => {
    const { agent, browser, sessionId } = await setup()
    agent.close()
    await new Promise((r) => setTimeout(r, 50))

    // the agent socket close may have already removed the session — either way
    // the browser must get an explicit error, never a hang
    browser.send(JSON.stringify({ type: 'app:clear-state', sessionId, payload: { bundleId: 'x' } }))
    const raced = await Promise.race([
      waitForType(browser, 'app:clear-state-error'),
      new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
    ])
    expect(raced).not.toBeNull()

    browser.close()
  })

  it('a browser socket cannot spoof app:clear-state-done (agent-only → 1008 close)', async () => {
    const { agent, browser, sessionId } = await setup()

    const closed = new Promise<number>((resolve) => browser.on('close', (code) => resolve(code)))
    browser.send(JSON.stringify({ type: 'app:clear-state-done', sessionId }))
    expect(await closed).toBe(1008)

    agent.close()
  })

  it('forwards input:type-done/error from the agent back to the browser', async () => {
    const { agent, browser, sessionId } = await setup()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'input:type') {
        agent.send(JSON.stringify({ type: 'input:type-done', sessionId: msg.sessionId }))
      }
    })

    browser.send(JSON.stringify({ type: 'input:type', sessionId, payload: { text: 'hi' } }))
    const done = await waitForType(browser, 'input:type-done')
    expect(done.sessionId).toBe(sessionId)

    agent.close()
    browser.close()
  })

  it('a browser socket cannot spoof input:type-done (agent-only → 1008 close)', async () => {
    const { agent, browser, sessionId } = await setup()

    const closed = new Promise<number>((resolve) => browser.on('close', (code) => resolve(code)))
    browser.send(JSON.stringify({ type: 'input:type-done', sessionId }))
    expect(await closed).toBe(1008)

    agent.close()
  })
})
