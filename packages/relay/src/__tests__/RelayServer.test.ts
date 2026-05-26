import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'
import { writeEnvelopeHeader, HEADER_SIZE } from '@tapflowio/agent-core/utils'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForMessage = (ws: WebSocket) =>
  new Promise<RelayMessage>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  )

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<RelayMessage>((resolve) => {
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === type) {
        ws.off('message', listener)
        resolve(msg)
      }
    }
    ws.on('message', listener)
  })

describe('RelayServer', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-test-'))
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

  it('accepts WebSocket connections', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('registers an agent with devices and returns registeredSessions', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'agent:register', devices }))
    const msg = await waitForMessage(ws)
    expect(msg.type).toBe('agent:registered')
    expect(msg.registeredSessions).toHaveLength(1)
    expect(msg.registeredSessions![0].deviceId).toBe('devA')
    expect(typeof msg.registeredSessions![0].sessionId).toBe('string')
    ws.close()
  })

  it('registers an agent with multiple devices — one sessionId per device', async () => {
    const devices = [
      { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
    ]
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'agent:register', devices }))
    const msg = await waitForMessage(ws)
    expect(msg.registeredSessions).toHaveLength(2)
    const ids = msg.registeredSessions!.map((s) => s.sessionId)
    expect(ids[0]).not.toBe(ids[1])
    ws.close()
  })

  it('allows a browser to join a device session', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const msg = await waitForMessage(browser)
    expect(msg.type).toBe('session:joined')

    agent.close()
    browser.close()
  })

  it('returns error when joining a non-existent session', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId: 'bad-id' }))
    const msg = await waitForMessage(browser)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Session not found')
    browser.close()
  })

  it('returns error when a second browser tries to join a busy session', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser1 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser1)
    browser1.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser1) // session:joined

    const browser2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser2)
    browser2.send(JSON.stringify({ type: 'session:start', sessionId }))
    const msg = await waitForMessage(browser2)
    expect(msg.type).toBe('error')
    expect(msg.message).toBe('Session busy')

    agent.close()
    browser1.close()
    browser2.close()
  })

  it('two browsers can use different device sessions concurrently', async () => {
    const devices = [
      { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
    ]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionA = registeredSessions!.find((s) => s.deviceId === 'devA')!.sessionId
    const sessionB = registeredSessions!.find((s) => s.deviceId === 'devB')!.sessionId

    const browserA = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browserA)
    browserA.send(JSON.stringify({ type: 'session:start', sessionId: sessionA }))
    const msgA = await waitForMessage(browserA)
    expect(msgA.type).toBe('session:joined')

    const browserB = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browserB)
    browserB.send(JSON.stringify({ type: 'session:start', sessionId: sessionB }))
    const msgB = await waitForMessage(browserB)
    expect(msgB.type).toBe('session:joined')

    agent.close()
    browserA.close()
    browserB.close()
  })

  it('routes input:touch:start from browser to agent', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

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

  it('input from browserA does not reach browserB session agent', async () => {
    const devices = [
      { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
    ]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionA = registeredSessions!.find((s) => s.deviceId === 'devA')!.sessionId
    const sessionB = registeredSessions!.find((s) => s.deviceId === 'devB')!.sessionId

    const browserA = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browserA)
    browserA.send(JSON.stringify({ type: 'session:start', sessionId: sessionA }))
    await waitForMessage(browserA)

    // Agent receives browserA's touch for sessionA
    const touchPromise = waitForType(agent, 'input:touch:start')
    browserA.send(JSON.stringify({ type: 'input:touch:start', sessionId: sessionA, payload: { x: 0.1, y: 0.2 } }))
    const touch = await touchPromise
    expect(touch.sessionId).toBe(sessionA)  // carries sessionA, not sessionB

    // A touch for sessionB should also route correctly when browser B joins
    const browserB = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browserB)
    browserB.send(JSON.stringify({ type: 'session:start', sessionId: sessionB }))
    await waitForMessage(browserB)

    const touch2Promise = waitForType(agent, 'input:touch:start')
    browserB.send(JSON.stringify({ type: 'input:touch:start', sessionId: sessionB, payload: { x: 0.9, y: 0.8 } }))
    const touch2 = await touch2Promise
    expect(touch2.sessionId).toBe(sessionB)

    agent.close()
    browserA.close()
    browserB.close()
  })

  it('routes device:boot from browser to agent', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const bootPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'devA' } }))
    const boot = await bootPromise
    expect(boot.type).toBe('device:boot')
    expect((boot.payload as { deviceId: string }).deviceId).toBe('devA')

    agent.close()
    browser.close()
  })

  it('routes device:booting and device:ready from agent to browser', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const bootingPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'device:booting', sessionId }))
    const booting = await bootingPromise
    expect(booting.type).toBe('device:booting')

    const readyPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    const ready = await readyPromise
    expect(ready.type).toBe('device:ready')
    expect((ready.payload as { deviceId: string }).deviceId).toBe('devA')

    agent.close()
    browser.close()
  })

  it('registers a stream socket and forwards binary frames to browser', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    browser.binaryType = 'nodebuffer'
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    // Stream WS connects and registers
    const streamWs = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(streamWs)
    streamWs.send(JSON.stringify({ type: 'stream:register', sessionId }))
    const ack = await waitForMessage(streamWs)
    expect(ack.type).toBe('stream:registered')

    // Binary frames sent via stream WS are forwarded to browser
    const framePromise = new Promise<Buffer>((r) =>
      browser.once('message', (d, isBinary) => { if (isBinary) r(d as Buffer) })
    )
    const frame = Buffer.from([0xff, 0xd8, 0xff]) // fake JPEG header
    streamWs.send(frame)
    const received = await framePromise
    expect(received).toEqual(frame)

    agent.close()
    browser.close()
    streamWs.close()
  })

  it('relay patches relayedAt in TFFE envelope frames and forwards to browser', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    browser.binaryType = 'nodebuffer'
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    const streamWs = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(streamWs)
    streamWs.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForMessage(streamWs) // stream:registered

    const capturedAt = Date.now() - 10
    const envelopedFrame = writeEnvelopeHeader(Buffer.from([0xFF, 0xD8]), capturedAt)

    const framePromise = new Promise<Buffer>((r) =>
      browser.once('message', (d, isBinary) => { if (isBinary) r(d as Buffer) })
    )
    const beforeSend = Date.now()
    streamWs.send(envelopedFrame)
    const received = await framePromise
    const afterSend = Date.now()

    expect(received.length).toBe(envelopedFrame.length)
    const relayedAt = Number(received.readBigUInt64BE(14))
    expect(relayedAt).toBeGreaterThanOrEqual(beforeSend)
    expect(relayedAt).toBeLessThanOrEqual(afterSend + 50)
    // payload bytes preserved
    expect(received.subarray(HEADER_SIZE)).toEqual(Buffer.from([0xFF, 0xD8]))

    agent.close()
    browser.close()
    streamWs.close()
  })

  it('relay forwards plain (non-envelope) binary frames unchanged', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    browser.binaryType = 'nodebuffer'
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    const streamWs = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(streamWs)
    streamWs.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForMessage(streamWs) // stream:registered

    const framePromise = new Promise<Buffer>((r) =>
      browser.once('message', (d, isBinary) => { if (isBinary) r(d as Buffer) })
    )
    const plain = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])
    streamWs.send(plain)
    const received = await framePromise
    expect(received).toEqual(plain)

    agent.close()
    browser.close()
    streamWs.close()
  })

  it('stream from devA does not reach browser of devB', async () => {
    const devices = [
      { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
    ]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionA = registeredSessions!.find((s) => s.deviceId === 'devA')!.sessionId
    const sessionB = registeredSessions!.find((s) => s.deviceId === 'devB')!.sessionId

    const browserA = new WebSocket(`ws://localhost:${port}`)
    browserA.binaryType = 'nodebuffer'
    await waitForOpen(browserA)
    browserA.send(JSON.stringify({ type: 'session:start', sessionId: sessionA }))
    await waitForMessage(browserA)

    const browserB = new WebSocket(`ws://localhost:${port}`)
    browserB.binaryType = 'nodebuffer'
    await waitForOpen(browserB)
    browserB.send(JSON.stringify({ type: 'session:start', sessionId: sessionB }))
    await waitForMessage(browserB)

    // Stream WS for devA
    const streamA = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(streamA)
    streamA.send(JSON.stringify({ type: 'stream:register', sessionId: sessionA }))
    await waitForMessage(streamA) // stream:registered

    // browserB should NOT receive frames from streamA
    let browserBGotBinary = false
    browserB.on('message', (_d, isBinary) => { if (isBinary) browserBGotBinary = true })

    const framePromise = new Promise<Buffer>((r) =>
      browserA.once('message', (d, isBinary) => { if (isBinary) r(d as Buffer) })
    )
    streamA.send(Buffer.from([0xaa, 0xbb]))
    const received = await framePromise
    expect(received).toEqual(Buffer.from([0xaa, 0xbb]))
    // The relay never sends this frame to browserB's session — so the flag stays false.
    // framePromise resolved means the relay has already processed the frame and forwarded
    // it exclusively to browserA. No further waiting needed.
    expect(browserBGotBinary).toBe(false)

    agent.close()
    browserA.close()
    browserB.close()
    streamA.close()
  })

  it('wsBackpressureBytes: 0 → binary frames are never forwarded to browser', async () => {
    // Use a fresh server with threshold=0 so bufferedAmount(0) >= threshold(0) is always true
    const strictServer = new RelayServer({ port: 0, wsBackpressureBytes: 0 })
    await strictServer.start()
    const strictPort = (strictServer.address() as { port: number }).port

    try {
      const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
      const agent = new WebSocket(`ws://localhost:${strictPort}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', devices }))
      const { registeredSessions } = await waitForMessage(agent)
      const sessionId = registeredSessions![0].sessionId

      const browser = new WebSocket(`ws://localhost:${strictPort}`)
      browser.binaryType = 'nodebuffer'
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForMessage(browser) // session:joined

      const streamWs = new WebSocket(`ws://localhost:${strictPort}`)
      await waitForOpen(streamWs)
      streamWs.send(JSON.stringify({ type: 'stream:register', sessionId }))
      await waitForMessage(streamWs) // stream:registered

      let binaryReceived = false
      browser.on('message', (_d, isBinary) => { if (isBinary) binaryReceived = true })

      streamWs.send(Buffer.from([0xff, 0xd8, 0xff]))
      // bufferedAmount(0) >= wsBackpressureBytes(0) → frame is dropped synchronously.
      // Wait for the relay's WS message handler to have run (real I/O tick).
      await new Promise<void>((r) => setImmediate(r))

      expect(binaryReceived).toBe(false)

      agent.close()
      browser.close()
      streamWs.close()
    } finally {
      await strictServer.stop()
    }
  })

  it('agents:listed groups devices by agent and includes sessionId per device', async () => {
    const devices = [
      { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
    ]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', agentName: 'MyMac', devices }))
    await waitForMessage(agent)

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'agents:list' }))
    const msg = await waitForMessage(browser)

    expect(msg.type).toBe('agents:listed')
    expect(msg.sessions).toHaveLength(1)
    expect(msg.sessions![0].agentName).toBe('MyMac')
    expect(msg.sessions![0].devices).toHaveLength(2)
    expect(msg.sessions![0].devices[0].sessionId).toBeTruthy()
    expect(msg.sessions![0].devices[1].sessionId).toBeTruthy()
    expect(msg.sessions![0].devices[0].busy).toBe(false)

    agent.close()
    browser.close()
  })

  it('agents:listed shows busy=true after browser joins a device session', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    observer.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForMessage(observer)
    expect(listed.sessions![0].devices[0].busy).toBe(true)

    agent.close()
    browser.close()
    observer.close()
  })

  it('removes all device sessions when agent disconnects', async () => {
    const devices = [
      { id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' },
      { id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' },
    ]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    await waitForMessage(agent)
    agent.close()

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    await vi.waitFor(async () => {
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)
      expect(listed.sessions).toHaveLength(0)
    }, { timeout: 2000 })
    observer.close()
  })

  it('agent:resources is reflected in agents:listed', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac1', devices: [{ id: 'd1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
    await waitForMessage(agent)

    agent.send(JSON.stringify({
      type: 'agent:resources',
      resources: { cpuPercent: 25, memUsedMB: 4096, memTotalMB: 16384, slotsAvailable: 2, slotsTotal: 3, reportedAt: 1000 },
    }))

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    await vi.waitFor(async () => {
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)
      expect(listed.sessions![0].resources?.cpuPercent).toBe(25)
      expect(listed.sessions![0].resources?.slotsTotal).toBe(3)
    }, { timeout: 500 })

    agent.close()
    observer.close()
  })

  it('agent resources are cleared after agent disconnects', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac1', devices: [{ id: 'd1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
    await waitForMessage(agent)
    agent.send(JSON.stringify({
      type: 'agent:resources',
      resources: { cpuPercent: 50, memUsedMB: 8000, memTotalMB: 16000, slotsAvailable: 3, slotsTotal: 3, reportedAt: 1000 },
    }))
    agent.close()

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    await vi.waitFor(async () => {
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)
      expect(listed.sessions).toHaveLength(0)
    }, { timeout: 2000 })

    observer.close()
  })

  describe('mock-agent — 다중 agent 등록·자원 보고', () => {
    it('두 mock agent가 독립적으로 등록되어 agents:listed에 각각 표시됨', async () => {
      const agentA = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentA)
      agentA.send(JSON.stringify({
        type: 'agent:register',
        agentName: 'Mac-A',
        devices: [
          { id: 'a1', name: 'iPhone A1', platform: 'ios', status: 'shutdown' },
          { id: 'a2', name: 'iPhone A2', platform: 'ios', status: 'shutdown' },
        ],
      }))
      await waitForMessage(agentA)

      const agentB = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentB)
      agentB.send(JSON.stringify({
        type: 'agent:register',
        agentName: 'Mac-B',
        devices: [{ id: 'b1', name: 'iPhone B1', platform: 'ios', status: 'shutdown' }],
      }))
      await waitForMessage(agentB)

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessions = listed.sessions as any[]
      expect(sessions).toHaveLength(2)
      const macA = sessions.find((s) => s.agentName === 'Mac-A')
      const macB = sessions.find((s) => s.agentName === 'Mac-B')
      expect(macA.devices).toHaveLength(2)
      expect(macB.devices).toHaveLength(1)

      agentA.close()
      agentB.close()
      observer.close()
    })

    it('각 agent의 resources가 agents:listed에 독립적으로 반영됨', async () => {
      const agentA = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentA)
      agentA.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac-A', devices: [{ id: 'a1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agentA)
      agentA.send(JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 30, memUsedMB: 4000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: 1000 } }))

      const agentB = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentB)
      agentB.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac-B', devices: [{ id: 'b1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agentB)
      agentB.send(JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 70, memUsedMB: 12000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: 1000 } }))

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      await vi.waitFor(async () => {
        observer.send(JSON.stringify({ type: 'agents:list' }))
        const listed = await waitForMessage(observer)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessions = listed.sessions as any[]
        const macA = sessions.find((s: { agentName: string }) => s.agentName === 'Mac-A')
        const macB = sessions.find((s: { agentName: string }) => s.agentName === 'Mac-B')
        expect(macA?.resources?.cpuPercent).toBe(30)
        expect(macB?.resources?.cpuPercent).toBe(70)
      }, { timeout: 500 })

      agentA.close()
      agentB.close()
      observer.close()
    })

    it('한 agent 종료 시 해당 agent 세션만 제거됨', async () => {
      const agentA = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentA)
      agentA.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac-A', devices: [{ id: 'a1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agentA)

      const agentB = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentB)
      agentB.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac-B', devices: [{ id: 'b1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agentB)

      agentA.close()

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      await vi.waitFor(async () => {
        observer.send(JSON.stringify({ type: 'agents:list' }))
        const listed = await waitForMessage(observer)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessions = listed.sessions as any[]
        expect(sessions).toHaveLength(1)
        expect(sessions[0].agentName).toBe('Mac-B')
      }, { timeout: 2000 })

      agentB.close()
      observer.close()
    })
  })

  it('browser disconnect starts idle timer — agent receives device:shutdown after timeout', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 20 })
    try {
      await shortServer.start()
      const shortPort = (shortServer.address() as { port: number }).port

      const agent = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', devices: [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }] }))
      const { registeredSessions } = await waitForMessage(agent)
      const sessionId = registeredSessions![0].sessionId

      const browser = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForMessage(browser) // session:joined

      const shutdownPromise = waitForType(agent, 'device:shutdown')
      browser.close()

      const shutdown = await shutdownPromise
      expect(shutdown.type).toBe('device:shutdown')
      expect(shutdown.sessionId).toBe(sessionId)

      agent.close()
    } finally {
      await shortServer.stop()
    }
  })

  it('browser reconnect before timeout cancels shutdown', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 200 })
    try {
      await shortServer.start()
      const shortPort = (shortServer.address() as { port: number }).port

      const agent = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', devices: [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }] }))
      const { registeredSessions } = await waitForMessage(agent)
      const sessionId = registeredSessions![0].sessionId

      const browser = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForMessage(browser)

      browser.close()
      // yield to event loop so relay receives close event and sets idle timer
      await new Promise<void>((r) => setImmediate(r))

      const browser2 = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(browser2)
      browser2.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForMessage(browser2) // session:joined — relay cancels idle timer

      // If shutdown arrives at any point during the wait, fail immediately
      await new Promise<void>((resolve, reject) => {
        setTimeout(resolve, 600)
        agent.on('message', (d) => {
          if (JSON.parse(d.toString()).type === 'device:shutdown')
            reject(new Error('unexpected device:shutdown — idle timer was not cancelled'))
        })
      })

      agent.close()
      browser2.close()
    } finally {
      await shortServer.stop()
    }
  })

  it('idle timeout after agent already disconnected — no error thrown', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 20 })
    try {
      await shortServer.start()
      const shortPort = (shortServer.address() as { port: number }).port

      const agent = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', devices: [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }] }))
      const { registeredSessions } = await waitForMessage(agent)
      const sessionId = registeredSessions![0].sessionId

      const browser = new WebSocket(`ws://localhost:${shortPort}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForMessage(browser)

      // Agent closes first → all sessions removed. Browser closes → idle timer set on now-removed session.
      agent.close()
      browser.close()
      // Wait past idleTimeoutMs — timer callback must not throw even when session is gone
      await new Promise<void>((r) => setTimeout(r, 100))
    } finally {
      await shortServer.stop()
    }
  })

  it('replays device:ready on reconnect when device is already booted', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser) // session:joined

    // Agent reports device is ready
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    await waitForType(browser, 'device:ready')

    browser.close()
    // Poll until relay has cleared browser from session (busy=false)
    // so the replay logic correctly re-sends device:ready to browser2
    const tmpObs = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(tmpObs)
    await vi.waitFor(async () => {
      tmpObs.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(tmpObs)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((listed.sessions as any[])[0].devices[0].busy).toBe(false)
    }, { timeout: 2000 })
    tmpObs.close()

    // Browser reconnects — set up both listeners before sending to avoid race
    const browser2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser2)
    const joinedPromise = waitForType(browser2, 'session:joined')
    const readyPromise = waitForType(browser2, 'device:ready')
    browser2.send(JSON.stringify({ type: 'session:start', sessionId }))
    await joinedPromise
    await readyPromise

    agent.close()
    browser2.close()
  })

  it('routes open-url from browser to agent', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const msgPromise = waitForMessage(agent)
    browser.send(JSON.stringify({ type: 'open-url', sessionId, payload: { url: 'myapp://home' } }))
    const received = await msgPromise
    expect(received.type).toBe('open-url')
    expect((received.payload as { url: string }).url).toBe('myapp://home')

    agent.close()
    browser.close()
  })

  it('routes open-url:done from agent to browser', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const msgPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'open-url:done', sessionId }))
    const received = await msgPromise
    expect(received.type).toBe('open-url:done')

    agent.close()
    browser.close()
  })

  it('routes open-url:error from agent to browser', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    const msgPromise = waitForMessage(browser)
    agent.send(JSON.stringify({ type: 'open-url:error', sessionId, message: 'URL handler not found' }))
    const received = await msgPromise
    expect(received.type).toBe('open-url:error')
    expect(received.message).toBe('URL handler not found')

    agent.close()
    browser.close()
  })

  it('returns open-url:error to browser when session does not exist', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)

    const msgPromise = waitForMessage(browser)
    browser.send(JSON.stringify({ type: 'open-url', sessionId: 'nonexistent-session', payload: { url: 'myapp://home' } }))
    const received = await msgPromise
    expect(received.type).toBe('open-url:error')
    expect(received.message).toBe('agent offline')

    browser.close()
  })

  it('returns open-url:error to browser when agent socket is closed', async () => {
    const devices = [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }]
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const { registeredSessions } = await waitForMessage(agent)
    const sessionId = registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser)

    agent.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const msgPromise = waitForMessage(browser)
    browser.send(JSON.stringify({ type: 'open-url', sessionId, payload: { url: 'myapp://home' } }))
    const received = await msgPromise
    expect(received.type).toBe('open-url:error')
    expect(received.message).toBe('agent offline')

    browser.close()
  })

  describe('stop', () => {
    let stopServer: RelayServer

    beforeEach(async () => {
      stopServer = new RelayServer({ port: 0 })
      await stopServer.start()
    })

    it('clears all interval timers', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      await stopServer.stop()
      expect(clearSpy).toHaveBeenCalledTimes(4)
      clearSpy.mockRestore()
    })
  })
})
