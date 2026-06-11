import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ValidationError } from '@tapflowio/agent-core'

vi.mock('../TouchHelper', () => ({
  TouchHelper: vi.fn(function () { return ({
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
  }) }),
}))

// Mock the capture streamer so codec-negotiation tests can read the codec arg the
// agent picked, without spawning the real helper binary. start() returns a stream
// that never closes — mirroring a live capture and avoiding the pump's restart loop.
vi.mock('../ScreenCaptureStreamer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ScreenCaptureStreamer')>()
  return {
    ...actual,
    ScreenCaptureStreamer: vi.fn(function () { return ({
      start: () => new ReadableStream({ start() {} }),
      requestKeyframe: vi.fn(),
    }) }),
  }
})

import { WebSocket } from 'ws'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { IOSAgent } from '../IOSAgent'
import { ScreenCaptureStreamer } from '../ScreenCaptureStreamer'
import { SimctlWrapper } from '../SimctlWrapper'
import { TouchHelper } from '../TouchHelper'
const MockTouchHelper = vi.mocked(TouchHelper)

// Test-only view of IOSAgent internals (reconnect state lives behind private fields).
interface IOSAgentInternals {
  ws: WebSocket | null
  _stopping: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempt: number
  _scheduleReconnect(): void
}
const internals = (agent: IOSAgent): IOSAgentInternals => agent as unknown as IOSAgentInternals

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
    erase: vi.fn().mockResolvedValue(undefined),
    uninstallApp: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    syncKeyboardsFromLanguages: vi.fn().mockResolvedValue(undefined),
    showSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    hideSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    stopKeyboardDaemon: vi.fn(),
  } as unknown as SimctlWrapper
}

