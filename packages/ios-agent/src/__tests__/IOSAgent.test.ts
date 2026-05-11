import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../TouchHelper', () => ({
  TouchHelper: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    touchStart: vi.fn(),
    touchMove: vi.fn(),
    touchEnd: vi.fn(),
    pressButton: vi.fn(),
    pressLegacyButton: vi.fn(),
    pinchStart: vi.fn(),
    pinchMove: vi.fn(),
    pinchEnd: vi.fn(),
    sendKey: vi.fn(),
  })),
}))

vi.mock('../SimctlRecorder', () => ({
  SimctlRecorder: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue('/tmp/tapflow-recordings/test.mov'),
    cleanup: vi.fn(),
    isRecording: vi.fn().mockReturnValue(false),
  })),
}))

import { WebSocket } from 'ws'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent } from '../IOSAgent'
import { SimctlWrapper } from '../SimctlWrapper'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { TouchHelper } from '../TouchHelper'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SimctlRecorder } from '../SimctlRecorder'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockTouchHelper = TouchHelper as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockSimctlRecorder = SimctlRecorder as any

// HID usage codes from KeyCodeMap (duplicated here so tests are self-contained)
const HID_BACKSPACE = 0x2A
const HID_KEY_A = 0x04

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((r) => ws.once('open', r))

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<Record<string, unknown>>((r) => {
    const listener = (d: Buffer) => {
      try {
        const msg = JSON.parse(d.toString())
        if (msg.type === type) {
          ws.off('message', listener)
          r(msg)
        }
      } catch { /* binary frame — ignore */ }
    }
    ws.on('message', listener)
  })

function mockSimctl(booted = false): SimctlWrapper {
  return {
    listDevices: vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: booted ? 'booted' : 'shutdown', osVersion: 'iOS 18.3' },
    ]),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    syncKeyboardsFromLanguages: vi.fn().mockResolvedValue(undefined),
  } as unknown as SimctlWrapper
}

describe('IOSAgent', () => {
  let relay: RelayServer
  let port: number

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 })
    await relay.start()
    port = (relay.address() as { port: number }).port
  })

  afterEach(async () => {
    await relay.stop()
  })

  describe('DeviceAgent delegation', () => {
    it('listDevices delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      const devices = await agent.listDevices()
      expect(simctl.listDevices).toHaveBeenCalled()
      expect(devices[0].platform).toBe('ios')
    })

    it('boot delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.boot('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
    })

    it('shutdown delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.shutdown('dev-1')
      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
    })

    it('installApp delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.installApp('/path/App.ipa')
      expect(simctl.installApp).toHaveBeenCalledWith('/path/App.ipa')
    })

    it('launchApp delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.launchApp('com.example.app')
      expect(simctl.launchApp).toHaveBeenCalledWith('com.example.app')
    })
  })

  describe('pinch relay messages', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupPinchSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:pinch:start calls touchHelper.pinchStart', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({
        type: 'input:pinch:start',
        sessionId: agent.sessionId,
        payload: { f0: { x: 0.3, y: 0.5 }, f1: { x: 0.7, y: 0.5 } },
      }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.pinchStart).toHaveBeenCalledWith(0.3, 0.5, 0.7, 0.5)
      agent.disconnect()
      browser.close()
    })

    it('input:pinch:move calls touchHelper.pinchMove', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({
        type: 'input:pinch:move',
        sessionId: agent.sessionId,
        payload: { f0: { x: 0.2, y: 0.5 }, f1: { x: 0.8, y: 0.5 } },
      }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.pinchMove).toHaveBeenCalledWith(0.2, 0.5, 0.8, 0.5)
      agent.disconnect()
      browser.close()
    })

    it('input:pinch:end calls touchHelper.pinchEnd', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:pinch:end', sessionId: agent.sessionId }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.pinchEnd).toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })
  })

  describe('device:boot handler', () => {
    it('sends device:booting then device:ready for a shutdown device', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const bootingPromise = waitForType(browser, 'device:booting')
      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))

      await bootingPromise
      const ready = await readyPromise
      expect((ready.payload as { deviceId: string }).deviceId).toBe('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('skips boot call for already-booted device', async () => {
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise
      expect(simctl.boot).not.toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })
  })

  describe('agent:register', () => {
    it('includes osVersion in register payload', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      const agentsListedPromise = waitForType(browser, 'agents:listed')
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await agentsListedPromise

      const sessions = listed.sessions as Array<{ devices: Array<{ osVersion?: string }> }>
      expect(sessions[0]?.devices[0]?.osVersion).toBe('iOS 18.3')

      agent.disconnect()
      browser.close()
    })

    it('agents:listed includes sessionId per device', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')

      const sessions = listed.sessions as Array<{ devices: Array<{ sessionId?: string }> }>
      expect(typeof sessions[0]?.devices[0]?.sessionId).toBe('string')
      expect(sessions[0].devices[0].sessionId).toBe(agent.sessionId)

      agent.disconnect()
      browser.close()
    })
  })

  describe('relay connection', () => {
    it('connects to relay and receives a sessionId', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      expect(agent.sessionId).toBeDefined()
      agent.disconnect()
    })

    it('forwards binary frame to browser via stream WS after connecting', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      browser.binaryType = 'nodebuffer'
      await waitForOpen(browser)

      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const frame = await new Promise<Buffer>((r) =>
        browser.once('message', (d, isBinary) => { if (isBinary) r(d as Buffer) })
      )
      expect(frame.length).toBeGreaterThan(0)

      agent.disconnect()
      browser.close()
    })
  })

  describe('input:key handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:key Backspace calls touchHelper.sendKey with HID usage 0x2A', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'Backspace', modifiers: 0 } }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.sendKey).toHaveBeenCalledWith(HID_BACKSPACE, 0)
      agent.disconnect()
      browser.close()
    })

    it('input:key KeyA calls touchHelper.sendKey with HID usage 0x04', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      agent.disconnect()
      browser.close()
    })

    it('input:key with Shift modifier forwards modifier bits', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0x02 } }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0x02)
      agent.disconnect()
      browser.close()
    })

    it('input:key unknown code is silently dropped', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'UnknownKey', modifiers: 0 } }))
      await new Promise((r) => setTimeout(r, 50))
      expect(thInstance.sendKey).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })
  })

  describe('record:start / record:stop handler', () => {
    async function setupRecordSession() {
      MockSimctlRecorder.mockClear()
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      const recInstance = MockSimctlRecorder.mock.results[0].value
      return { browser, agent, recInstance }
    }

    it('record:start calls recorder.start with deviceId', async () => {
      const { browser, agent, recInstance } = await setupRecordSession()
      browser.send(JSON.stringify({ type: 'record:start', sessionId: agent.sessionId }))
      await new Promise((r) => setTimeout(r, 50))
      expect(recInstance.start).toHaveBeenCalledWith('dev-1')
      agent.disconnect()
      browser.close()
    })

    it('record:start when already recording sends record:error', async () => {
      const { browser, agent, recInstance } = await setupRecordSession()
      recInstance.isRecording.mockReturnValue(true)
      const errorPromise = waitForType(browser, 'record:error')
      browser.send(JSON.stringify({ type: 'record:start', sessionId: agent.sessionId }))
      const err = await errorPromise
      expect(err.type).toBe('record:error')
      agent.disconnect()
      browser.close()
    })
  })
})
