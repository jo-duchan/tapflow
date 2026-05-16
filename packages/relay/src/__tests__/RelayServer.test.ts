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
    await new Promise((r) => setTimeout(r, 20))
    expect(browserBGotBinary).toBe(false)

    agent.close()
    browserA.close()
    browserB.close()
    streamA.close()
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

    // Wait for close to propagate
    await new Promise((r) => setTimeout(r, 50))

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    observer.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForMessage(observer)
    expect(listed.sessions).toHaveLength(0)

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
    await new Promise((r) => setTimeout(r, 10))

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    observer.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForMessage(observer)
    expect(listed.sessions![0].resources?.cpuPercent).toBe(25)
    expect(listed.sessions![0].resources?.slotsTotal).toBe(3)

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
    await new Promise((r) => setTimeout(r, 10))
    agent.close()
    await new Promise((r) => setTimeout(r, 50))

    const observer = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(observer)
    observer.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForMessage(observer)
    expect(listed.sessions).toHaveLength(0)

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
      agentA.send(JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 30, memUsedMB: 4000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: Date.now() } }))

      const agentB = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentB)
      agentB.send(JSON.stringify({ type: 'agent:register', agentName: 'Mac-B', devices: [{ id: 'b1', name: 'iPhone', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agentB)
      agentB.send(JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 70, memUsedMB: 12000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: Date.now() } }))

      await new Promise((r) => setTimeout(r, 20))

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessions = listed.sessions as any[]
      const macA = sessions.find((s) => s.agentName === 'Mac-A')
      const macB = sessions.find((s) => s.agentName === 'Mac-B')
      expect(macA.resources?.cpuPercent).toBe(30)
      expect(macB.resources?.cpuPercent).toBe(70)

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
      await new Promise((r) => setTimeout(r, 50))

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessions = listed.sessions as any[]
      expect(sessions).toHaveLength(1)
      expect(sessions[0].agentName).toBe('Mac-B')

      agentB.close()
      observer.close()
    })
  })

  it('browser disconnect starts idle timer — agent receives device:shutdown after timeout', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 80 })
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
    await shortServer.stop()
  })

  it('browser reconnect before timeout cancels shutdown', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 200 })
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

    // Disconnect and immediately reconnect (within timeout)
    browser.close()
    await new Promise((r) => setTimeout(r, 40))

    const browser2 = new WebSocket(`ws://localhost:${shortPort}`)
    await waitForOpen(browser2)
    browser2.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForMessage(browser2) // session:joined

    // Wait past the original timeout — no shutdown should arrive
    let gotShutdown = false
    agent.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.type === 'device:shutdown') gotShutdown = true
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(gotShutdown).toBe(false)

    agent.close()
    browser2.close()
    await shortServer.stop()
  })

  it('idle timeout after agent already disconnected — no error thrown', async () => {
    const shortServer = new RelayServer({ port: 0, idleTimeoutMs: 80 })
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

    // Both close — agent first
    agent.close()
    browser.close()

    // Wait past timeout — no crash expected
    await new Promise((r) => setTimeout(r, 150))
    await shortServer.stop()
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
    await new Promise((r) => setTimeout(r, 30))

    // Browser reconnects
    const browser2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser2)
    browser2.send(JSON.stringify({ type: 'session:start', sessionId }))
    const msgs: string[] = []
    await new Promise<void>((resolve) => {
      let received = 0
      browser2.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        msgs.push(msg.type)
        received++
        if (received >= 2) resolve()
      })
      setTimeout(resolve, 200)
    })
    expect(msgs).toContain('session:joined')
    expect(msgs).toContain('device:ready')

    agent.close()
    browser2.close()
  })
})
