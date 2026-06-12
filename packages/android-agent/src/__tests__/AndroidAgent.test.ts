import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../AndroidTouchHelper', () => ({
  AndroidTouchHelper: vi.fn(function () { return ({
    start: vi.fn(),
    stop: vi.fn(),
    touchStart: vi.fn(),
    touchMove: vi.fn(),
    touchEnd: vi.fn(),
    pinchStart: vi.fn(),
    pinchMove: vi.fn(),
    pinchEnd: vi.fn(),
    pressButton: vi.fn(),
  }) }),
}))

// Shared state for per-test stream control (captured by inner factory closure)
let scrcpyCloseOnCreate = false
let scrcpyStartError: Error | null = null
let scrcpyStreamController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

vi.mock('../scrcpy/ScrcpySession', () => ({
  ScrcpySession: vi.fn(function () { return ({
    start: vi.fn().mockImplementation(() => {
      const err = scrcpyStartError
      scrcpyStartError = null
      return err
        ? Promise.reject(err)
        : Promise.resolve({ deviceName: 'TestDevice', width: 1080, height: 2400 })
    }),
    stop: vi.fn(),
    video: {
      start: vi.fn(() => new ReadableStream<ScrcpyFrame>({
        start(c) {
          scrcpyStreamController = c
          if (scrcpyCloseOnCreate) c.close()
        },
      })),
    },
    control: {
      touchDown: vi.fn(),
      touchMove: vi.fn(),
      touchUp: vi.fn(),
      pinchStart: vi.fn(),
      pinchMove: vi.fn(),
      pinchEnd: vi.fn(),
      resetVideo: vi.fn(),
    },
  }) }),
}))

vi.mock('../EmulatorLauncher', () => ({
  EmulatorLauncher: vi.fn(function () { return ({
    launch: vi.fn(),
    findSerial: vi.fn().mockResolvedValue('emulator-5554'),
    waitForBoot: vi.fn().mockResolvedValue(undefined),
  }) }),
}))

// gRPC backend mocks (emulator host-encode path). Inert for the scrcpy-pinned tests; exercised by
// the 'gRPC backend' describe, which unpins TAPFLOW_ANDROID_BACKEND.
let grpcStartError: Error | null = null
let grpcFramesController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

vi.mock('../emulator/EmulatorGrpcClient', () => ({
  EmulatorGrpcClient: vi.fn(function () { return ({
    close: vi.fn(),
    touchDown: vi.fn(), touchMove: vi.fn(), touchUp: vi.fn(),
    pinchStart: vi.fn(), pinchMove: vi.fn(), pinchEnd: vi.fn(),
  }) }),
}))

vi.mock('../emulator/EmulatorVideo', () => ({
  EmulatorVideo: vi.fn(function () { return ({
    start: vi.fn().mockImplementation(() => {
      const err = grpcStartError
      grpcStartError = null
      return err
        ? Promise.reject(err)
        : Promise.resolve({ width: 1080, height: 2400, cornerRadius: 0 })
    }),
    frames: vi.fn(() => new ReadableStream<ScrcpyFrame>({ start(c) { grpcFramesController = c } })),
    requestIdr: vi.fn(),
    stop: vi.fn(),
  }) }),
}))

import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { hasEnvelope, readEnvelopeFlags, CODEC_H264, CODEC_JPEG } from '@tapflowio/agent-core/utils'
import { AndroidAgent, pickAndroidBackend, parseSpsFromNal } from '../AndroidAgent'
import { AdbWrapper } from '../AdbWrapper'
import { ScrcpySession } from '../scrcpy/ScrcpySession'
import { EmulatorVideo } from '../emulator/EmulatorVideo'
import { EmulatorGrpcClient } from '../emulator/EmulatorGrpcClient'
import type { ScrcpyControl } from '../scrcpy/ScrcpyControl'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo'
import type { AdbRunner } from '../adb'

// Test-only view of a per-device state entry (the real DeviceState is not exported).
interface TestState {
  restarting: boolean
  scrcpySession: { control: ScrcpyControl } | null
  emulatorVideo: unknown | null
  grpcClient: unknown | null
  streamWs: WebSocket | null
  touchHelper: { pressButton: (name: string) => void } | null
  videoWidth: number
  videoHeight: number
  landscape: boolean
}