describe('IOSAgent', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ios-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

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
      await agent.installApp('/path/MyApp.app')
      expect(simctl.installApp).toHaveBeenCalledWith('/path/MyApp.app')
    })

    it('launchApp delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.launchApp('com.example.app')
      expect(simctl.launchApp).toHaveBeenCalledWith('com.example.app')
    })

    it('stream throws ValidationError before any device session is available', () => {
      const agent = new IOSAgent({}, mockSimctl())
      expect(() => agent.stream()).toThrow(ValidationError)
    })
  })

  describe('power assertion', () => {
    it('acquires on connect and releases on disconnect', async () => {
      const sleepBlocker = { acquire: vi.fn(), release: vi.fn() }
      const agent = new IOSAgent({ sleepBlocker }, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      expect(sleepBlocker.acquire).toHaveBeenCalled()
      expect(sleepBlocker.release).not.toHaveBeenCalled()
      agent.disconnect()
      expect(sleepBlocker.release).toHaveBeenCalled()
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

      // device:ready is sent after TouchHelper is created, but the mock recording
      // occasionally lags a microtask behind the message delivery — wait explicitly
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
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
      await vi.waitFor(() => expect(thInstance.pinchStart).toHaveBeenCalledWith(0.3, 0.5, 0.7, 0.5), { timeout: 500 })
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
      await vi.waitFor(() => expect(thInstance.pinchMove).toHaveBeenCalledWith(0.2, 0.5, 0.8, 0.5), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:pinch:end calls touchHelper.pinchEnd', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:pinch:end', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(thInstance.pinchEnd).toHaveBeenCalled(), { timeout: 500 })
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

    it('calls erase then boot when resetMode=full-erase', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
      // erase must precede boot
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    it('does not call erase when resetMode is omitted', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).not.toHaveBeenCalled()
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

    it('erases then retries boot when the device data is missing on disk (zombie auto-recovery)', async () => {
      const simctl = mockSimctl(false)
      let bootCalls = 0
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        bootCalls += 1
        if (bootCalls === 1) {
          throw new Error("Unable to boot device because it cannot be located on disk. The device's data is no longer present")
        }
      })
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise

      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      expect(simctl.boot).toHaveBeenCalledTimes(2)
      // erase must happen between the failed boot and the successful retry
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const retryBootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!
      expect(eraseOrder).toBeLessThan(retryBootOrder)

      agent.disconnect()
      browser.close()
    })

    it('never erases on an unrelated boot failure (protects healthy devices)', async () => {
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('operation timed out'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errPromise = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const err = await errPromise

      expect(simctl.erase).not.toHaveBeenCalled()
      expect(err.message as string).toContain('operation timed out')

      agent.disconnect()
      browser.close()
    })

    it('reports boot-error without looping when erase recovery still fails', async () => {
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cannot be located on disk'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errPromise = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await errPromise

      // exactly one erase + one retry — bounded, no infinite loop
      expect(simctl.erase).toHaveBeenCalledTimes(1)
      expect(simctl.boot).toHaveBeenCalledTimes(2)

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

      // Register before device:boot — MjpegStreamer emits the first frame immediately
      // after device:ready; registering after waitForType risks missing it
      const framePromise = new Promise<Buffer>((r) =>
        browser.on('message', function listener(d, isBinary) {
          if (isBinary) {
            browser.off('message', listener)
            r(d as Buffer)
          }
        })
      )

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const frame = await framePromise
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
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:key Backspace calls touchHelper.sendKey with HID usage 0x2A', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'Backspace', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_BACKSPACE, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key KeyA calls touchHelper.sendKey with HID usage 0x04', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key with Shift modifier forwards modifier bits', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0x02 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0x02), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key unknown code is silently dropped', async () => {
      const { browser, agent, thInstance } = await setupSession()
      // Send unknown key first, then a known key as a sentinel.
      // WebSocket messages are ordered — when KeyA is processed, UnknownKey was already processed.
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'UnknownKey', modifiers: 0 } }))
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledTimes(1), { timeout: 500 })
      expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      agent.disconnect()
      browser.close()
    })
  })

  describe('input:keyboard:toggle handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupSession(sim = mockSimctl(true)) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, sim)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { browser, agent, sim }
    }

    it('첫 토글 시 showSoftwareKeyboard를 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('두 번째 토글 시 hideSoftwareKeyboard를 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1), { timeout: 500 })
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })

    it('토글 성공 시 keyboard:toggled ACK를 dashboard로 송신한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      const ack = await waitForType(browser, 'keyboard:toggled')
      expect(ack.payload).toEqual({ visible: true })
      // second toggle: visible becomes false
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      const ack2 = await waitForType(browser, 'keyboard:toggled')
      expect(ack2.payload).toEqual({ visible: false })
      agent.disconnect()
      browser.close()
    })

    it('토글 실패 시 state가 롤백되고 ACK가 오지 않는다', async () => {
      const sim = mockSimctl(true)
      ;(sim.showSoftwareKeyboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('helper failed'))
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1), { timeout: 500 })
      // state should remain false (no visible=true ACK)
      // next toggle should call show again (not hide), confirming state stayed false
      ;(sim.showSoftwareKeyboard as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(2), { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('input:key 수신 시 SW 켜져 있으면 hideSoftwareKeyboard를 먼저 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      // show keyboard first
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      // hardware key press → hide must be called before sendKey
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(sim.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      await vi.waitFor(() => {
        expect(MockTouchHelper.mock.results[0].value.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      }, { timeout: 500 })
      // next toggle should show (state was reset to false by the key press)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(2), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key 수신 시 SW 꺼져 있으면 hideSoftwareKeyboard를 호출하지 않는다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => {
        const thInstance = MockTouchHelper.mock.results[0].value
        return expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      }, { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })
  })

  describe('reconnect', () => {
    it('disconnect() sets _stopping and cancels pending reconnect timer', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._reconnectTimer = setTimeout(() => {}, 10000)

      agent.disconnect()

      expect(internals(agent)._stopping).toBe(true)
      expect(internals(agent)._reconnectTimer).toBeNull()
    })

    it('_scheduleReconnect() is no-op when _stopping is true', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._stopping = true
      internals(agent)._scheduleReconnect()

      expect(internals(agent)._reconnectTimer).toBeNull()
      expect(internals(agent)._reconnectAttempt).toBe(0)

      agent.disconnect()
    })

    it('reconnects automatically when connection drops and relay is available', async () => {
      const agent = new IOSAgent({ reconnectDelays: [0] }, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const oldWs = internals(agent).ws!
      oldWs.terminate()

      await vi.waitFor(() => {
        const ws = internals(agent).ws
        expect(ws).not.toBeNull()
        expect(ws).not.toBe(oldWs)       // 새 연결 객체여야 함
        expect(ws!.readyState).toBe(WebSocket.OPEN)
      }, { timeout: 2000 })

      agent.disconnect()
    })
  })

  // Codec negotiation: H.264 only when the agent opts in (env) AND the browser reported
  // it can decode it (device:boot acceptH264). Otherwise JPEG. Uses the ScreenCaptureStreamer
  // path (no intervalMs) and reads the codec arg the mocked streamer was constructed with.
  describe('codec negotiation', () => {
    const ORIG_CODEC = process.env.TAPFLOW_IOS_CODEC
    const MockCapture = vi.mocked(ScreenCaptureStreamer)

    afterEach(() => {
      if (ORIG_CODEC === undefined) delete process.env.TAPFLOW_IOS_CODEC
      else process.env.TAPFLOW_IOS_CODEC = ORIG_CODEC
    })

    // Boots via the ScreenCaptureStreamer path and returns the codec the streamer got.
    async function bootAndGetCodec(bootPayload: Record<string, unknown>): Promise<string> {
      MockCapture.mockClear()
      const agent = new IOSAgent({}, mockSimctl(true)) // no intervalMs → ScreenCaptureStreamer
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', ...bootPayload },
      }))
      await waitForType(browser, 'device:ready')
      const calls = MockCapture.mock.calls
      const codec = calls[calls.length - 1]?.[2] as string
      agent.disconnect()
      browser.close()
      return codec
    }

    it('streams H.264 when env=h264 and the browser accepts it', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('h264')
    })

    it('falls back to JPEG when the browser cannot decode H.264', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({ acceptH264: false })).toBe('jpeg')
    })

    it('defaults to JPEG when acceptH264 is absent (old browser / version skew)', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({})).toBe('jpeg')
    })

    it('forces JPEG when env=jpeg even if the browser accepts H.264', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'jpeg'
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('jpeg')
    })

    // H.264 is the default: env unset + a capable browser streams H.264 without any opt-in.
    it('streams H.264 by default when env is unset and the browser accepts it', async () => {
      delete process.env.TAPFLOW_IOS_CODEC
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('h264')
    })
  })

})
