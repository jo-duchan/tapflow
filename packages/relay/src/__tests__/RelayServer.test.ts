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

  it('routes input:touch:start from browser to agent', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const touchPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.5 } }))
    const touch = await touchPromise
    expect(touch.type).toBe('input:touch:start')
    expect(touch.payload).toEqual({ x: 0.5, y: 0.5 })

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

  it('routes webrtc:offer from agent to browser', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    const offerPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'webrtc:offer', payload: { sdp: 'offer-sdp', type: 'offer' } }))
    const offer = await offerPromise
    expect(offer.type).toBe('webrtc:offer')
    expect((offer.payload as { sdp: string }).sdp).toBe('offer-sdp')

    agent.close()
    browser.close()
  })

  it('routes webrtc:answer from browser to agent', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const answerPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'webrtc:answer', sessionId, payload: { sdp: 'answer-sdp', type: 'answer' } }))
    const answer = await answerPromise
    expect(answer.type).toBe('webrtc:answer')
    expect((answer.payload as { sdp: string }).sdp).toBe('answer-sdp')

    agent.close()
    browser.close()
  })

  it('routes webrtc:ice bidirectionally', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    // agent → browser
    const iceFromAgentPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'webrtc:ice', payload: { candidate: 'agent-ice' } }))
    const iceFromAgent = await iceFromAgentPromise
    expect(iceFromAgent.type).toBe('webrtc:ice')
    expect((iceFromAgent.payload as { candidate: string }).candidate).toBe('agent-ice')

    // browser → agent
    const iceFromBrowserPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'webrtc:ice', payload: { candidate: 'browser-ice' } }))
    const iceFromBrowser = await iceFromBrowserPromise
    expect(iceFromBrowser.type).toBe('webrtc:ice')
    expect((iceFromBrowser.payload as { candidate: string }).candidate).toBe('browser-ice')

    agent.close()
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

  it('includes agentName and busy in agents:listed', async () => {
    const devices = [{ id: 'd1', name: 'iPhone 15', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', agentName: 'MyMac', devices }))
    const { sessionId } = await waitForMessage(agent)

    // not busy yet
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForMessage(browser)
    expect(listed.sessions![0].agentName).toBe('MyMac')
    expect(listed.sessions![0].busy).toBe(false)

    // join → becomes busy
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    const browser2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser2)
    browser2.send(JSON.stringify({ type: 'agents:list' }))
    const listed2 = await waitForMessage(browser2)
    expect(listed2.sessions![0].busy).toBe(true)

    agent.close()
    browser.close()
    browser2.close()
  })

  it('routes device:boot from browser to agent', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const bootPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'dev-1' } }))
    const boot = await bootPromise
    expect(boot.type).toBe('device:boot')
    expect((boot.payload as { deviceId: string }).deviceId).toBe('dev-1')

    agent.close()
    browser.close()
  })

  it('routes device:booting and device:ready from agent to browser', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register' }))
    const { sessionId } = await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const bootingPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'device:booting' }))
    const booting = await bootingPromise
    expect(booting.type).toBe('device:booting')

    const readyPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'device:ready', payload: { deviceId: 'dev-1' } }))
    const ready = await readyPromise
    expect(ready.type).toBe('device:ready')
    expect((ready.payload as { deviceId: string }).deviceId).toBe('dev-1')

    agent.close()
    browser.close()
  })
})