// Test-only view of AndroidAgent internals (device state + reconnect fields are private).
interface AndroidAgentInternals {
  ws: WebSocket | null
  adb: AdbWrapper
  deviceStates: Map<string, TestState>
  _stopping: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempt: number
  _scheduleReconnect(): void
  restartVideoStream(state: TestState): Promise<void>
  cleanupDeviceState(state: TestState): void
  handleRelayMessage(msg: unknown): void
}
const internals = (agent: AndroidAgent): AndroidAgentInternals =>
  agent as unknown as AndroidAgentInternals

function mockAdb(booted = false): AdbWrapper {
  const runner: AdbRunner = {
    exec: vi.fn().mockResolvedValue(''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    listAvds: vi.fn().mockResolvedValue(['Pixel_8_API_34']),
  }
  const adb = new AdbWrapper(runner)
  if (booted) adb.setSerial('avd:Pixel_8_API_34', 'emulator-5554')
  vi.spyOn(adb, 'listDevices').mockResolvedValue([{
    id: 'avd:Pixel_8_API_34',
    name: 'Pixel_8_API_34',
    platform: 'android',
    status: booted ? 'booted' : 'shutdown',
    osVersion: booted ? 'Android 14' : undefined,
  }])
  return adb
}

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
      } catch { /* binary frame */ }
    }
    ws.on('message', listener)
  })

