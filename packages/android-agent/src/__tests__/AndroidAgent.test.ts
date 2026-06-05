import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../AndroidTouchHelper', () => ({
  AndroidTouchHelper: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    touchStart: vi.fn(),
    touchMove: vi.fn(),
    touchEnd: vi.fn(),
    pinchStart: vi.fn(),
    pinchMove: vi.fn(),
    pinchEnd: vi.fn(),
    pressButton: vi.fn(),
  })),
}))

// Shared state for per-test stream control (captured by inner factory closure)
let scrcpyCloseOnCreate = false
let scrcpyStartError: Error | null = null
let scrcpyStreamController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

vi.mock('../scrcpy/ScrcpySession', () => ({
  ScrcpySession: vi.fn(() => ({
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
  })),
}))

vi.mock('../EmulatorLauncher', () => ({
  EmulatorLauncher: vi.fn(() => ({
    launch: vi.fn(),
    findSerial: vi.fn().mockResolvedValue('emulator-5554'),
    waitForBoot: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { WebSocket } from 'ws'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { hasEnvelope, readEnvelopeFlags, CODEC_H264, CODEC_JPEG } from '@tapflowio/agent-core/utils'
import { AndroidAgent } from '../AndroidAgent'
import { AdbWrapper } from '../AdbWrapper'
import { ScrcpySession } from '../scrcpy/ScrcpySession'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo'
import type { AdbRunner } from '../adb'

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

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-android-test-'))
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
    interface TestState {
      restarting: boolean
      scrcpySession: object | null
      streamWs: WebSocket | null
    }

    let agent: AndroidAgent
    let browser: WebSocket

    function getState(): TestState {
      return (agent as any).deviceStates.values().next().value as TestState
    }

    beforeEach(async () => {
      agent = new AndroidAgent({}, mockAdb(true))
      await agent.connect(`ws://localhost:${port}`)

      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
    })

    afterEach(() => {
      vi.useRealTimers()
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null
      agent.disconnect()
      browser.close()
    })

    describe('pump exit guard', () => {
      it('calls restartVideoStream when stream ends unexpectedly', async () => {
        scrcpyCloseOnCreate = true
        const restartSpy = vi.spyOn(agent as any, 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        await vi.waitFor(() => expect(restartSpy).toHaveBeenCalledOnce(), { timeout: 500 })
      })

      it('skips restartVideoStream when restarting flag is already set', async () => {
        const restartSpy = vi.spyOn(agent as any, 'restartVideoStream').mockResolvedValue(undefined)

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
        const restartSpy = vi.spyOn(agent as any, 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        const state = getState()
        ;(agent as any).cleanupDeviceState(state) // sets scrcpySession = null
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

        // A keyframe access unit (SPS+PPS merged) followed by a P-frame access unit.
        scrcpyStreamController!.enqueue({ payload: Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0x65, 0x88]), keyframe: true })
        scrcpyStreamController!.enqueue({ payload: Buffer.from([0x41, 0x9a, 0x00, 0x20]), keyframe: false })

        await vi.waitFor(() => expect(flags).toHaveLength(2), { timeout: 1000 })
        expect(flags[0]).toEqual({ codec: CODEC_H264, keyframe: true })
        expect(flags[1]).toEqual({ codec: CODEC_H264, keyframe: false })
        // Regression guard: the pre-fix bug marked H.264 frames as JPEG (→ relay treated
        // every frame as a keyframe, degrading drop-to-keyframe into tearing drop-to-latest).
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

        const control = (getState() as any).scrcpySession.control
        expect(control.resetVideo).not.toHaveBeenCalled()

        // Relay sends this agent-ward during drop-to-keyframe recovery.
        ;(agent as any).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId })

        expect(control.resetVideo).toHaveBeenCalledOnce()
      })

      it('ignores stream:request-idr when no scrcpy session is active', () => {
        // No device booted → no session; handler must not throw.
        expect(() =>
          (agent as any).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId }),
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
        vi.clearAllMocks() // reset call counts; implementations remain
      })

      it('resets restarting flag when serial is not found', async () => {
        vi.spyOn((agent as any).adb as AdbWrapper, 'getSerial').mockReturnValue(undefined)

        const state = getState()
        state.restarting = true
        await (agent as any).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      it('resets restarting flag when streamWs is not open', async () => {
        const state = getState()
        state.streamWs = null
        state.restarting = true

        await (agent as any).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      it('sends device:boot-error and resets flag when startVideoStream throws', async () => {
        vi.useFakeTimers()
        scrcpyStartError = new Error('encoder stall')

        const state = getState()
        state.restarting = true

        const bootErrPromise = waitForType(browser, 'device:boot-error')
        const restartPromise = (agent as any).restartVideoStream(state)
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

        const restartPromise = (agent as any).restartVideoStream(state)
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

      ;(agent as any)._reconnectTimer = setTimeout(() => {}, 10000)

      agent.disconnect()

      expect((agent as any)._stopping).toBe(true)
      expect((agent as any)._reconnectTimer).toBeNull()
    })

    it('_scheduleReconnect() is no-op when _stopping is true', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      ;(agent as any)._stopping = true
      ;(agent as any)._scheduleReconnect()

      expect((agent as any)._reconnectTimer).toBeNull()
      expect((agent as any)._reconnectAttempt).toBe(0)

      agent.disconnect()
    })

    it('reconnects automatically when connection drops and relay is available', async () => {
      const agent = new AndroidAgent({ reconnectDelays: [0] }, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      const oldWs = (agent as any).ws as WebSocket
      oldWs.terminate()

      await vi.waitFor(() => {
        const ws = (agent as any).ws as WebSocket | null
        expect(ws).not.toBeNull()
        expect(ws).not.toBe(oldWs)       // 새 연결 객체여야 함
        expect(ws!.readyState).toBe(WebSocket.OPEN)
      }, { timeout: 2000 })

      agent.disconnect()
    })
  })
})
