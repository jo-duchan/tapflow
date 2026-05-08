import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import type { RelayMessage } from '../types'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForMessage = (ws: WebSocket) =>
  new Promise<RelayMessage>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  )

describe('RelayServer', () => {
  let server: RelayServer
  let port: number

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
  })

  it('accepts WebSocket connections', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('registers an agent and returns a sessionId', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'agent:register' }))
    const msg = await waitForMessage(ws)
    expect(msg.type).toBe('agent:registered')
    expect(typeof msg.sessionId).toBe('string')
    ws.close()
  })

  it('allows a browser to join an agent session', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const msg = await waitForMessage(browser)
    expect(msg.type).toBe('session:joined')

    agent.close()
    browser.close()
  })

  it('routes input:tap from browser to agent', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const tapPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'input:tap', sessionId, payload: { x: 10, y: 20 } }))
    const tap = await tapPromise
    expect(tap.type).toBe('input:tap')
    expect(tap.payload).toEqual({ x: 10, y: 20 })

    agent.close()
    browser.close()
  })

  it('routes input:button from browser to agent', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const buttonPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'input:button', sessionId, payload: { name: 'leftButtonSideVolumeUp' } }))
    const btn = await buttonPromise
    expect(btn.type).toBe('input:button')
    expect(btn.payload).toEqual({ name: 'leftButtonSideVolumeUp' })

    agent.close()
    browser.close()
  })

  it('routes stream:frame from agent to browser', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const framePromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'stream:frame', payload: 'base64abc' }))
    const frame = await framePromise
    expect(frame.type).toBe('stream:frame')
    expect(frame.payload).toBe('base64abc')

    agent.close()
    browser.close()
  })

  it('returns error when joining a non-existent session', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId: 'bad-id' }))
    const msg = await waitForMessage(browser)
    expect(msg.type).toBe('error')
    browser.close()
  })

  it('returns agents list with devices', async () => {
    const devices = [{ id: 'd1', name: 'iPhone 15', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'agents:list' }))
    const msg = await waitForMessage(browser)

    expect(msg.type).toBe('agents:listed')
    expect(msg.sessions).toHaveLength(1)
    expect(msg.sessions![0].devices).toEqual(devices)

    agent.close()
    browser.close()
  })
})