describe('AndroidAgent', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string
  const prevBackend = process.env.TAPFLOW_ANDROID_BACKEND

  beforeAll(() => {
    // These tests exercise the scrcpy backend; pin it so the emulator serial doesn't auto-select
    // the gRPC path (which would spawn a real encoder / hit 127.0.0.1:8554 and be environment-flaky).
    process.env.TAPFLOW_ANDROID_BACKEND = 'scrcpy'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-android-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    if (prevBackend === undefined) delete process.env.TAPFLOW_ANDROID_BACKEND
    else process.env.TAPFLOW_ANDROID_BACKEND = prevBackend
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

  describe('connect', () => {
    it('sends agent:register with platform:android', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      const relayWs = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(relayWs)

      const registerPromise = waitForType(relayWs, 'agent:register')
        .catch(() => null) // relay processes it internally — listen via agents:list instead

      await agent.connect(`ws://localhost:${port}`)
      relayWs.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(relayWs, 'agents:listed')
      const sessions = listed['sessions'] as Array<{ agentName: string; devices: unknown[] }>
      expect(sessions).toHaveLength(1)
      expect(sessions[0].devices).toHaveLength(1)

      agent.disconnect()
      relayWs.close()
      void registerPromise
    })

    it('registers one session per device', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      expect(agent.sessionId).toBeTruthy()
      agent.disconnect()
    })

    it('holds a power assertion while connected (acquire on connect, release on disconnect)', async () => {
      const adb = mockAdb()
      const sleepBlocker = { acquire: vi.fn(), release: vi.fn() }
      const agent = new AndroidAgent({ sleepBlocker }, adb)
      await agent.connect(`ws://localhost:${port}`)
      expect(sleepBlocker.acquire).toHaveBeenCalled()
      expect(sleepBlocker.release).not.toHaveBeenCalled()
      agent.disconnect()
      expect(sleepBlocker.release).toHaveBeenCalled()
    })
  })

  describe('device:boot flow', () => {
    it('sends device:booting then device:ready', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))

      await waitForType(browser, 'device:booting')
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['payload']).toMatchObject({ deviceId: 'avd:Pixel_8_API_34' })

      agent.disconnect()
      browser.close()
    })

    it('sends session:chrome with buttons (no framePng)', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const chromePromise = waitForType(browser, 'session:chrome')
      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:booting')

      const chrome = await chromePromise
      const payload = chrome['payload'] as Record<string, unknown>
      expect('framePng' in payload).toBe(false)
      expect(Array.isArray(payload['buttons'])).toBe(true)
      expect(payload['streamType']).toBe('h264')

      agent.disconnect()
      browser.close()
    })

    it('second boot request cancels first via bootSeq', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      // Send two boot requests rapidly
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))

      // Should still get exactly one device:ready eventually
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['type']).toBe('device:ready')

      agent.disconnect()
      browser.close()
    })
  })

  describe('app:install', () => {
    it('sends app:install-error for .app.zip (iOS build)', async () => {
      const adb = mockAdb(true)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      // relay resolves build from DB — simulate agent receiving the install message directly
      const agentWs = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentWs)
      // We can't easily test relay→agent path without a DB entry; test the response routing
      // by checking that .app.zip guard works at agent level via the relay message handler
      agent['handleRelayMessage']({
        type: 'app:install',
        sessionId: agent.sessionId!,
        payload: { filePath: '/tmp/App.app.zip' },
      })
      const err = await waitForType(browser, 'app:install-error')
      expect((err['message'] as string).toLowerCase()).toContain('ios')

      agent.disconnect()
      browser.close()
      agentWs.close()
    })
  })

  describe('busy session', () => {
    it('rejects second browser joining the same session', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const b1 = new WebSocket(`ws://localhost:${port}`)
      const b2 = new WebSocket(`ws://localhost:${port}`)
      await Promise.all([waitForOpen(b1), waitForOpen(b2)])

      b1.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(b1, 'session:joined')

      b2.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      const err = await waitForType(b2, 'error')
      expect(err['message']).toMatch(/busy/i)

      agent.disconnect()
      b1.close()
      b2.close()
    })
  })

  describe('DeviceAgent interface', () => {
    it('listDevices delegates to AdbWrapper', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      const devices = await agent.listDevices()
      expect(devices[0].platform).toBe('android')
    })
  })

  describe('auto-restart', () => {
    let agent: AndroidAgent
    let browser: WebSocket

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    beforeEach(async () => {
      // Reset the module-level mock state to a clean slate *before* booting, so any async work
      // that settled late from a previous test (a leaked pump/restart) can't carry stale values in.
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null

      agent = new AndroidAgent({}, mockAdb(true))
      await agent.connect(`ws://localhost:${port}`)

      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
    })

    afterEach(async () => {
      vi.useRealTimers()
      // disconnect() clears deviceStates, so any in-flight auto-restart hits its
      // `deviceStates.has(...)` guard and returns without spawning a new scrcpy session — this is
      // what neutralizes the pump→restart chain instead of letting it bleed into the next test.
      agent.disconnect()
      browser.close()
      // End the active video stream so its pump loop resolves now, then let pending microtasks +
      // timer callbacks drain on the real clock before the next test starts from a clean slate.
      try { scrcpyStreamController?.close() } catch { /* already closed by the test or the mock */ }
      await new Promise((r) => setImmediate(r))
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null
    })

    describe('pump exit guard', () => {
      it('calls restartVideoStream when stream ends unexpectedly', async () => {
        scrcpyCloseOnCreate = true
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        await vi.waitFor(() => expect(restartSpy).toHaveBeenCalledOnce(), { timeout: 500 })
      })

      it('skips restartVideoStream when restarting flag is already set', async () => {
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        getState().restarting = true
        scrcpyStreamController?.close()

        // Stream close is async — poll until the pump loop has had time to exit.
        // vi.waitFor retries until the assertion passes or the timeout is exceeded.
        await vi.waitFor(() => expect(restartSpy).not.toHaveBeenCalled(), { timeout: 200 })
      })

      it('skips restartVideoStream when session was intentionally stopped', async () => {
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        const state = getState()
        internals(agent).cleanupDeviceState(state) // sets scrcpySession = null
        scrcpyStreamController?.close()

        await vi.waitFor(() => expect(restartSpy).not.toHaveBeenCalled(), { timeout: 200 })
      })
    })

    describe('envelope marking (B-2)', () => {
      it('marks codec=H.264 + per-AU keyframe so the relay stays keyframe-aware', async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        const flags: Array<{ codec: number; keyframe: boolean }> = []
        browser.on('message', (d: Buffer) => {
          if (Buffer.isBuffer(d) && hasEnvelope(d)) flags.push(readEnvelopeFlags(d))
        })

        // The stream controller is assigned during startVideoStream; wait for it before enqueueing
        // so this test never reads it mid-(re)start when it is transiently null.
        await vi.waitFor(() => expect(scrcpyStreamController).not.toBeNull(), { timeout: 1000 })
        const controller = scrcpyStreamController!

        // A keyframe access unit (SPS+PPS merged) followed by a P-frame access unit.
        controller.enqueue({ payload: Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0x65, 0x88]), keyframe: true })
        controller.enqueue({ payload: Buffer.from([0x41, 0x9a, 0x00, 0x20]), keyframe: false })

        await vi.waitFor(() => expect(flags).toHaveLength(2), { timeout: 1000 })
        expect(flags[0]).toEqual({ codec: CODEC_H264, keyframe: true })
        expect(flags[1]).toEqual({ codec: CODEC_H264, keyframe: false })
        // Regression guard: the pre-fix bug marked H.264 frames as JPEG → relay saw every frame as a keyframe, degrading drop-to-keyframe into tearing drop-to-latest.
        expect(flags[0].codec).not.toBe(CODEC_JPEG)
      })
    })

    describe('stream:request-idr (B-3)', () => {
      it('resets the scrcpy video encoder to force an on-demand IDR', async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        // Wait for the scrcpy session to settle before reading it — guards against reading during a
        // transient null window if a (re)start is still in flight.
        await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
        const control = getState().scrcpySession!.control
        expect(control.resetVideo).not.toHaveBeenCalled()

        // Relay sends this agent-ward during drop-to-keyframe recovery.
        internals(agent).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId })

        expect(control.resetVideo).toHaveBeenCalledOnce()
      })

      it('ignores stream:request-idr when no scrcpy session is active', () => {
        // No device booted → no session; handler must not throw.
        expect(() =>
          internals(agent).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId }),
        ).not.toThrow()
      })
    })

    describe('restartVideoStream', () => {
      beforeEach(async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')
        // restartVideoStream bails early if the stream WS isn't OPEN. Its registration is a real
        // relay round-trip that can lag device:ready under load, so wait for OPEN to make the
        // precondition deterministic before any restart test reads it.
        await vi.waitFor(() => expect(getState().streamWs?.readyState).toBe(WebSocket.OPEN), { timeout: 1000 })
        vi.clearAllMocks() // reset call counts; implementations remain
      })

      it('resets restarting flag when serial is not found', async () => {
        vi.spyOn(internals(agent).adb, 'getSerial').mockReturnValue(undefined)

        const state = getState()
        state.restarting = true
        await internals(agent).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      it('resets restarting flag when streamWs is not open', async () => {
        const state = getState()
        state.streamWs = null
        state.restarting = true

        await internals(agent).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      it('sends device:boot-error and resets flag when startVideoStream throws', async () => {
        vi.useFakeTimers()
        scrcpyStartError = new Error('encoder stall')

        const state = getState()
        state.restarting = true

        const bootErrPromise = waitForType(browser, 'device:boot-error')
        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        const err = await bootErrPromise
        expect(err['message']).toBe('scrcpy failed to restart')
        expect(state.restarting).toBe(false)
      })

      it('creates new ScrcpySession and resets flag on successful restart', async () => {
        vi.useFakeTimers()

        const state = getState()
        state.restarting = true

        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        expect(vi.mocked(ScrcpySession)).toHaveBeenCalledOnce() // cleared before test; one new session
        expect(state.scrcpySession).not.toBeNull()
        expect(state.restarting).toBe(false)
      })
    })
  })

  describe('reconnect', () => {
    it('disconnect() sets _stopping and cancels pending reconnect timer', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._reconnectTimer = setTimeout(() => {}, 10000)

      agent.disconnect()

      expect(internals(agent)._stopping).toBe(true)
      expect(internals(agent)._reconnectTimer).toBeNull()
    })

    it('_scheduleReconnect() is no-op when _stopping is true', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._stopping = true
      internals(agent)._scheduleReconnect()

      expect(internals(agent)._reconnectTimer).toBeNull()
      expect(internals(agent)._reconnectAttempt).toBe(0)

      agent.disconnect()
    })

    it('reconnects automatically when connection drops and relay is available', async () => {
      const agent = new AndroidAgent({ reconnectDelays: [0] }, mockAdb())
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

  // Input + misc relay-message handlers. Boot once over the scrcpy backend (pinned in beforeAll),
  // then inject relay messages directly via handleRelayMessage and assert on the backend control /
  // adb spies — the synchronous fire path means pointer calls land before the handler returns.
  describe('relay message handlers', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    function inject(msg: Record<string, unknown>): void {
      internals(agent).handleRelayMessage({ sessionId: agent.sessionId, ...msg })
    }

    beforeEach(async () => {
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null

      adb = mockAdb(true)
      agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // scrcpy mock reports a 1080×2400 display; touch coords map against these.
      await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
      expect(getState().videoWidth).toBe(1080)
      expect(getState().videoHeight).toBe(2400)
    })

    afterEach(async () => {
      vi.useRealTimers()
      agent.disconnect()
      browser.close()
      try { scrcpyStreamController?.close() } catch { /* already closed */ }
      await new Promise((r) => setImmediate(r))
      scrcpyStreamController = null
    })

    describe('input — touch', () => {
      it('maps normalized touch:start to device px via scrcpy control', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        // 0.25*1080 = 270, 0.75*2400 = 1800
        expect(control.touchDown).toHaveBeenCalledWith(0, 270, 1800)
      })

      it('maps touch:move to device px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:move', payload: { x: 0.5, y: 0.5 } })
        expect(control.touchMove).toHaveBeenCalledWith(0, 540, 1200)
      })

      it('touch:end lifts at the last touched px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2 } })
        inject({ type: 'input:touch:end' })
        // last px from start: 0.1*1080 = 108, 0.2*2400 = 480
        expect(control.touchUp).toHaveBeenCalledWith(0, 108, 480)
      })
    })

    describe('input — pinch', () => {
      it('maps pinch:start two-finger coords to device px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.2, y: 0.3 }, f1: { x: 0.8, y: 0.9 } } })
        // f0: (216, 720), f1: (864, 2160)
        expect(control.pinchStart).toHaveBeenCalledWith(216, 720, 864, 2160)
      })

      it('maps pinch:move and pinch:end', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:pinch:move', payload: { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } } })
        expect(control.pinchMove).toHaveBeenCalledWith(540, 1200, 540, 1200)
        inject({ type: 'input:pinch:end' })
        expect(control.pinchEnd).toHaveBeenCalledOnce()
      })
    })

    describe('input — rotate', () => {
      it('toggles landscape and asks the device to rotate to canonical landscape (3)', () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        expect(getState().landscape).toBe(false)

        inject({ type: 'input:rotate' })
        expect(rotateSpy).toHaveBeenCalledWith('emulator-5554', 3)
        expect(getState().landscape).toBe(true)
      })

      it('rotates back to portrait (0) on the second toggle', () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        inject({ type: 'input:rotate' })
        inject({ type: 'input:rotate' })
        expect(rotateSpy).toHaveBeenNthCalledWith(2, 'emulator-5554', 0)
        expect(getState().landscape).toBe(false)
      })
    })

    describe('input — button', () => {
      it('forwards a named button press to the touch helper', () => {
        const helper = getState().touchHelper!
        inject({ type: 'input:button', payload: { name: 'home' } })
        expect(helper.pressButton).toHaveBeenCalledWith('home')
      })
    })

    describe('input — keyboard', () => {
      it('sends a keyevent for a special key (Enter → 66)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        inject({ type: 'input:key', payload: { code: 'Enter', modifiers: 0 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', '66')
      })

      it('types a lowercase character for a letter key with no shift', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', payload: { code: 'KeyA', modifiers: 0 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'a')
      })

      it('types an uppercase character when shift modifier is set', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', payload: { code: 'KeyA', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'A')
      })

      it('maps a shifted digit to its symbol (Digit1 + shift → !)', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', payload: { code: 'Digit1', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', '!')
      })

      it('keyboard:toggle is a client-side no-op (no adb side effect, no throw)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        expect(() => inject({ type: 'input:keyboard:toggle' })).not.toThrow()
        expect(keyEvSpy).not.toHaveBeenCalled()
        expect(inputSpy).not.toHaveBeenCalled()
      })
    })

    describe('input — no session', () => {
      it('ignores touch input for an unknown session without throwing', () => {
        expect(() =>
          internals(agent).handleRelayMessage({ type: 'input:touch:start', sessionId: 'nope', payload: { x: 0.5, y: 0.5 } }),
        ).not.toThrow()
      })
    })

    describe('misc — device:shutdown', () => {
      it('tears down the device and acks with device:shutdown-done', async () => {
        const shutdownSpy = vi.spyOn(adb, 'shutdown')
        const done = waitForType(browser, 'device:shutdown-done')
        inject({ type: 'device:shutdown', payload: { deviceId: 'avd:Pixel_8_API_34' } })
        const msg = await done
        expect(msg['payload']).toMatchObject({ deviceId: 'avd:Pixel_8_API_34' })
        expect(shutdownSpy).toHaveBeenCalledWith('emulator-5554')
        expect(adb.getSerial('avd:Pixel_8_API_34')).toBeUndefined() // serial cleared
      })
    })

    describe('misc — app:launch', () => {
      it('launches the package and acks with app:launch-done', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp')
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', payload: { bundleId: 'com.example.app' } })
        await done
        expect(launchSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app')
      })
    })

    describe('misc — open-url', () => {
      it('opens the URL on the device and acks with open-url:done', async () => {
        const urlSpy = vi.spyOn(adb, 'openUrl')
        const done = waitForType(browser, 'open-url:done')
        inject({ type: 'open-url', payload: { url: 'https://example.com' } })
        await done
        expect(urlSpy).toHaveBeenCalledWith('emulator-5554', 'https://example.com')
      })

      it('reports open-url:error with the failure message when adb rejects', async () => {
        vi.spyOn(adb, 'openUrl').mockRejectedValue(new Error('activity not found'))
        const err = waitForType(browser, 'open-url:error')
        inject({ type: 'open-url', payload: { url: 'https://example.com' } })
        const msg = await err
        expect(msg['message']).toBe('activity not found')
      })
    })

    describe('misc — screenshot:request', () => {
      // The relay routes screenshot:done back to a pending HTTP request by requestId (not to the
      // session browser), so assert the agent's own outgoing reply on its relay socket.
      it('captures a screenshot and replies with base64 data + requestId', async () => {
        vi.spyOn(adb, 'screenshot').mockResolvedValue(Buffer.from('PNGDATA'))
        const sendSpy = vi.spyOn(internals(agent).ws!, 'send')

        inject({ type: 'screenshot:request', requestId: 'req-1', format: 'png' })

        const sent = await vi.waitFor(() => {
          const msg = sendSpy.mock.calls
            .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
            .find((m) => m['type'] === 'screenshot:done')
          expect(msg).toBeDefined()
          return msg!
        }, { timeout: 1000 })

        expect(sent['requestId']).toBe('req-1')
        expect(sent['format']).toBe('png')
        expect(sent['data']).toBe(Buffer.from('PNGDATA').toString('base64'))
      })
    })
  })

  // gRPC host-encode backend (emulator default). Unpin the backend to 'grpc' so an emulator serial
  // takes the gRPC path; the rest of the suite stays pinned to scrcpy via beforeAll.
  describe('gRPC backend', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket
    let pinned: string | undefined

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    async function bootDevice(): Promise<void> {
      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
    }

    beforeEach(async () => {
      pinned = process.env.TAPFLOW_ANDROID_BACKEND // live value (scrcpy, from the suite beforeAll)
      process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
      grpcStartError = null
      grpcFramesController = null
      scrcpyStreamController = null

      adb = mockAdb(true)
      vi.spyOn(adb, 'getScreenSize').mockResolvedValue({ width: 1080, height: 2400 })
      agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
    })

    afterEach(async () => {
      agent.disconnect()
      browser?.close()
      try { grpcFramesController?.close() } catch { /* already closed */ }
      try { scrcpyStreamController?.close() } catch { /* already closed */ }
      await new Promise((r) => setImmediate(r))
      grpcStartError = null
      grpcFramesController = null
      scrcpyStreamController = null
      if (pinned === undefined) delete process.env.TAPFLOW_ANDROID_BACKEND
      else process.env.TAPFLOW_ANDROID_BACKEND = pinned
    })

    it('routes an emulator serial through the gRPC video path (no scrcpy session)', async () => {
      await bootDevice()
      await vi.waitFor(() => expect(getState().emulatorVideo).not.toBeNull(), { timeout: 1000 })

      expect(vi.mocked(EmulatorVideo)).toHaveBeenCalled()
      expect(vi.mocked(EmulatorGrpcClient)).toHaveBeenCalled()
      expect(getState().grpcClient).not.toBeNull()
      expect(getState().scrcpySession).toBeNull() // gRPC path never opens scrcpy
      // native screen size from adb drives the touch-mapping dimensions
      expect(getState().videoWidth).toBe(1080)
      expect(getState().videoHeight).toBe(2400)
    })

    it('falls back to scrcpy when the gRPC video stream fails to start', async () => {
      grpcStartError = new Error('emulator -grpc not available')

      await bootDevice()
      await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })

      // gRPC was attempted then torn down, scrcpy took over so streaming still works.
      expect(vi.mocked(EmulatorVideo)).toHaveBeenCalled()
      expect(vi.mocked(ScrcpySession)).toHaveBeenCalled()
      expect(getState().emulatorVideo).toBeNull()
      expect(getState().grpcClient).toBeNull()
    })
  })
})

describe('pickAndroidBackend', () => {
  it('honors TAPFLOW_ANDROID_BACKEND=scrcpy even for an emulator serial', () => {
    expect(pickAndroidBackend('emulator-5554', { TAPFLOW_ANDROID_BACKEND: 'scrcpy' })).toBe('scrcpy')
  })

  it('honors TAPFLOW_ANDROID_BACKEND=grpc even for a real-device serial', () => {
    expect(pickAndroidBackend('39021FDH2003ZZ', { TAPFLOW_ANDROID_BACKEND: 'grpc' })).toBe('grpc')
  })

  it('defaults an emulator-* serial to grpc when unset', () => {
    expect(pickAndroidBackend('emulator-5556', {})).toBe('grpc')
  })

  it('defaults a real-device serial to scrcpy when unset', () => {
    expect(pickAndroidBackend('39021FDH2003ZZ', {})).toBe('scrcpy')
  })
})

describe('parseSpsFromNal', () => {
  // Independent Exp-Golomb SPS writer — a separate implementation of the H.264 SPS bit layout, so
  // the dimensions we assert come from the values WE encode, not from re-running the parser.
  class SpsBuilder {
    private bits: number[] = []
    u(n: number, val: number): this {
      for (let i = n - 1; i >= 0; i--) this.bits.push((val >> i) & 1)
      return this
    }
    ue(val: number): this {
      const code = val + 1
      const nb = Math.floor(Math.log2(code))
      for (let i = 0; i < nb; i++) this.bits.push(0)
      for (let i = nb; i >= 0; i--) this.bits.push((code >> i) & 1)
      return this
    }
    annexB(): Buffer {
      const padded = [...this.bits]
      while (padded.length % 8 !== 0) padded.push(0)
      const body: number[] = []
      for (let i = 0; i < padded.length; i += 8) {
        let b = 0
        for (let j = 0; j < 8; j++) b = (b << 1) | padded[i + j]!
        body.push(b)
      }
      // 4-byte Annex B start code + NAL header byte (0x67 = ref_idc 3, type 7 = SPS)
      return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), Buffer.from(body)])
    }
  }

  // Common SPS prefix up to (and including) gaps_in_frame_num_value_allowed_flag for a baseline
  // (profile_idc 66) stream — baseline skips the high-profile chroma_format block.
  function baselineHead(b: SpsBuilder): SpsBuilder {
    return b
      .u(8, 66)    // profile_idc = 66 (baseline → no chroma block)
      .u(8, 0xc0)  // constraint flags (consumed, value irrelevant)
      .u(8, 31)    // level_idc
      .ue(0)       // seq_parameter_set_id
      .ue(0)       // log2_max_frame_num_minus4
      .ue(0)       // pic_order_cnt_type = 0
      .ue(0)       // log2_max_pic_order_cnt_lsb_minus4 (poc_type 0)
      .ue(1)       // max_num_ref_frames
      .u(1, 0)     // gaps_in_frame_num_value_allowed_flag
  }

  it('parses width/height from a 1280×720 baseline SPS (no cropping)', () => {
    const sps = baselineHead(new SpsBuilder())
      .ue(79)   // pic_width_in_mbs_minus1 → (79+1)*16 = 1280
      .ue(44)   // pic_height_in_map_units_minus1 → (44+1)*16 = 720
      .u(1, 1)  // frame_mbs_only_flag = 1
      .u(1, 1)  // direct_8x8_inference_flag
      .u(1, 0)  // frame_cropping_flag = 0
      .annexB()

    expect(parseSpsFromNal(sps)).toEqual({ width: 1280, height: 720 })
  })

  it('applies frame cropping (1920×1080 from a 1088-tall coded frame)', () => {
    const sps = baselineHead(new SpsBuilder())
      .ue(119)  // width → (119+1)*16 = 1920
      .ue(67)   // map units → (67+1)*16 = 1088 coded height
      .u(1, 1)  // frame_mbs_only_flag = 1
      .u(1, 1)  // direct_8x8_inference_flag
      .u(1, 1)  // frame_cropping_flag = 1
      .ue(0).ue(0).ue(0) // crop left/right/top = 0
      .ue(4)    // crop_bottom = 4 → 1088 - 4*2(subHeightC) = 1080
      .annexB()

    expect(parseSpsFromNal(sps)).toEqual({ width: 1920, height: 1080 })
  })

  it('returns null for a NAL with no Annex B start code', () => {
    expect(parseSpsFromNal(Buffer.from([0x67, 0x42, 0xc0, 0x1f]))).toBeNull()
  })

  it('returns null for a non-SPS NAL unit (type ≠ 7)', () => {
    // start code + 0x41 (nal_unit_type = 1, a P-slice) → not an SPS
    expect(parseSpsFromNal(Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x00]))).toBeNull()
  })

  it('returns null for a truncated SPS instead of throwing', () => {
    // start code + SPS header but no dimension fields → bit reader runs out → caught → null
    expect(parseSpsFromNal(Buffer.from([0, 0, 0, 1, 0x67]))).toBeNull()
  })
})

describe('connect — error paths', () => {
  let server: WebSocketServer
  let url: string

  async function startServer(onConnection: (ws: WebSocket) => void): Promise<void> {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.once('listening', r))
    url = `ws://localhost:${(server.address() as { port: number }).port}`
    server.on('connection', (ws) => onConnection(ws as unknown as WebSocket))
  }

  afterEach(async () => {
    // A rejected handshake leaves the agent's raw socket open, which would block server.close();
    // terminate any lingering clients first.
    for (const client of server.clients) client.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('rejects with a PlatformError when the handshake reply is not agent:registered', async () => {
    await startServer((ws) => {
      ws.on('message', () => ws.send(JSON.stringify({ type: 'agent:rejected' })))
    })
    const agent = new AndroidAgent({}, mockAdb())

    await expect(agent.connect(url)).rejects.toThrow(/Unexpected message during handshake/)
    agent.disconnect()
  })

  it('ignores a malformed (non-JSON) frame and keeps handling subsequent messages', async () => {
    let serverWs: WebSocket
    await startServer((ws) => {
      serverWs = ws
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent:register') {
          ws.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] }))
        }
      })
    })
    const agent = new AndroidAgent({}, mockAdb())
    await agent.connect(url) // resolves once agent:registered arrives

    // The agent's message loop must swallow a malformed frame without tearing down the connection.
    serverWs!.send('this is not json {{{')

    // Prove the connection still works: a valid request after the bad frame still gets a reply.
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      serverWs!.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.type === 'app:install-error') resolve(m)
      })
    })
    serverWs!.send(JSON.stringify({ type: 'app:install', sessionId: 'unknown', payload: { filePath: '/tmp/app.apk' } }))

    const m = await reply
    expect(m['message']).toBe('No booted device')
    agent.disconnect()
  })

  // #271 — 원격 릴레이 인증: token 옵션이 control/stream WS 업그레이드에 Bearer 헤더로 실린다.
  // (iOS와 동일 동작 — IOSAgent.test.ts의 relay auth token 테스트와 짝)
  describe('relay auth token (#271)', () => {
    async function withRawServer<T>(
      onConnection: (sock: WebSocket, authHeader: string | undefined) => void,
      run: (url: string) => Promise<T>,
    ): Promise<T> {
      const wss = new WebSocketServer({ port: 0 })
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', (sock, req) => onConnection(sock as unknown as WebSocket, req.headers.authorization))
      try {
        return await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('token 옵션이 있으면 control WS에 Authorization: Bearer 헤더가 실린다', async () => {
      let seen: string | undefined
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        },
        async (url) => {
          const agent = new AndroidAgent({ token: 'tflw_pat_android' }, mockAdb())
          await agent.connect(url)
          agent.disconnect()
        },
      )
      expect(seen).toBe('Bearer tflw_pat_android')
    })

    it('token이 없으면 Authorization 헤더를 보내지 않는다', async () => {
      let seen: string | undefined = 'sentinel'
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        },
        async (url) => {
          const agent = new AndroidAgent({}, mockAdb())
          await agent.connect(url)
          agent.disconnect()
        },
      )
      expect(seen).toBeUndefined()
    })

    it('stream WS(openStreamWs)에도 같은 토큰 헤더가 실린다', async () => {
      let seen: string | undefined
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'stream:registered' })))
        },
        async (url) => {
          const agent = new AndroidAgent({ token: 'tflw_pat_android' }, mockAdb())
          const internals = agent as unknown as {
            relayUrl: string | null
            openStreamWs(state: { sessionId: string; streamWs: WebSocket | null }): Promise<WebSocket>
          }
          internals.relayUrl = url
          const streamWs = await internals.openStreamWs({ sessionId: 's1', streamWs: null })
          streamWs.close()
        },
      )
      expect(seen).toBe('Bearer tflw_pat_android')
    })
  })

  // #271 — 핸드셰이크 견고성 (IOSAgent.test.ts와 짝)
  describe('handshake robustness (#271)', () => {
    it('등록 전 1008 close → code/reason을 담아 reject한다 (무한 대기 없음)', async () => {
      const wss = new WebSocketServer({ port: 0 })
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', (sock) => sock.close(1008, 'Unauthorized: agents need a PAT'))
      try {
        const agent = new AndroidAgent({}, mockAdb())
        await expect(agent.connect(`ws://127.0.0.1:${wssPort}`))
          .rejects.toThrow(/code=1008.*Unauthorized: agents need a PAT/)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    })

    it('agent:registered 응답이 없으면 handshakeTimeoutMs 후 reject한다', async () => {
      const wss = new WebSocketServer({ port: 0 }) // 업그레이드만 수락, 무응답
      const wssPort = (wss.address() as { port: number }).port
      try {
        const agent = new AndroidAgent({ handshakeTimeoutMs: 150 }, mockAdb())
        await expect(agent.connect(`ws://127.0.0.1:${wssPort}`))
          .rejects.toThrow(/timed out after 150ms/)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    })
  })
})
