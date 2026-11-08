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
    touchEnd: vi.fn(async () => 'delivered'),
    touchCancel: vi.fn(),
    pinchStart: vi.fn(() => 'unsupported'),
    pinchMove: vi.fn(() => 'unsupported'),
    pinchEnd: vi.fn(() => 'unsupported'),
    pressButton: vi.fn(async () => 'delivered'),
  }) }),
}))

// Shared state for per-test stream control (captured by inner factory closure)
let scrcpyCloseOnCreate = false
let scrcpyStartError: Error | null = null
let scrcpyStreamController: ReadableStreamDefaultController<ScrcpyFrame> | null = null
/** Each `start()` takes the next gate, if any, and waits on it — how a test parks one boot mid-stream. */
const scrcpyStartGates: Promise<void>[] = []

vi.mock('../scrcpy/ScrcpySession', () => ({
  ScrcpySession: vi.fn(function () { return ({
    start: vi.fn().mockImplementation(() => {
      const err = scrcpyStartError
      scrcpyStartError = null
      const gate = scrcpyStartGates.shift() ?? Promise.resolve()
      return gate.then(() => err
        ? Promise.reject(err)
        : { deviceName: 'TestDevice', width: 1080, height: 2400 })
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
      isReady: vi.fn(() => true),
      touchDown: vi.fn(),
      touchMove: vi.fn(),
      touchUp: vi.fn(),
      touchCancel: vi.fn(),
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
    waitForExit: vi.fn().mockResolvedValue(undefined),
  }) }),
  findEmulatorPid: vi.fn(() => null),
  // The boot path probes rather than asking for a pid, because it has to tell "not running" from
  // "could not look" (#447 review). Default: nothing running, and we could see that.
  probeEmulator: vi.fn(() => ({ state: 'gone' as const })),
  stopEmulatorProcess: vi.fn(() => true),
}))
// Shared macOS host-mute helper (#341). Off by default in tests (isAudioSupported → false → no-op);
// the host-mute test overrides these to assert the mute tap launches.
vi.mock('@tapflowio/audiotap-helper', () => ({
  isAudioSupported: vi.fn(() => false),
  ensureHelperApp: vi.fn(() => '/fake/audiotap-helper.app'),
  launchMuteOnlyTap: vi.fn(),
}))

// gRPC backend mocks (emulator host-encode path). Inert for the scrcpy-pinned tests; exercised by
// the 'gRPC backend' describe, which unpins TAPFLOW_ANDROID_BACKEND.
let grpcStartError: Error | null = null
/** As `scrcpyStartGates`, for `EmulatorVideo.start()`; a gate that rejects fails that start. */
const grpcStartGates: Promise<void>[] = []
let grpcFramesController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

// Guest clipboard the mocked emulator reports back (clipboard bridge tests drive these).
let grpcClipboardText = ''
let grpcClipboardError: Error | null = null
// How long the emulator takes to actually apply a setClipboard (the proto says it is scheduled
// on the main looper, so "resolved" != "applied").
let grpcClipboardApplyDelayMs = 0

let grpcDisplaySize: { width: number; height: number } | null = { width: 1080, height: 2400 }
vi.mock('../emulator/EmulatorGrpcClient', () => ({
  EmulatorGrpcClient: vi.fn(function () { return ({
    isReady: vi.fn(() => true),
    close: vi.fn(),
    // The divisor for injected touch pixels. `grpcDisplaySize` lets a test say the emulator and
    // the guest disagree, which is the whole foldable case.
    getDisplaySize: vi.fn(async () => grpcDisplaySize),
    touchDown: vi.fn(), touchMove: vi.fn(), touchUp: vi.fn(), touchCancel: vi.fn(),
    pinchStart: vi.fn(), pinchMove: vi.fn(), pinchEnd: vi.fn(),
    streamAudio: vi.fn(() => ({ frames: () => new ReadableStream({ start() {} }), cancel: vi.fn() })), // AudioStream shape: { frames, cancel }
    getClipboard: vi.fn(() => grpcClipboardError
      ? Promise.reject(grpcClipboardError)
      : Promise.resolve(grpcClipboardText)),
    setClipboard: vi.fn(async (text: string) => {
      if (grpcClipboardError) throw grpcClipboardError
      // The proto documents this as scheduling, not applying — model that so the read path
      // cannot get away with assuming the sentinel is visible the moment this resolves.
      const apply = () => { grpcClipboardText = text }
      if (grpcClipboardApplyDelayMs > 0) setTimeout(apply, grpcClipboardApplyDelayMs)
      else apply()
    }),
  }) }),
}))

/** The options the agent handed the last `EmulatorVideo`, so a test can fire `onSizeChange`
 *  itself — the callback is created inside `startGrpcVideoStream` and reachable no other way. */
type GrpcVideoOptions = { onSizeChange?: (w: number, h: number, skin: string, r: number) => void }
let grpcVideoOptions: GrpcVideoOptions | null = null
vi.mock('../emulator/EmulatorVideo', () => ({
  EmulatorVideo: vi.fn(function (_client: unknown, options: Record<string, unknown>) {
    grpcVideoOptions = options as GrpcVideoOptions
    return ({
    start: vi.fn().mockImplementation(() => {
      const err = grpcStartError
      grpcStartError = null
      const gate = grpcStartGates.shift() ?? Promise.resolve()
      return gate.then(() => err
        ? Promise.reject(err)
        : { width: 1080, height: 2400, cornerRadius: 0 })
    }),
    frames: vi.fn(() => new ReadableStream<ScrcpyFrame>({ start(c) { grpcFramesController = c } })),
    requestIdr: vi.fn(),
    stop: vi.fn(),
  }) },
  ),
}))

import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { hasEnvelope, readEnvelopeFlags, CODEC_H264, CODEC_JPEG } from '@tapflowio/agent-core/utils'
import { AndroidAgent, pickAndroidBackend, parseSpsFromNal, toNaturalPoint } from '../AndroidAgent'
import { isPosturable, SHUTDOWN_NO_SESSION_STATE } from '@tapflowio/agent-core'
import type { SkinRotation } from '../emulator/EmulatorGrpcClient'
import { AdbWrapper, StorageFullError } from '../AdbWrapper'
import { ScrcpySession } from '../scrcpy/ScrcpySession'
import { EmulatorVideo } from '../emulator/EmulatorVideo'
import { EmulatorGrpcClient } from '../emulator/EmulatorGrpcClient'
import { findEmulatorPid, probeEmulator, stopEmulatorProcess } from '../EmulatorLauncher'
import { isAudioSupported, launchMuteOnlyTap } from '@tapflowio/audiotap-helper'
import type { ScrcpyControl } from '../scrcpy/ScrcpyControl'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo'
import type { AdbRunner } from '../adb'
import { LEAN_MARKER_PATH, LEAN_PACKAGES } from '../LeanPackages'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { NetworkError, NetworkState, SessionJoined } from '@tapflowio/protocol'

// Test-only view of a per-device state entry (the real DeviceState is not exported).
interface TestState {
  restarting: boolean
  scrcpySession: { control: ScrcpyControl } | null
  emulatorVideo: unknown | null
  grpcClient: unknown | null
  streamWs: WebSocket | null
  touchHelper: {
    pressButton: ReturnType<typeof vi.fn>
    touchMove: ReturnType<typeof vi.fn>
    touchEnd: ReturnType<typeof vi.fn>
    touchCancel: ReturnType<typeof vi.fn>
    pinchEnd: ReturnType<typeof vi.fn>
  } | null
  videoWidth: number
  videoHeight: number
  /** What `session:chrome` carries — the rotated size the viewer shows. */
  displayWidth: number
  displayHeight: number
  /** Quarter turns from natural to what Android draws; null on the scrcpy backend. */
  rotation: 0 | 90 | 180 | 270 | null
  /** Quarter turns the viewer applies to the video to match the screen. */
  streamRotation: 0 | 90 | 180 | 270
  reconciling: boolean
  screenWatch: ReturnType<typeof setInterval> | null
  landscape: boolean
  booted: boolean
  bootSeq: number
  deviceId: string
  /** The skin orientation the last frame reported. */
  skin: SkinRotation | null
  /** The newest frame, recorded as it arrives — ahead of the reconcile that writes `skin`. */
  latestFrame: { w: number; h: number; skin: SkinRotation | null } | null
  /** The grid injected touches land in; null falls back to the panel size. */
  touchRange: { width: number; height: number } | null
  posturing: boolean
  /** The panel's corner radius in device pixels. */
  cornerRadiusPx: number
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
  lastPingAt: number | null
  lastSocketError: string | undefined
  restartVideoStream(state: TestState): Promise<void>
  cleanupDeviceState(state: TestState): void
  finishPosture(state: TestState | null, serial: string, before: 0 | 90 | 180 | 270 | null): Promise<void>
  handleRelayMessage(msg: unknown): void
  reconcileScreen(state: TestState, serial: string, frameW: number, frameH: number, skin: SkinRotation | null): Promise<boolean>
  toDevicePx(state: TestState, x: number, y: number): { px: number; py: number }
  normaliseOnBoot(state: TestState, serial: string): Promise<void>
  uprightOnBoot(serial: string): Promise<void>
  watchScreen(state: TestState, serial: string, skin: SkinRotation): void
  prepareBody(state: TestState, serial: string, upright: boolean): Promise<void>
  sendChrome(state: TestState): void
  reconcileSerial(state: TestState, serial: string, w: number, h: number, skin: SkinRotation | null): Promise<boolean>
  startAppLogStreamAfterLaunch(
    sessionId: string, state: TestState, serial: string, bundleId: string, launchId: string, generation: number
  ): Promise<void>
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
  // Every boot reports network state (#607), so without this the real `AdbWrapper.airplaneMode`
  // parses `''`, throws, and each of the ~27 boot tests silently runs the degraded
  // `unsupported-device` path — a default device that is a device tapflow cannot steer. The
  // network tests spy over this; everyone else just gets a device that is on the network.
  vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
  // Every boot reads the rotation lock (#910); an auto-rotating device is the one it leaves alone.
  vi.spyOn(adb, 'getUserRotation').mockResolvedValue({ mode: 'free' })
  // An emulator's body, as the console reports it: upright, and a quarter clockwise per `emu rotate` (measured).
  const body = { at: 0 as 0 | 90 | 180 | 270 }
  ;(adb as unknown as { body: typeof body }).body = body
  vi.spyOn(adb, 'readBodyRotation').mockImplementation(async () => body.at)
  vi.spyOn(adb, 'rotateBodyClockwise').mockImplementation(async () => { body.at = ((body.at + 90) % 360) as 0 | 90 | 180 | 270 })
  vi.spyOn(adb, 'freeRotation').mockResolvedValue(undefined)
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


// The agent samples `dumpsys` until the display settles — a real ~300ms wait per fold. The suite
// drives the sampling directly in the test below and does not need the delay anywhere else.
process.env.TAPFLOW_METRICS_GAP_MS = '1'

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

    // The dashboard draws the boot skeleton from this before the device is up. Read from each AVD's
    // config.ini by name, at register only. Mutations: leave it out of the register literal (the
    // explicit field list there is what drops anything not named); look it up by the device id
    // (`avd:<name>`) rather than the AVD name.
    it('registers each AVD with the form factor its config gives', async () => {
      const avdFormFactor = vi.fn((name: string) => (name === 'Pixel_8_API_34' ? 'tablet' as const : undefined))
      const agent = new AndroidAgent({ avdFormFactor }, mockAdb())
      const relayWs = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(relayWs)
      await agent.connect(`ws://localhost:${port}`)
      relayWs.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(relayWs, 'agents:listed')
      const sessions = listed['sessions'] as Array<{ devices: Array<{ formFactor?: string }> }>
      expect(sessions[0].devices[0].formFactor).toBe('tablet')
      expect(avdFormFactor).toHaveBeenCalledWith('Pixel_8_API_34')
      agent.disconnect()
      relayWs.close()
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

  // The two memory reads run off the event loop now (they held it 4 ms in a built agent and ~200 ms under tsx,
  // every 5 s), so a sample can land after the socket it was taken for closed.
  describe('resource reports (agent:resources)', () => {
    type Internals = {
      resources: { getMemoryUsage: () => Promise<{ memUsedMB: number; memTotalMB: number }>; getMemoryPressure: () => Promise<undefined> }
      reportResources: () => Promise<void>
      sendOn: (ws: unknown, msg: { type: string }) => void
    }
    function holdSamples(agent: AndroidAgent) {
      const internals = agent as unknown as Internals
      const releases: Array<() => void> = []
      internals.resources.getMemoryUsage = () => new Promise((r) => { releases.push(() => r({ memUsedMB: 1, memTotalMB: 2 })) })
      internals.resources.getMemoryPressure = () => Promise.resolve(undefined)
      const sendOn = vi.spyOn(internals, 'sendOn')
      return { internals, releases, reports: () => sendOn.mock.calls.filter(([, msg]) => msg.type === 'agent:resources').length }
    }

    it('takes one sample at a time', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      const { internals, releases, reports } = holdSamples(agent)
      await agent.connect(`ws://localhost:${port}`) // its own report is the one in flight
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      await internals.reportResources()
      expect(releases).toHaveLength(1)
      releases[0]()
      await vi.waitFor(() => expect(reports()).toBe(1))
      agent.disconnect()
    })

    it('sends nothing for a sample that lands after its socket closed, and sends one that lands while open', async () => {
      const stale = new AndroidAgent({}, mockAdb())
      const held = holdSamples(stale)
      await stale.connect(`ws://localhost:${port}`)
      await vi.waitFor(() => expect(held.releases).toHaveLength(1))
      stale.disconnect()
      held.releases[0]()
      await new Promise((r) => setTimeout(r, 30))
      expect(held.reports()).toBe(0)

      const live = new AndroidAgent({}, mockAdb())
      const open = holdSamples(live)
      await live.connect(`ws://localhost:${port}`)
      await vi.waitFor(() => expect(open.releases).toHaveLength(1))
      open.releases[0]()
      await vi.waitFor(() => expect(open.reports()).toBe(1))
      live.disconnect()
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
        requestId: 'rq-fix-1',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))

      await waitForType(browser, 'device:booting')
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['payload']).toMatchObject({ deviceId: 'avd:Pixel_8_API_34' })

      agent.disconnect()
      browser.close()
    })

    // The relay's boot gate charges a boot by this (L2 admission plan, S2): an emulator this boot
    // launched costs the host 30-90 s of memory pressure, one adb already sees costs nothing. Full
    // reset is covered with its own suite below, since it launches whatever adb said.
    it.each([
      { booted: false, cold: true },
      { booted: true, cold: false },
    ])('reports cold=$cold on device:ready when the emulator was booted=$booted', async ({ booted, cold }) => {
      const agent = new AndroidAgent({}, mockAdb(booted))
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-cold',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      const ready = await readyPromise
      expect((ready['payload'] as { cold?: boolean }).cold).toBe(cold)

      agent.disconnect()
      browser.close()
    })

    describe('run reset (flow run)', () => {
      /** A booted emulator where `installed` are the packages `pm path` finds. Returns the `pm` calls made. */
      async function bootWithReset(runReset: unknown, installed: string[], pathFails?: Error) {
        const adb = mockAdb(true)
        const pm: string[] = []
        const runner = (adb as unknown as { runner: AdbRunner }).runner
        vi.mocked(runner.exec).mockImplementation(async (...args: string[]) => {
          const at = args.indexOf('pm')
          if (at < 0) return ''
          const [verb, pkg] = [args[at + 1]!, args[at + 2]!]
          // The boot reads `pm list packages` for itself (Lean mode); only the reset's two verbs are recorded.
          if (verb !== 'path' && verb !== 'clear') return ''
          pm.push(`${verb} ${pkg}`)
          if (verb === 'path') {
            if (pathFails) throw pathFails
            // What `pm path` does for a package that is not installed: exit 1, no output.
            if (!installed.includes(pkg)) throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: '' })
            return `package:/data/app/${pkg}/base.apk`
          }
          if (verb === 'clear') return 'Success'
          return ''
        })
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const readyPromise = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-reset', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset } }))
        const payload = (await readyPromise)['payload'] as Record<string, unknown>
        agent.disconnect(); browser.close()
        return { pm, payload }
      }

      // A run replays from the same orientation whatever a person left: its boot stands the emulator's body up,
      // although this device was already running. Mutation: drop `runReset` from the boot's upright.
      it('stands the emulator\'s body up for a run, wherever it was left', async () => {
        const adb = mockAdb(true)
        ;(adb as unknown as { body: { at: number } }).body.at = 180
        const agent = new AndroidAgent({}, adb)
        // The wiring itself: this suite streams over scrcpy, which stands an emulator up whatever the boot asked.
        const prepare = vi.spyOn(agent as unknown as { prepareBody(s: unknown, serial: string, upright: boolean): Promise<void> }, 'prepareBody')
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-reset-body', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset: { uninstall: [], clear: [] } } }))
        await ready
        expect(prepare).toHaveBeenCalledWith(expect.anything(), 'emulator-5554', true)
        expect((adb as unknown as { body: { at: number } }).body.at).toBe(0)
        agent.disconnect(); browser.close()
      })

      it('clears every app it was named, installed ones only, and reports app-data', async () => {
        const { pm, payload } = await bootWithReset({ uninstall: ['com.example.app'], clear: ['com.example.helper'] }, ['com.example.app'])
        expect(pm).toEqual(['path com.example.app', 'clear com.example.app', 'path com.example.helper'])
        // The scrcpy backend has no gRPC client, so the clipboard is not reset and not claimed.
        expect(payload['runReset']).toEqual({ done: ['app-data'], failed: [] })
      })

      // Only "not installed" is nothing to clear: a device that cannot answer has cleared nothing.
      it('fails app-data when the package manager cannot answer, rather than calling the app clean', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const offline = Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: 'error: device offline' })
        const { payload } = await bootWithReset({ uninstall: ['com.example.app'], clear: [] }, ['com.example.app'], offline)
        expect(payload['runReset']).toEqual({ done: [], failed: ['app-data'] })
      })

      // Failing the step does not stop a clear still running on the device, and the run installs right after the ready.
      it('fails the boot instead of announcing it while a pm clear is still running', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const adb = mockAdb(true)
        const runner = (adb as unknown as { runner: AdbRunner }).runner
        vi.mocked(runner.exec).mockImplementation(async (...args: string[]) => {
          const at = args.indexOf('pm')
          if (at < 0) return ''
          if (args[at + 1] === 'path') return 'package:/data/app/com.example.app/base.apk'
          if (args[at + 1] === 'clear') return new Promise<string>(() => {})
          return ''
        })
        const agent = new AndroidAgent({ runResetCmdTimeoutMs: 50 }, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const seen: string[] = []
        browser.on('message', (d) => { const m = JSON.parse(String(d)) as { type: string }; if (m.type === 'device:ready' || m.type === 'device:boot-error') seen.push(m.type) })
        const failed = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-late-clear', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset: { uninstall: ['com.example.app'], clear: [] } } }))
        const e = await failed
        expect(e['requestId']).toBe('rq-late-clear')
        expect(String(e['message'])).toContain('pm clear from a run reset is still running')
        expect(seen).toEqual(['device:boot-error'])
        agent.disconnect(); browser.close()
      })

      // The clear outlives the boot that started it; a newer boot, which asked for no reset, must not announce over it.
      it('holds a newer boot\'s ready for a pm clear an older boot left running', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const adb = mockAdb(true)
        const runner = (adb as unknown as { runner: AdbRunner }).runner
        let releaseClear!: (out: string) => void
        let clearStarted!: () => void
        const started = new Promise<void>((r) => { clearStarted = r })
        vi.mocked(runner.exec).mockImplementation(async (...args: string[]) => {
          const at = args.indexOf('pm')
          if (at < 0) return ''
          if (args[at + 1] === 'path') return 'package:/data/app/com.example.app/base.apk'
          if (args[at + 1] === 'clear') { clearStarted(); return new Promise<string>((r) => { releaseClear = r }) }
          return ''
        })
        const agent = new AndroidAgent({ runResetCmdTimeoutMs: 2_000 }, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const order: string[] = []
        browser.on('message', (d) => { const m = JSON.parse(String(d)) as { type: string; requestId?: string }; if (m.type === 'device:ready') order.push(`ready:${m.requestId}`) })
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-old', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset: { uninstall: ['com.example.app'], clear: [] } } }))
        await started
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-new', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
        await new Promise((r) => setTimeout(r, 200))
        order.push('clear-settled')
        releaseClear('Success')
        expect((await ready)['requestId']).toBe('rq-new')
        expect(order).toEqual(['clear-settled', 'ready:rq-new'])
        agent.disconnect(); browser.close()
      })

      // A client that joins without booting (MCP's connect_device) reaches the app commands without the boot's wait.
      it('holds an app command for a pm clear a failed reset left running', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const adb = mockAdb(true)
        const runner = (adb as unknown as { runner: AdbRunner }).runner
        let releaseClear!: (out: string) => void
        vi.mocked(runner.exec).mockImplementation(async (...args: string[]) => {
          const at = args.indexOf('pm')
          if (at < 0) return ''
          if (args[at + 1] === 'path') return 'package:/data/app/com.example.app/base.apk'
          if (args[at + 1] === 'clear') return new Promise<string>((r) => { releaseClear = r })
          return ''
        })
        const order: string[] = []
        vi.spyOn(adb, 'openUrl').mockImplementation(async () => { order.push('open-url') })
        const agent = new AndroidAgent({ runResetCmdTimeoutMs: 500 }, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const failed = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-stuck', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset: { uninstall: ['com.example.app'], clear: [] } } }))
        await failed
        const done = waitForType(browser, 'open-url:done')
        browser.send(JSON.stringify({ type: 'open-url', requestId: 'rq-url', sessionId: agent.sessionId, payload: { url: 'myapp://home' } }))
        await new Promise((r) => setTimeout(r, 30))
        order.push('clear-settled')
        releaseClear('Success')
        await done
        expect(order).toEqual(['clear-settled', 'open-url'])
        agent.disconnect(); browser.close()
      })

      it('never hands an id that is not an app id to the device shell', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { pm, payload } = await bootWithReset({ uninstall: [], clear: ['x;reboot'] }, [])
        expect(pm).toEqual([])
        expect(payload['runReset']).toEqual({ done: [], failed: ['app-data'] })
      })

      it('resets nothing for a boot that did not ask', async () => {
        const { pm, payload } = await bootWithReset(undefined, ['com.example.app'])
        expect(pm).toEqual([])
        expect(payload).not.toHaveProperty('runReset')
      })
    })

  })

  // ── Lean mode: bundled apps kept disabled, reconciled after every boot ──────────────────────
  describe('Lean mode', () => {
    let agent: AndroidAgent
    let browser: WebSocket
    afterEach(() => { agent?.disconnect(); browser?.close() })

    /** A device whose package state and marker file live in memory, behind the real wrapper's methods. */
    function withPackages(booted: boolean) {
      const adb = mockAdb(booted)
      const enabled = new Set(['android', ...LEAN_PACKAGES])
      const disabled = new Set<string>()
      let marker: string | null = null
      vi.spyOn(adb, 'packageStates').mockImplementation(async () => ({ enabled: new Set(enabled), disabled: new Set(disabled) }))
      vi.spyOn(adb, 'setPackageEnabled').mockImplementation(async (_s, pkg, on) => {
        ;(on ? disabled : enabled).delete(pkg); (on ? enabled : disabled).add(pkg)
      })
      vi.spyOn(adb, 'readDeviceFile').mockImplementation(async () => marker)
      vi.spyOn(adb, 'writeDeviceFile').mockImplementation(async (_s, _p, c) => { marker = c })
      vi.spyOn(adb, 'removeDeviceFile').mockImplementation(async () => { marker = null })
      return { adb, disabled }
    }

    async function boot(adb: AdbWrapper, lean: boolean) {
      agent = new AndroidAgent({ lean }, adb)
      await agent.connect(`ws://localhost:${port}`)
      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-lean', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      await waitForType(browser, 'device:ready')
    }

    it('disables the apps on an emulator it launched', async () => {
      const { adb, disabled } = withPackages(false)
      await boot(adb, true)
      await vi.waitFor(() => expect([...disabled].sort()).toEqual([...LEAN_PACKAGES].sort()))
      expect(adb.writeDeviceFile).toHaveBeenCalledWith('emulator-5554', LEAN_MARKER_PATH, expect.any(String))
    })

    it('leaves an emulator it only attached to as it is', async () => {
      // The twin of the case above: same device, only already running.
      const { adb } = withPackages(true)
      await boot(adb, true)
      await new Promise((r) => setTimeout(r, 50))
      expect(adb.setPackageEnabled).not.toHaveBeenCalled()
      expect(adb.writeDeviceFile).not.toHaveBeenCalled()
    })

    it('with Lean mode off, asks for the marker and nothing else on a device it never touched', async () => {
      const { adb } = withPackages(false)
      await boot(adb, false)
      await vi.waitFor(() => expect(adb.readDeviceFile).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))
      expect(adb.packageStates).not.toHaveBeenCalled()
      expect(adb.setPackageEnabled).not.toHaveBeenCalled()
    })

    it('logs a device it cannot reconcile and leaves it for the next boot', async () => {
      const { adb } = withPackages(false)
      vi.mocked(adb.packageStates).mockRejectedValue(new Error('device offline'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await boot(adb, true)
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('not reconciled'), expect.stringContaining('device offline')))
      expect(adb.setPackageEnabled).not.toHaveBeenCalled()
    })

    it('stops writing once the device is shut down mid-reconcile', async () => {
      // The twin is the first case in this block: same device, no shutdown, and the writes happen.
      const { adb } = withPackages(false)
      const real = vi.mocked(adb.packageStates).getMockImplementation()!
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      vi.mocked(adb.packageStates).mockImplementation(async (s) => { await held; return real(s) })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await boot(adb, true)
      await vi.waitFor(() => expect(adb.packageStates).toHaveBeenCalled())
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-off', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      await waitForType(browser, 'device:shutdown-done')
      release()
      await new Promise((r) => setTimeout(r, 50))
      expect(adb.writeDeviceFile).not.toHaveBeenCalled()
      expect(adb.setPackageEnabled).not.toHaveBeenCalled()
    })
  })

  // ── #607: network on/off, via airplane mode ────────────────────────────────────────────────
  describe('network control', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket

    /**
     * A device whose airplane mode reads as `initial` and follows what it is told.
     *
     * The doubles mirror the real wrapper's contract: `setAirplaneMode` **returns** what it
     * observed rather than throwing when it cannot confirm. An earlier version had the write
     * resolve while the read rejected — a combination the real wrapper cannot produce, since it
     * calls the read itself, so the test was pinning an unreachable path.
     */
    function withAirplane(initial = false, setBehaviour?: (on: boolean) => void) {
      adb = mockAdb(true)
      let state = initial
      vi.spyOn(adb, 'airplaneMode').mockImplementation(async () => state)
      vi.spyOn(adb, 'setAirplaneMode').mockImplementation(async (_s: string, on: boolean) => {
        setBehaviour?.(on)
        state = on
        return { confirmed: true, offline: on }
      })
      return adb
    }

    async function session(a: AdbWrapper) {
      agent = new AndroidAgent({}, a)
      await agent.connect(`ws://localhost:${port}`)
      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
    }

    const set = (offline: boolean, requestId = 'rq-net') =>
      browser.send(JSON.stringify({
        type: 'network:set', sessionId: agent.sessionId, requestId, payload: { offline },
      }))

    /** Boot, and wait past the unsolicited report the boot itself produces. */
    async function booted() {
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      await waitForType(browser, 'network:state')
    }

    afterEach(() => { agent?.disconnect(); browser?.close() })

    it('takes the device offline and answers with the state', async () => {
      await session(withAirplane(false))
      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(adb.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', true)
      expect(state.requestId).toBe('rq-net')
      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('puts it back', async () => {
      await session(withAirplane(true))
      set(false)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(adb.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // Cleanup runs at **boot**, not at session end. Airplane mode lives in the AVD's userdata, so
    // it outlives `emu kill` — and a session that ended in a crash, a closed terminal or `dev:down`
    // never reaches a teardown path at all. Clearing on the way up is the only version that
    // survives however the last session died. Same conclusion the iOS half reached for its
    // condition file, for the same reason.
    it('clears a device left offline by whoever had it last', async () => {
      const a = withAirplane(true)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // Barrier first, then read the recording — the reset runs after `device:ready` goes out.
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(a.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // The boot path's own version of the blocker above. The reset reads the device, fails to
    // clear it, and then reports — and if that second read fails too, the fact it already learned
    // must survive into the report. Dropping it renders "online" over a device the agent just
    // established is offline.
    it('carries what the reset learned into the report when the re-read fails', async () => {
      const a = mockAdb(true)
      let reads = 0
      vi.spyOn(a, 'airplaneMode').mockImplementation(async () => {
        if (++reads > 1) throw new Error('cannot read')
        return true                                  // left offline by whoever had it last
      })
      vi.spyOn(a, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(a)

      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // **The report the protocol promises on `device:ready`, and the commonest frame to carry #667's
    // lie.** The reset started from `known = false`, so a boot whose read failed reported "online" for a
    // device nobody had read. It must still report — the frame is promised — but with no position.
    //
    // `Object.keys`, not `toEqual`: `toEqual` treats an `offline: undefined` key as absent, and the key's
    // absence is the whole contract on the wire.
    it('reports a boot it could not read as unobserved, not as online', async () => {
      const a = mockAdb(true)
      vi.spyOn(a, 'airplaneMode').mockRejectedValue(new Error('device offline'))
      vi.spyOn(a, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(a)

      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ available: false, reason: 'state-unconfirmed' })
      expect(Object.keys(state.payload).sort()).toEqual(['available', 'reason'])
    })

    // The boot reset **writes to the device**, so it has to answer to `bootSeq` like every other
    // await in that path. The window is a real one: the read below is an adb round trip, and a
    // tester whose device just went ready can arm the toggle inside it — after which a superseded
    // boot waking up would put them back online with nobody having asked.
    it('abandons the boot-time reset when a newer boot supersedes it', async () => {
      const a = mockAdb(true)
      // One resolver per call, kept in order — a single slot would be overwritten by the second
      // boot's own read, and releasing that would wake the *current* reset rather than the
      // superseded one, which is a different test that would pass for the wrong reason.
      const parked: Array<() => void> = []
      vi.spyOn(a, 'airplaneMode').mockImplementation(
        () => new Promise((r) => { parked.push(() => r(true)) }),
      )
      const setSpy = vi.spyOn(a, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: false })
      await session(a)

      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-1', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(parked.length).toBe(1))

      // A second boot bumps the seq while the first reset is parked on its read.
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-2', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      await vi.waitFor(() => expect(parked.length).toBe(2))
      setSpy.mockClear()
      parked[0]!()                   // the superseded reset wakes up holding "device is offline"
      await new Promise((r) => setTimeout(r, 50))

      expect(setSpy).not.toHaveBeenCalled()
    })

    // The control. Without it, an implementation that flips airplane mode on every boot passes the
    // two above — and takes a tester's device off the network with nobody having asked. It also
    // pins that the clear above is conditional: a device already online is left alone.
    it('touches airplane mode for nothing else', async () => {
      const a = withAirplane(false)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // `device:ready` is the trigger's echo, not a barrier — the reset is dispatched with `void`
      // on the line after it. Its own last act is this report, so waiting for it is what puts the
      // absence assertion after the work rather than beside it.
      await waitForType(browser, 'network:state')

      expect(a.setAirplaneMode).not.toHaveBeenCalled()
    })

    // A device that cannot do this is **answering**, not failing: `network:state` with a reason the
    // viewer can render, never `network:error`. The two are told apart by the test below.
    //
    // The reason is `state-unconfirmed` and not `unsupported-device`, even though the error here is
    // literally an image without the command: a write that threw is also what a rebooting device and
    // a dropped adb connection produce, and nothing in the failure tells them apart (#618). Calling
    // it permanent would tell a tester to give up on a device that is coming back in twenty seconds.
    it('reports a write that threw as unconfirmed rather than as a dead image', async () => {
      const a = withAirplane(false, () => { throw new Error('cmd: not found') })
      await session(a)
      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      // `toEqual`, not `toMatchObject`: `offline` is the field that carries the truth here, and
      // leaving it unasserted is what let a mutation report the requested value instead of the
      // device's. `reason` too — each value makes a different sentence on screen.
      expect(state.payload).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
      expect(state.requestId).toBe('rq-net')
    })

    // …and a device with no session state is a failure, in the shape the request's waiter reads.
    it('answers network:error when there is no booted device', async () => {
      adb = mockAdb(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)
      set(true)
      const err = await waitForType<NetworkError>(browser, 'network:error')

      expect(err.requestId).toBe('rq-net')
      expect(err.message.length).toBeGreaterThan(0)
      expect(adb.setAirplaneMode).not.toHaveBeenCalled()
    })

    // The first of the three unsolicited producers the protocol names. Without it a viewer that
    // opens a session has no idea whether the device it is looking at is on the network.
    it('reports the state unsolicited once the device is ready', async () => {
      const a = withAirplane(false)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.requestId).toBeUndefined()
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // It reads the device, not a flag the agent kept. An agent that remembers what it last set
    // cannot see a device someone else changed, or one left offline across an agent restart.
    it('reads the device rather than its own memory', async () => {
      const a = withAirplane(true)
      await session(a)
      set(true)
      await waitForType(browser, 'network:state')

      expect(a.airplaneMode).toHaveBeenCalledWith('emulator-5554')
    })

    // **The blocker this review found.** The wrapper writes first and confirms second, so a
    // confirmation that fails leaves a device that has probably already changed. Reporting the
    // pre-write value there renders "online" over an offline device — a tester signs off offline
    // behaviour they never saw, and the bug goes to the app under test. `offline` here is what the
    // wrapper observed, never what the caller had before.
    it('reports the device as offline when the write landed but could not be confirmed', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: true })
      await session(adb)

      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // The mirror, and **the pair is the discriminator** (#618). Both results are `confirmed: false`
    // and the shapes are identical, so what separates them is where `offline` sits: the test above
    // returns the value that was *requested*, which is what `setAirplaneMode` reports when the
    // read-back itself failed — nothing was observed, so `state-unconfirmed`. This one returns a
    // value that disagrees with the request, which means the read-back *succeeded* and the device had
    // not moved. Only that is an image which does not really support the command.
    //
    // Changing either `offline` here breaks the classification, not just the assertion.
    it('reports the device as online when the command was accepted and did nothing', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: false })
      await session(adb)

      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: false, available: false, reason: 'unsupported-device' })
    })

    // A write that never reached the device leaves the before-state true, and that is the one case
    // where reporting it is right. The reason is `state-unconfirmed` for the same reason as above:
    // a throw from the write says nothing about whether the device could ever do this.
    it('keeps the pre-request state when the write itself failed', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(true)     // device was already offline
      vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(adb)

      set(false)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // ── #614: the relay asks on a viewer's re-join ──────────────────────────────────────────
    //
    // Injected rather than sent from `browser`, because this frame travels relay → agent and the
    // browser socket is not that direction.
    const requestState = (sessionId = agent.sessionId) =>
      internals(agent).handleRelayMessage({ type: 'network:request-state', sessionId })

    it('reports what the device says when the relay asks on a re-join', async () => {
      const a = withAirplane(false)
      await session(a)
      await booted()
      // Taken offline *after* booting: the boot path clears a condition the last session left, so a
      // device cannot still be offline the moment it is ready. Asserting the value a fresh boot
      // happens to produce would pass on a report that read nothing at all.
      set(true)
      await waitForType(browser, 'network:state')

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      // No correlator: a report, not an answer. `toBe(undefined)` rather than a falsy check —
      // `requestId: ''` would render a reply nobody can match and pass a looser assertion.
      expect(state.requestId).toBe(undefined)
      expect(state.sessionId).toBe(agent.sessionId)
      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('reads the device again rather than replaying what it reported before', async () => {
      // The whole point of asking the agent instead of caching in the relay. If this replayed a
      // remembered value, the relay could have kept it and #614 would have had a cheaper answer.
      const a = withAirplane(false)
      await session(a)
      await booted()

      vi.mocked(a.airplaneMode).mockResolvedValue(true)   // changed outside tapflow
      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('says nothing at all when the session holds no booted device', async () => {
      // Not `network:error`: nobody asked, so there is no requester to address one to. The relay
      // gates on `readySent`, so this is the window where its view and the agent's disagree.
      //
      // Mutation: answering `network:error` here fails, provided the mutant gives it a usable
      // correlator. One written with `requestId: ''` survives — but the relay's door refuses that
      // frame before the browser ever sees it, so what survives is a mutation the wire already
      // prevents, not a gap in this assertion.
      adb = mockAdb(false)
      await session(adb)

      requestState()
      // Barrier: a correlated round trip the agent *does* answer. Its reply cannot arrive before a
      // reply the dispatcher made for the earlier frame, so reading after it is reading after both.
      browser.send(JSON.stringify({
        type: 'network:set', sessionId: agent.sessionId, requestId: 'rq-barrier', payload: { offline: true },
      }))
      const err = await waitForType<NetworkError>(browser, 'network:error')

      expect(err.requestId).toBe('rq-barrier')
      expect(adb.airplaneMode).not.toHaveBeenCalled()
    })

    it('falls back to the last value it saw, not to online, when the re-read fails', async () => {
      // `NetworkNotSteerable.offline` is declared "still the device's real state". The re-join report
      // is the first producer with no freshly measured value to pass — the boot path and `network:set`
      // both hand over something they just read — so without a remembered one it would answer
      // `offline: false` for a device that is offline and momentarily unreadable.
      //
      // Mutation: defaulting `lastKnownOffline` to `false` reads `offline: false` here.
      const a = withAirplane(false)
      await session(a)
      await booted()

      set(true)
      await waitForType(browser, 'network:state')       // now known-offline, confirmed
      vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    it('does not let an unconfirmed write overwrite what it confirmed earlier', async () => {
      // Standing one guess on another: an unconfirmed write already reports a value it could not
      // verify, and letting that become the fallback would outlive the read it stood in for.
      //
      // The earlier confirmed value is what makes this readable — without it both behaviours end in
      // the silence below, and the test could not tell them apart.
      //
      // Mutation: dropping `result.confirmed` from the store reads `offline: false` here.
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)

      set(true)
      await waitForType(browser, 'network:state')      // confirmed offline — this is what it knows
      // The fake device follows its own write. `confirmed: true` *means* the read-back agreed, so a
      // read that goes on answering `false` afterwards is a device that cannot exist — and the write
      // path now remembers a successful pre-write read as well, which that contradiction would send
      // backwards for a reason having nothing to do with what this test holds.
      vi.mocked(adb.airplaneMode).mockResolvedValue(true)

      vi.mocked(adb.setAirplaneMode).mockResolvedValue({ confirmed: false, offline: false })
      set(false, 'rq-unconfirmed')
      await waitForType(browser, 'network:state')
      vi.mocked(adb.airplaneMode).mockRejectedValue(new Error('gone'))

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    it('says nothing when it has never seen the device and cannot read it now', async () => {
      // `false` is not "unknown", it is "on the network" — and `NetworkNotSteerable.offline` is declared
      // to be the device's real state. A boot whose own read failed records nothing, so a tester who
      // then flips airplane mode in the emulator's own UI leaves a device that is offline, unreadable
      // and never observed. Reporting it would claim the one direction that hides the problem.
      //
      // Mutation: falling back to `false` instead of staying silent answers here, and the barrier's
      // reply is then the second `network:state` rather than the first.
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)

      requestState()
      // Barrier: a correlated request the agent does answer, sent after. Its reply cannot arrive before
      // one the dispatcher made for the earlier frame, so the first `network:state` to land tells us
      // whether the report was sent.
      set(true, 'rq-barrier')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.requestId).toBe('rq-barrier')
    })

    // The answer to `network:set` cannot stay silent the way the re-join report does, and it used to
    // answer `offline: false` — the exact frame #667 was filed about.
    it('answers a write it could neither make nor read on an unobserved device with no position', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
      vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(adb)

      set(true, 'rq-unobserved')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.requestId).toBe('rq-unobserved')
      expect(state.payload).toEqual({ available: false, reason: 'state-unconfirmed' })
      expect(Object.keys(state.payload).sort()).toEqual(['available', 'reason'])
    })

    // Injected past the relay, which is the only way to reach these: its schema requires
    // `payload.offline` and refuses the frame itself, so a browser cannot produce one. That door
    // is not the agent's, though — inbound is unvalidated here (#444), and the dispatch swallows a
    // synchronous throw, so a cast through a missing payload would answer *nothing* and leave the
    // requester on its own timeout. Same reason `input:button` destructures defensively.
    for (const [label, payload] of [
      ['no payload', undefined],
      ['a payload with no offline', {}],
      ['a non-boolean offline', { offline: 'true' }],
    ] as const) {
      it(`answers network:error for a network:set with ${label}`, async () => {
        await session(withAirplane(false))
        const errored = waitForType<NetworkError>(browser, 'network:error')
        internals(agent).handleRelayMessage({
          type: 'network:set', sessionId: agent.sessionId, requestId: 'rq-bad', payload,
        })

        const err = await errored
        expect(err.requestId).toBe('rq-bad')
        // Not just *an* error: the no-device case at the top of `handleNetworkSet` sends the same
        // label, and the two are a different fix for the tester. The message is the only thing
        // that separates them, so collapsing the guard into that path has to fail here.
        expect(err.message).toContain('offline')
        expect(adb.setAirplaneMode).not.toHaveBeenCalled()
      })
    }

    // A reply carrying `requestId: ''` correlates to nothing, so sending one would change the
    // device and leave the requester waiting anyway — for a mutation that is the worse half of the
    // trade. `correlatorOf` drops it instead, which is what every other correlated case does.
    //
    // Mutation: replacing `correlatorOf` with the old `msg as unknown as { requestId: string }`
    // cast makes this fail — a `network:state` arrives before the valid request's, with `''` on it.
    it('drops a network:set whose correlator is empty, rather than answering uncorrelatably', async () => {
      const a = withAirplane(false)
      await session(a)
      internals(agent).handleRelayMessage({
        type: 'network:set', sessionId: agent.sessionId, requestId: '', payload: { offline: true },
      })
      // The barrier: a well-formed request sent *after* it. Its reply cannot arrive before one the
      // dispatcher made for the empty frame, so reading here is reading after both were handled.
      set(false, 'rq-after')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.requestId).toBe('rq-after')
      expect(a.setAirplaneMode).toHaveBeenCalledTimes(1)
      expect(a.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
    })

    // ── the capability path answers the same question, so it must give the same answer ────────
    //
    // `setNetworkOffline` and `networkState` are the in-process capability, not what `mcp-server`
    // or `flow-runner` call — those address a session over the wire (#617). They had
    // **no test at all**, which is how the doc on `setNetworkOffline` came to record that the two
    // paths "must not disagree… and this one drifted first". A narrowed `unsupported-device` makes a
    // repeat worse than the drift it describes: a caller reading it as permanent would be told a
    // rebooting device can never do this.
    describe('capability path', () => {
      it('classifies an accepted write that did nothing the same as the WS path', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
        vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: false })
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(true))
          .toEqual({ offline: false, available: false, reason: 'unsupported-device' })
      })

      it('classifies a write it could not read back as unconfirmed, not as a dead image', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
        vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: true })
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(true))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('reports a write that threw as unconfirmed, keeping the state it read before', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(true)
        vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(false))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('keeps a confirmed offline device offline when both the read and the write fail', async () => {
        // **Two failures in a row, which is the one case that used to drop the memory.** The pre-write
        // read falls back to what was last confirmed and the write then throws, so the answer is
        // whatever the agent last knew — not `false`, which draws an online control over a device
        // whose app can reach nothing and sends the next bug report to the app under test.
        const a = withAirplane(false)
        await session(a)
        await booted()
        expect(await agent.setNetworkOffline(true)).toEqual({ offline: true, available: true })

        vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))
        vi.mocked(a.setAirplaneMode).mockRejectedValue(new Error('exit 255'))

        expect(await agent.setNetworkOffline(false))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
        expect(await agent.networkState())
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('answers with no position for a device it has never observed and cannot read', async () => {
        // **`false` is not "unknown", it is "on the network".** With nothing ever confirmed and the
        // read failing, there is no position to report. This used to throw, because the payload could
        // not say so; `NetworkUnobserved` can (#667), and the capability promises an answer rather than
        // an error for a device that is there.
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
        await session(adb)

        const state = await agent.networkState()
        expect(state).toEqual({ available: false, reason: 'state-unconfirmed' })
        expect(Object.keys(state).sort()).toEqual(['available', 'reason'])
      })

      it('remembers what its own read saw, so a later failed read keeps that position', async () => {
        // The capability read is an observation like any other. Without remembering it, a device this
        // path had just read as offline answered `NetworkUnobserved` on the next failure — "nobody
        // knows" about a position the agent had seen.
        //
        // Mutation: dropping the memory write in `networkState` answers with no position here.
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(true)
        await session(adb)
        expect(await agent.networkState()).toEqual({ offline: true, available: true })

        vi.mocked(adb.airplaneMode).mockRejectedValue(new Error('device offline'))
        expect(await agent.networkState())
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('answers a failed write on an unobserved device with no position, with no undefined key', async () => {
        // In-process the object is never serialised, so an `offline: undefined` key would survive and
        // disagree with the wire under `'offline' in p` — see `NetworkUnobserved`.
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
        vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
        await session(adb)

        const state = await agent.setNetworkOffline(true)
        expect(state).toEqual({ available: false, reason: 'state-unconfirmed' })
        expect(Object.keys(state).sort()).toEqual(['available', 'reason'])
      })

      it('still answers with the last confirmed value when a read fails', async () => {
        // The other half, and the reason the throw above is narrow: once something *has* been
        // confirmed, an unreadable device is still that value. Reporting it as online is what sends a
        // tester to file against an app that cannot reach anything.
        const a = withAirplane(false)
        await session(a)
        await booted()
        await agent.setNetworkOffline(true)

        vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))

        expect(await agent.networkState())
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('answers a confirmed write as steerable', async () => {
        const a = withAirplane(false)
        await session(a)
        await booted()

        expect(await agent.setNetworkOffline(true)).toEqual({ offline: true, available: true })
        expect(await agent.networkState()).toEqual({ offline: true, available: true })
      })
    })
  })

  describe('device:boot flow — full reset', () => {
    // ── #447: Full reset — `-wipe-data`, the counterpart to iOS's `simctl erase` ──────────────

    describe('resetMode: full-erase', () => {
      /** The launcher this agent built, so the flags it was launched with can be read. */
      function launcherOf(agent: AndroidAgent) {
        return (agent as unknown as {
          launcher: {
            launch: ReturnType<typeof vi.fn>
            waitForExit: ReturnType<typeof vi.fn>
          }
        }).launcher
      }

      /** What the emulator will actually be told, not how the caller spelled it. `wipeData` absent
       *  and `wipeData: false` produce the same command line (`buildEmulatorArgs` reads it as
       *  falsy), so asserting the key's presence would fail a refactor that is behaviourally
       *  identical — and pass none that is not. */
      function wipedOnFirstLaunch(agent: AndroidAgent): boolean {
        const opts = launcherOf(agent).launch.mock.calls[0]?.[2] as { wipeData?: boolean } | undefined
        return opts?.wipeData ?? false
      }

      async function boot(agent: AndroidAgent, resetMode?: 'app-only' | 'full-erase') {
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-wipe',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34', ...(resetMode ? { resetMode } : {}) },
        }))
        return browser
      }

      // The suite's default is "no emulator process". Each test states which world it is in, because
      // the stop branch is gated on the process rather than on adb's view of it.
      //
      // Both are module-level `vi.fn()`s shared by every test in the file, so the call history has
      // to be cleared as well as the return value — a `not.toHaveBeenCalled()` reading a previous
      // test's call is a failure that points at the wrong test.
      beforeEach(() => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'gone' })
        vi.mocked(stopEmulatorProcess).mockClear()
      })
      afterEach(() => vi.mocked(probeEmulator).mockReturnValue({ state: 'gone' }))

      it('launches with wipeData when the toggle was armed', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(true)

        agent.disconnect(); browser.close()
      })

      // The control. Without it the assertion above passes on an implementation that wipes every
      // boot, which is the worse of the two failures — it erases devices nobody asked it to.
      it('does not wipe an ordinary boot', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(false)

        agent.disconnect(); browser.close()
      })

      it('passes app-only through as no wipe', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'app-only')
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(false)

        agent.disconnect(); browser.close()
      })

      it('stops an already-running emulator first, then relaunches it wiped', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        const ready = await waitForType(browser, 'device:ready')

        expect(shutdown).toHaveBeenCalledWith('emulator-5554')
        expect(wipedOnFirstLaunch(agent)).toBe(true)
        // adb saw it running, and the boot still brought it up from off: the gate must charge it.
        expect((ready['payload'] as { cold?: boolean }).cold).toBe(true)

        agent.disconnect(); browser.close()
      })

      // The mirror of the test above, and the one that keeps the `fullErase &&` in the condition
      // honest: an ordinary boot must not touch a running emulator, or every tester loses the
      // device they were using to a cold boot nobody asked for.
      it('leaves a running emulator alone on an ordinary boot', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()
        // Paired with the launch, so this cannot pass by the boot having failed before reaching it.
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // Relaunching before the old qemu process is gone races the AVD's lock file. Nothing in
      // `emu kill` waits — it returns as soon as the console accepts it.
      it('waits for the old process to exit before relaunching, naming the AVD not the device id', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)

        const l = launcherOf(agent)
        const order: string[] = []
        l.waitForExit.mockImplementation(async () => { order.push('waited') })
        l.launch.mockImplementation(() => { order.push('launched') })

        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(order).toEqual(['waited', 'launched'])
        // `avd:Pixel_8_API_34` is three lines away in the same block and would make `pgrep` match
        // nothing, so the wait would return at once and buy nothing at all.
        expect(l.waitForExit).toHaveBeenCalledWith('Pixel_8_API_34')

        agent.disconnect(); browser.close()
      })

      // A live process adb cannot see — still coming up, or its adb server restarted. There is no
      // console to ask, and skipping the stop would put a second emulator on the same AVD.
      it('stops a live emulator that adb cannot see, without a serial', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(false)          // no serial: adb reports nothing booted
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()          // no console to send it to
        expect(vi.mocked(stopEmulatorProcess)).toHaveBeenCalledWith('Pixel_8_API_34')
        expect(launcherOf(agent).waitForExit).toHaveBeenCalledWith('Pixel_8_API_34')

        agent.disconnect(); browser.close()
      })

      it('does not try to stop an emulator that is not running', async () => {
        const adb = mockAdb(false)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()
        expect(vi.mocked(stopEmulatorProcess)).not.toHaveBeenCalled()
        expect(launcherOf(agent).waitForExit).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // `pgrep` answers "no match" and "I am not installed" through the same thrown error, so a
      // probe that cannot look must not read as "nothing is running" — that lands on the same
      // silent false success as launching after a failed stop, by a different door.
      it('fails the boot when it cannot tell whether an emulator is running', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'unknown' })
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        const err = await waitForType(browser, 'device:boot-error')

        expect(err['requestId']).toBe('rq-wipe')
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // The same probe failure must not touch an ordinary boot — it never asks, and a host without
      // `pgrep` has to keep booting devices normally.
      it('does not consult the probe on an ordinary boot', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'unknown' })
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(launcherOf(agent).launch).toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // The blocker this review found: proceeding to launch after a failed stop reports a Full
      // reset that never happened, because `findSerial` scans `adb devices` for any emulator
      // answering to this AVD and returns the survivor, and `waitForBoot` passes instantly on a
      // device that is already up. The boot has to fail where the tester can see it.
      it('fails the boot rather than launching when the old emulator will not exit', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        launcherOf(agent).waitForExit.mockRejectedValue(new Error('still running after 30s'))

        const browser = await boot(agent, 'full-erase')
        const err = await waitForType(browser, 'device:boot-error')

        expect(err['requestId']).toBe('rq-wipe')
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })
    })

    // ── #526: a boot the agent stops running is answered, not abandoned ───────────────────────

    /** The launcher this agent built, whose `waitForBoot` is where a boot can be parked. */
    function launcherOf(agent: AndroidAgent) {
      return (agent as unknown as { launcher: { waitForBoot: ReturnType<typeof vi.fn> } }).launcher
    }

    /** A `waitForBoot` whose first `hold` calls park until released, and which answers at once after. */
    function holdingBoot(agent: AndroidAgent, hold: number) {
      const releases: (() => void)[] = []
      let calls = 0
      launcherOf(agent).waitForBoot.mockImplementation(() => {
        calls++
        if (calls <= hold) return new Promise<void>((resolve) => releases.push(resolve))
        return Promise.resolve()
      })
      return { releases, calls: () => calls }
    }

    async function joinedAgent(adb: AdbWrapper) {
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      return { agent, browser }
    }

    const boot = (sessionId: string | null, requestId: string) =>
      JSON.stringify({ type: 'device:boot', requestId, sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } })

    it('answers a boot that a newer boot superseded', async () => {
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 1)

      browser.send(boot(agent.sessionId, 'rq-a'))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      const superseded = waitForType(browser, 'device:boot-error')
      browser.send(boot(agent.sessionId, 'rq-b'))
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['requestId'], 'the surviving boot is the newer one').toBe('rq-b')

      wait.releases[0]!()
      const e = await superseded
      expect(e['requestId']).toBe('rq-a')
      expect(String(e['message'])).toContain('superseded')

      agent.disconnect()
      browser.close()
    })

    it('tells each abandoned boot what actually superseded it', async () => {
      // Two overlapping boots and one later event — the smallest sequence that tells a per-seq reason
      // apart from a single slot on the state, which would tell A it lost to the shutdown that took B.
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 2)

      const seen: Record<string, string> = {}
      const both = new Promise<void>((resolve) => {
        browser.on('message', (raw) => {
          const m = JSON.parse(String(raw)) as Record<string, string>
          if (m['type'] === 'device:boot-error') {
            seen[m['requestId']!] = m['message']!
            if (Object.keys(seen).length === 2) resolve()
          }
        })
      })

      browser.send(boot(agent.sessionId, 'rq-a'))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })
      browser.send(boot(agent.sessionId, 'rq-b'))
      await vi.waitFor(() => expect(wait.calls()).toBe(2), { timeout: 2000 })
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-s', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      await waitForType(browser, 'device:shutdown-done')

      for (const release of wait.releases) release()
      await both

      expect(seen['rq-a'], 'A lost to B, not to the shutdown').toContain('superseded')
      expect(seen['rq-b'], 'B is the one the shutdown abandoned').toContain('shut down')

      agent.disconnect()
      browser.close()
    })

    it('answers a boot for a session it holds no device state for', async () => {
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const sessionId = agent.sessionId
      // Held first: `agent.sessionId` reads the first entry of the very map being emptied.
      ;(agent as unknown as { deviceStates: Map<string, unknown> }).deviceStates.clear()

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(boot(sessionId, 'rq-nostate'))
      const e = await errored
      expect(e['requestId']).toBe('rq-nostate')
      expect(String(e['message'])).toContain('re-join')

      agent.disconnect()
      browser.close()
    })

    it('says nothing for an abandoned boot that carried no correlator', async () => {
      // A reply nobody waits for is not an answer, and worse than nothing here: this viewer reports every
      // *uncorrelated* `device:boot-error` — deliberately, because `restartVideoStream` reports a dead
      // stream that way (#426). Driven through the handler because the relay requires a correlator on
      // `device:boot`; the parameter is optional and an older relay does not enforce it.
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 1)
      const handler = agent as unknown as { handleDeviceBoot(s: string, d: string): Promise<void> }
      void handler.handleDeviceBoot(agent.sessionId!, 'avd:Pixel_8_API_34')
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      browser.send(boot(agent.sessionId, 'rq-live'))
      await waitForType(browser, 'device:ready')
      wait.releases[0]!()
      expect(await waitForTypeOrNull(browser, 'device:boot-error', 150)).toBeNull()

      agent.disconnect()
      browser.close()
    })

    it('sends no device info to a socket that is closing', async () => {
      // The mid-boot twin of the `sendMsg` guard below: this one gated on the socket being *present*, so a
      // boot that lost it mid-wait pushed its payload into a buffer nobody flushes while `device:ready` was
      // dropped by the other guard — the caller getting neither the data nor an answer.
      const agent = new AndroidAgent({}, mockAdb(false))
      const reach = agent as unknown as {
        ws: unknown
        sendDeviceInfo(state: { sessionId: string }, device: { id: string; name: string }): void
      }
      const sent: string[] = []
      const socket: { readyState: number; send: (d: string) => void } = {
        readyState: WebSocket.CLOSING,
        send: (d) => sent.push(d),
      }
      reach.ws = socket
      const device = { id: 'avd:Pixel_8_API_34', name: 'Pixel_8_API_34' }

      reach.sendDeviceInfo({ sessionId: 's1' }, device)
      expect(sent, 'a closing socket takes it and says nothing').toEqual([])

      socket.readyState = WebSocket.OPEN
      reach.sendDeviceInfo({ sessionId: 's1' }, device)
      expect(sent, 'and an open one still gets it').toHaveLength(1)
    })

    it('drops a reply to a socket that is closing, rather than buffering it in silence', async () => {
      // `ws.send` on anything but OPEN buffers and neither throws nor emits, so an answer sent there is
      // indistinguishable from a delivered one. Held on both agents: iOS has the same test, and a guard
      // present on one platform only is the asymmetry this slice's invariant table exists to catch.
      const agent = new AndroidAgent({}, mockAdb(false))
      const reach = agent as unknown as {
        ws: unknown
        sendMsg(msg: { type: string; sessionId: string; requestId: string; message: string }): void
      }
      const sent: string[] = []
      const socket: { readyState: number; send: (d: string) => void } = {
        readyState: WebSocket.CLOSING,
        send: (d) => sent.push(d),
      }
      reach.ws = socket
      const reply = { type: 'device:boot-error' as const, sessionId: 's1', requestId: 'rq-x', message: 'superseded' }

      reach.sendMsg(reply)
      expect(sent, 'a closing socket takes it and says nothing').toEqual([])

      socket.readyState = WebSocket.OPEN
      reach.sendMsg(reply)
      expect(sent, 'and an open one still gets it').toHaveLength(1)
    })

    it('abandons a boot when the relay goes away mid-boot, instead of finishing it', async () => {
      // **The asymmetry this slice closes.** iOS has invalidated in-flight boots on reconnect since its
      // helper-leak fix; this agent did not, so a boot that outlived the socket ran to completion against
      // a state `_scheduleReconnect` had already dropped — standing up a video stream and announcing
      // `device:ready` for a session that no longer exists. Both agents clear `deviceStates` there, but the
      // running boot holds its own reference to one, so clearing the map does not reach it.
      const adb = mockAdb(false)
      // A one-second handshake and a 25s budget, both copied from the iOS twin of this test rather than
      // guessed: stopping a relay, starting another on the same port and waiting out the agent's own
      // reconnect is the heaviest sequence in this file, and the default 10s handshake is longer than the
      // whole default 5s test budget — one attempt landing in it stops every later one, since
      // `_scheduleReconnect` runs only from `connect()`'s `.catch`. It passed locally and timed out on CI.
      const agent = new AndroidAgent({ reconnectDelays: [20], handshakeTimeoutMs: 1_000 }, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const sessionId = agent.sessionId
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')

      const wait = holdingBoot(agent, 1)
      browser.send(boot(sessionId, 'rq-lost'))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      // Drop the relay and bring another up on the same port, so the agent's own reconnect runs and the
      // socket is live again — an `agent.disconnect()` version of this passes with the fix removed,
      // because `ws` then stays null and the send guard covers for it.
      //
      // Rebinding `relay` is local in effect even though the binding is the suite's: `beforeEach` mints a
      // fresh server for every test and `afterEach` stops whichever one this leaves behind, so no
      // neighbour ever sees the replacement. Same shape as the iOS twin of this test.
      browser.close()
      await relay.stop()
      relay = new RelayServer({ port })
      await relay.start()
      const rejoined = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(rejoined)
      let joined = null
      for (let i = 0; i < 60 && joined === null; i++) {
        rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        joined = await waitForTypeOrNull(rejoined, 'session:joined', 250)
      }
      expect(joined, 'the agent never re-registered').not.toBeNull()

      // **Observed at the first thing the resumed boot would do, not at the last.** Two later signals look
      // like the obvious assertions and see nothing either way: `device:ready` names the dropped session,
      // which this relay has never heard of and discards at the door, and the video session is never built
      // because `openStreamWs` registers that same id and gets nowhere. Both stay silent with the fix
      // removed, so both would have passed a broken agent. The step immediately after the wait is `adb`,
      // which answers regardless of what the relay knows — so that is where the difference is visible.
      const adbCallsBefore = (adb.listDevices as ReturnType<typeof vi.fn>).mock.calls.length
      const serialBefore = adb.getSerial('avd:Pixel_8_API_34')
      wait.releases[0]!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 50))
      expect(
        (adb.listDevices as ReturnType<typeof vi.fn>).mock.calls.length,
        'the abandoned boot carried on against a state the reconnect had dropped',
      ).toBe(adbCallsBefore)
      expect(adb.getSerial('avd:Pixel_8_API_34'), 'and bound a serial onto it').toBe(serialBefore)
      expect(await waitForTypeOrNull(rejoined, 'device:ready', 100)).toBeNull()

      agent.disconnect()
      rejoined.close()
    }, 25_000)

    // ── L5b′: the lifecycle pair correlates, and the correlator is optional ────────────────────
    //
    // Optional means the compiler enforces nothing — `<Pair>ReplyBody` cannot be built for a field an
    // object is allowed to omit — and `correlatedRequestsGated` derives only required declarations, so
    // it does not see this pair either. These tests are the entire enforcement of the echo here.
    // ── #587 / #611: a boot owns the stream it starts, and only that ─────────────────────────────
    //
    // `handleDeviceBoot` checks its seq after every await, but `startVideoStream` wrote to the shared
    // state across awaits of its own. Two overlapping boots then left one session with nobody to stop
    // it — or the older boot wrote over the newer one's.
    describe('a boot owns the stream it starts', () => {
      /** A gate and the handles that open it. */
      function gate() {
        let open!: () => void
        let fail!: (e: Error) => void
        const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject })
        return { promise, open, fail }
      }
      const sessions = () => vi.mocked(ScrcpySession).mock.results.map((r) => r.value as { stop: ReturnType<typeof vi.fn> })
      const videos = () => vi.mocked(EmulatorVideo).mock.results.map((r) => r.value as { stop: ReturnType<typeof vi.fn> })
      const stateOf = (agent: AndroidAgent) => internals(agent).deviceStates.values().next().value as TestState & {
        scrcpySession: unknown; emulatorVideo: unknown; grpcClient: unknown; rotation: number | null; skin: unknown
      }
      // Read per test, not when this block is collected: the suite's `beforeAll` pins scrcpy after that.
      let pinned: string | undefined
      beforeEach(() => { pinned = process.env.TAPFLOW_ANDROID_BACKEND })
      afterEach(() => {
        process.env.TAPFLOW_ANDROID_BACKEND = pinned
        scrcpyStartGates.length = 0
        grpcStartGates.length = 0
      })

      it('stops the session a superseded boot started, and leaves the newer one alone (scrcpy)', async () => {
        const { agent, browser } = await joinedAgent(mockAdb(true))
        const before = sessions().length
        const a = gate()
        scrcpyStartGates.push(a.promise)

        browser.send(boot(agent.sessionId, 'rq-a'))
        await vi.waitFor(() => expect(sessions().length).toBe(before + 1))
        const superseded = waitForType(browser, 'device:boot-error')
        browser.send(boot(agent.sessionId, 'rq-b'))
        expect((await waitForType(browser, 'device:ready'))['requestId']).toBe('rq-b')

        a.open()
        expect((await superseded)['requestId']).toBe('rq-a')
        const [sessionA, sessionB] = sessions().slice(before)
        expect(sessionA!.stop, "A's scrcpy server would outlive the boot that started it").toHaveBeenCalled()
        expect(sessionB!.stop).not.toHaveBeenCalled()
        expect(stateOf(agent).scrcpySession, 'A must not write over the session B owns').toBe(sessionB)

        agent.disconnect(); browser.close()
      })

      it('stops what it started when both boots are still starting (scrcpy)', async () => {
        const { agent, browser } = await joinedAgent(mockAdb(true))
        const before = sessions().length
        const a = gate()
        const b = gate()
        scrcpyStartGates.push(a.promise, b.promise)

        browser.send(boot(agent.sessionId, 'rq-a'))
        await vi.waitFor(() => expect(sessions().length).toBe(before + 1))
        const superseded = waitForType(browser, 'device:boot-error')
        browser.send(boot(agent.sessionId, 'rq-b'))
        // B opens its own stream socket first, which takes longer than `waitFor`'s one-second default.
        await vi.waitFor(() => expect(sessions().length).toBe(before + 2), { timeout: 4000 })

        a.open()
        expect((await superseded)['requestId']).toBe('rq-a')
        b.open()
        expect((await waitForType(browser, 'device:ready'))['requestId']).toBe('rq-b')
        const [sessionA, sessionB] = sessions().slice(before)
        expect(sessionA!.stop).toHaveBeenCalled()
        expect(stateOf(agent).scrcpySession).toBe(sessionB)

        agent.disconnect(); browser.close()
      })

      it("does not fall back to scrcpy over the newer boot when the older one's capture ends (gRPC)", async () => {
        // B's cleanup stops A's capture mid-start, so A's start rejects with an ordinary error — and
        // the gRPC→scrcpy fallback used to take that as its cue, tearing down what was by then B's.
        process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
        const { agent, browser } = await joinedAgent(mockAdb(true))
        const videosBefore = videos().length
        const sessionsBefore = sessions().length
        const a = gate()
        grpcStartGates.push(a.promise)

        browser.send(boot(agent.sessionId, 'rq-a'))
        await vi.waitFor(() => expect(videos().length).toBe(videosBefore + 1))
        const superseded = waitForType(browser, 'device:boot-error')
        browser.send(boot(agent.sessionId, 'rq-b'))
        expect((await waitForType(browser, 'device:ready'))['requestId']).toBe('rq-b')
        const touchB = stateOf(agent).touchHelper

        a.fail(new Error('capture ended'))
        expect((await superseded)['requestId']).toBe('rq-a')
        const videoB = videos()[videosBefore + 1]!
        expect(videoB.stop).not.toHaveBeenCalled()
        expect(stateOf(agent).emulatorVideo).toBe(videoB)
        expect(stateOf(agent).touchHelper, "A's fallback stopped B's touch channel").toBe(touchB)
        expect(sessions().length, 'A started a scrcpy session for a boot it had lost').toBe(sessionsBefore)

        agent.disconnect(); browser.close()
      })

      it('does not write its screen geometry into the session that replaced it (gRPC)', async () => {
        process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
        const adb = mockAdb(true)
        const reading = gate()
        let first = true
        vi.spyOn(adb, 'getDisplayMetrics').mockImplementation(async () => {
          if (first) { first = false; await reading.promise }
          return { natural: { width: 1080, height: 2400 }, current: { width: 2400, height: 1080 }, rotation: 90 as const }
        })
        const { agent, browser } = await joinedAgent(adb)

        browser.send(boot(agent.sessionId, 'rq-a'))
        await vi.waitFor(() => expect(first).toBe(false))
        // B lands on scrcpy, which never writes a rotation or a skin — so any it has are A's.
        process.env.TAPFLOW_ANDROID_BACKEND = 'scrcpy'
        const superseded = waitForType(browser, 'device:boot-error')
        browser.send(boot(agent.sessionId, 'rq-b'))
        expect((await waitForType(browser, 'device:ready'))['requestId']).toBe('rq-b')

        reading.open()
        expect((await superseded)['requestId']).toBe('rq-a')
        expect(stateOf(agent).rotation).toBeNull()
        expect(stateOf(agent).skin).toBeNull()

        agent.disconnect(); browser.close()
      })

      it('normalises a boot that arrives while a stream restart is waiting (gRPC)', async () => {
        // The restart used to be a flag on the shared state, and the boot read it as its own.
        process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
        const adb = mockAdb(true)
        const { agent, browser } = await joinedAgent(adb)
        vi.spyOn(agent as unknown as { listPostures(id: string): Promise<unknown[]> }, 'listPostures')
          .mockResolvedValue([{ id: 'half-open', label: 'Half open' }])
        // The normalisation itself is what is counted: it no longer writes anything a spy on adb could see.
        const upright = vi.spyOn(agent as unknown as { normaliseOnBoot(): Promise<void> }, 'normaliseOnBoot')
        browser.send(boot(agent.sessionId, 'rq-a'))
        await waitForType(browser, 'device:ready')
        expect(upright).toHaveBeenCalledTimes(1)

        grpcFramesController!.close() // the stream dies; the restart waits 1.5s before starting again
        await vi.waitFor(() => expect(stateOf(agent).restarting).toBe(true))
        browser.send(boot(agent.sessionId, 'rq-b'))
        expect((await waitForType(browser, 'device:ready'))['requestId']).toBe('rq-b')
        expect(upright, 'the new boot skipped normalisation').toHaveBeenCalledTimes(2)

        agent.disconnect(); browser.close()
      }, 8000)

      it('still restarts the newer stream when it dies after an older restart gave up', async () => {
        // A restart that loses its seq returns without touching `restarting`, because by then the
        // flag is the newer boot's. So that boot's cleanup has to lower it — left up, its own stream's
        // death would never restart, for the life of the session.
        const { agent, browser } = await joinedAgent(mockAdb(true))
        browser.send(boot(agent.sessionId, 'rq-a'))
        await waitForType(browser, 'device:ready')

        scrcpyStreamController!.close() // A's stream dies; its restart waits 1.5s
        await vi.waitFor(() => expect(stateOf(agent).restarting).toBe(true))
        browser.send(boot(agent.sessionId, 'rq-b'))
        await waitForType(browser, 'device:ready')
        await new Promise((r) => setTimeout(r, 1700)) // the old restart wakes, sees it lost, and returns

        const before = sessions().length
        scrcpyStreamController!.close() // B's stream dies
        await vi.waitFor(() => expect(sessions().length).toBe(before + 1), { timeout: 4000 })

        agent.disconnect(); browser.close()
      }, 12000)

      it('answers a boot whose emulator stopped before its stream could start (#611)', async () => {
        const adb = mockAdb(true)
        const listed = vi.mocked(adb.listDevices)
        const real = listed.getMockImplementation()!
        let n = 0
        listed.mockImplementation(async () => {
          // The second read is the one after the stop a Full reset began: adb has let go of it.
          if (++n === 2) adb.clearSerial('avd:Pixel_8_API_34')
          return real()
        })
        const { agent, browser } = await joinedAgent(adb)

        const info = waitForTypeOrNull(browser, 'session:deviceInfo', 400)
        const ready = waitForTypeOrNull(browser, 'device:ready', 400)
        browser.send(boot(agent.sessionId, 'rq-611'))
        const e = await waitForType(browser, 'device:boot-error')
        expect(e['requestId']).toBe('rq-611')
        expect(String(e['message'])).toContain('no longer lists the emulator')
        expect(await ready, 'ready with no stream behind it').toBeNull()
        expect(await info, 'announced as booted before the check').toBeNull()

        agent.disconnect(); browser.close()
      })

      it('reports a stream it cannot restart because the emulator is gone', async () => {
        const adb = mockAdb(true)
        const { agent, browser } = await joinedAgent(adb)
        browser.send(boot(agent.sessionId, 'rq-a'))
        await waitForType(browser, 'device:ready')

        const dead = waitForType(browser, 'device:boot-error')
        adb.clearSerial('avd:Pixel_8_API_34')
        scrcpyStreamController!.close()
        const e = await dead
        expect(e['requestId'], 'no boot is behind a dead stream').toBeUndefined()
        // Its own report, not the generic one the restart falls through to after its 1.5s wait.
        expect(String(e['message'])).toContain('could not be restarted')

        agent.disconnect(); browser.close()
      })
    })

    describe('lifecycle replies echo the boot/shutdown correlator', () => {
      async function joined(adb: AdbWrapper) {
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      it('device:ready carries the requestId of the boot it answers', async () => {
        const { agent, browser } = await joined(mockAdb(false))

        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-1',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await ready)['requestId']).toBe('boot-1')

        agent.disconnect(); browser.close()
      })

      it('device:boot-error carries the requestId of the boot it answers', async () => {
        // The failure exit is what a caller actually waits on: an uncorrelatable diagnosis is
        // discarded by a correlating consumer, so the boot fails by deadline instead of by error.
        const adb = mockAdb(false)
        const { agent, browser } = await joined(adb)
        // Mocked **after** the join: `connect()` enumerates devices through this same call, so failing
        // it earlier takes the registration down and never reaches a boot at all.
        ;(adb.listDevices as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('adb exploded'))

        const err = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-2',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('boot-2')
        expect(msg['message']).toContain('adb exploded')

        agent.disconnect(); browser.close()
      })

      it('device:shutdown-done carries the requestId of the shutdown it answers', async () => {
        const { agent, browser } = await joined(mockAdb(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, requestId: 'down-1',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await done)['requestId']).toBe('down-1')

        agent.disconnect(); browser.close()
      })

      it('answers a correlator-less request without inventing one', async () => {
        // The relay originates `device:shutdown` from its idle timer with no id, so this is a live
        // wire shape. A minted id would be worse than none: the consumer's fallback accepts an absent
        // correlator and rejects a mismatched one, so inventing one turns a reply that lands today
        // into one that is silently dropped.
        const { agent, browser } = await joined(mockAdb(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await done)['requestId']).toBeUndefined()

        agent.disconnect(); browser.close()
      })
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
        requestId: 'rq-fix-2',
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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-3', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-4', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))

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
        requestId: 'rq-fix-5',
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
        requestId: 'rq-appzip',
        payload: { filePath: '/tmp/App.app.zip' },
      })
      const err = await waitForType(browser, 'app:install-error')
      expect((err['message'] as string).toLowerCase()).toContain('ios')

      agent.disconnect()
      browser.close()
      agentWs.close()
    })

    // **The iOS-build guard has to read the name the relay reports, not the local path.** With a
    // ticket the file lands under a temp directory, so judging the local path would stop this guard
    // firing and send an iOS archive to `adb install` — which fails in the parser instead of saying
    // the one useful sentence.
    //
    // Mutation: judge `filePath`. The temp path ends in nothing recognisable and the guard goes quiet.
    it('refuses an iOS build by the name the relay reports, not the path it would download to', async () => {
      const adb = mockAdb(true)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-name-guard', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      agent['handleRelayMessage']({
        type: 'app:install',
        sessionId: agent.sessionId!,
        requestId: 'rq-name',
        // A path with no telling extension, which is what a downloaded file would be judged on.
        payload: { filePath: '/app/.tapflow/data/uploads/builds/1789-abc', buildTicket: 't', buildName: 'App.app.zip', buildBytes: 1 },
      })
      const refused = await waitForType(browser, 'app:install-error')
      expect((refused['message'] as string).toLowerCase()).toContain('ios')

      agent.disconnect(); browser.close()
    })

    // Mutation: download whenever a ticket is present. There is no origin to build a URL from before
    // the agent has connected, so this crashes where the old path simply worked.
    it('installs from the path when it has no relay url to fetch from', async () => {
      const adb = mockAdb(true)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-nourl', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      ;(agent as unknown as { relayUrl: string | null }).relayUrl = null
      agent['handleRelayMessage']({
        type: 'app:install',
        sessionId: agent.sessionId!,
        requestId: 'rq-nourl2',
        payload: { filePath: '/tmp/App.apk', buildTicket: 't', buildName: 'App.apk', buildBytes: 1 },
      })
      // The reply is the assertion: with no relay url and a ticket present, the only way to reach
      // `app:install-done` is the path branch. Downloading unconditionally throws on the URL
      // constructor instead, which arrives as `app:install-error`.
      const done = await waitForType(browser, 'app:install-done')
      expect(done['requestId']).toBe('rq-nourl2')

      agent.disconnect(); browser.close()
    })
  })

  // #918: a full device is reclaimed and the install retried — but only on an emulator tapflow
  // launched. Mutation: drop the `owned` gate, and the second test rolls back a developer's own apps.
  describe('app:install on a full device', () => {
    async function bootAndInstall(owned: boolean) {
      const adb = mockAdb(true)
      const install = vi.spyOn(adb, 'installApp')
        .mockRejectedValueOnce(new StorageFullError())
        .mockResolvedValue(undefined)
      vi.spyOn(adb, 'packageStates').mockResolvedValue({ enabled: new Set(['android', LEAN_PACKAGES[0]]), disabled: new Set() })
      vi.spyOn(adb, 'hasSystemUpdates').mockResolvedValue(true)
      const rollback = vi.spyOn(adb, 'uninstallSystemUpdates').mockResolvedValue(undefined)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-full-boot', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      if (owned) (agent as unknown as { ownedDevices: Set<string> }).ownedDevices.add('avd:Pixel_8_API_34')
      ;(agent as unknown as { relayUrl: string | null }).relayUrl = null
      agent['handleRelayMessage']({
        type: 'app:install', sessionId: agent.sessionId!, requestId: 'rq-full',
        payload: { filePath: '/tmp/App.apk' },
      })
      return { agent, browser, install, rollback }
    }

    it('rolls back a Lean package and installs on an emulator tapflow launched', async () => {
      const { agent, browser, install, rollback } = await bootAndInstall(true)
      const done = await waitForType(browser, 'app:install-done')
      expect(done['requestId']).toBe('rq-full')
      expect(rollback).toHaveBeenCalledWith('emulator-5554', LEAN_PACKAGES[0])
      expect(install).toHaveBeenCalledTimes(2)
      agent.disconnect(); browser.close()
    })

    // Mutation: drop the bootSeq recheck in `uninstallUpdates`, and a boot superseded while the
    // install ran still has its apps rolled back.
    it('does not roll back once the boot it started on has been superseded', async () => {
      const adb = mockAdb(true)
      vi.spyOn(adb, 'installApp').mockRejectedValue(new StorageFullError())
      vi.spyOn(adb, 'hasSystemUpdates').mockResolvedValue(true)
      const rollback = vi.spyOn(adb, 'uninstallSystemUpdates').mockResolvedValue(undefined)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-super-boot', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      ;(agent as unknown as { ownedDevices: Set<string> }).ownedDevices.add('avd:Pixel_8_API_34')
      const state = (agent as unknown as { deviceStates: Map<string, { bootSeq: number }> }).deviceStates.get(agent.sessionId!)
      // A newer boot lands while the package list is read.
      vi.spyOn(adb, 'packageStates').mockImplementation(async () => {
        state!.bootSeq++
        return { enabled: new Set(['android', LEAN_PACKAGES[0]]), disabled: new Set() }
      })
      await expect(agent.installApp('/tmp/App.apk')).rejects.toBeInstanceOf(StorageFullError)
      expect(rollback).not.toHaveBeenCalled()
      agent.disconnect(); browser.close()
    })

    it('leaves an emulator it only attached to alone and says the device is full', async () => {
      const { agent, browser, install, rollback } = await bootAndInstall(false)
      const err = await waitForType(browser, 'app:install-error')
      expect(err['message']).toMatch(/^Device storage is full/)
      expect(rollback).not.toHaveBeenCalled()
      expect(install).toHaveBeenCalledTimes(1)
      agent.disconnect(); browser.close()
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
          requestId: 'rq-fix-6',
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
          requestId: 'rq-fix-7',
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
          requestId: 'rq-fix-8',
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
          requestId: 'rq-fix-9',
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
          requestId: 'rq-fix-10',
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
          requestId: 'rq-fix-11',
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

      // **This is why the correlator on `device:boot-error` is optional at all.** The message below
      // answers no request: a stream died mid-session and failed to come back, and there is no
      // `device:boot` anywhere behind it to take an id from. Everything downstream follows from that —
      // the declaration cannot be required, `correlatedRequestsGated` cannot cover the pair, and
      // `DeviceViewer` must not gate this branch on a correlator, since it is the only surface that
      // reports a dead stream. A boot carrying an id happens first here on purpose: that is the state
      // in which an implementation reaching for "the session's current requestId" would look correct.
      it('sends the unsolicited boot-error with no correlator, even after a correlated boot', async () => {
        vi.useFakeTimers()

        const reReady = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          requestId: 'boot-with-id',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await vi.runAllTimersAsync()
        expect((await reReady)['requestId']).toBe('boot-with-id')

        scrcpyStartError = new Error('encoder stall')
        const state = getState()
        state.restarting = true

        const bootErrPromise = waitForType(browser, 'device:boot-error')
        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        const err = await bootErrPromise
        expect(err['message']).toBe('scrcpy failed to restart')
        expect(err['requestId']).toBeUndefined()
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

    // The close code alone cannot say who ended the connection; the line carries it with the time since the
    // relay's last ping so a stalled agent and a lost network read differently afterwards.
    it('logs the close code and ping age when the relay connection drops', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const agent = new AndroidAgent({ reconnectDelays: [60_000] }, mockAdb())
      await agent.connect(`ws://localhost:${port}`)
      internals(agent).ws!.terminate()
      await vi.waitFor(() => {
        const lines = warn.mock.calls.map((c) => String(c[0]))
        expect(lines.some((l) => /relay disconnected \(code 1006, (no ping received|last ping \d+s ago)\) — reconnecting in 60s/.test(l))).toBe(true)
      })
      agent.disconnect()
    })

    // The ping age and the socket error are what separate a stalled agent from a lost network, so both are
    // pinned, and so is the reset: a second socket must not report the first one's last ping.
    it('reports the relay ping and socket error of the socket that closed, not an earlier one', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const agent = new AndroidAgent({ reconnectDelays: [0] }, mockAdb())
      await agent.connect(`ws://localhost:${port}`)
      const first = internals(agent).ws!
      first.emit('ping', Buffer.alloc(0))
      first.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      first.terminate()
      const lines = () => warn.mock.calls.map((c) => String(c[0]))
      await vi.waitFor(() => expect(lines().some((l) => /relay disconnected \(code 1006, error ECONNRESET, last ping \d+s ago\)/.test(l))).toBe(true))
      await vi.waitFor(() => {
        const ws = internals(agent).ws
        expect(ws && ws !== first && ws.readyState === WebSocket.OPEN).toBe(true)
      }, { timeout: 2000 })
      // Read from this agent, not from console lines: other tests' agents still reconnecting in the
      // background print "no ping received" too, which made a line match pass with the reset deleted.
      expect(internals(agent).lastPingAt).toBeNull()
      expect(internals(agent).lastSocketError).toBeUndefined()
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
        requestId: 'rq-fix-12',
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
        // Opened first: a move with no gesture behind it is dropped (#487).
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        inject({ type: 'input:touch:move', payload: { x: 0.5, y: 0.5 } })
        expect(control.touchMove).toHaveBeenCalledWith(0, 540, 1200)
      })

      it('touch:end lifts at the last touched px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2 } })
        inject({ type: 'input:touch:end', requestId: 'rq-lift' })
        // last px from start: 0.1*1080 = 108, 0.2*2400 = 480
        expect(control.touchUp).toHaveBeenCalledWith(0, 108, 480)
      })

      // A client leaving mid-gesture sends a cancel, then an end (#1115). The cancel closes the gesture's record before
      // anything awaits, so the end finds nothing to complete and lifts nothing.
      it('touch:cancel cancels at the last touched px, and the end after it lifts nothing', async () => {
        const control = getState().scrcpySession!.control
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2 } })
        inject({ type: 'input:touch:cancel' })
        inject({ type: 'input:touch:end', requestId: 'rq-after-cancel' })
        expect(control.touchCancel).toHaveBeenCalledWith(0, 108, 480)
        expect(control.touchUp).not.toHaveBeenCalled()
        expect((await errored)['reason']).toBe('no-gesture')
      })

      it('touch:cancel on the adb path drops the gesture instead of replaying it', () => {
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:cancel' })
        inject({ type: 'input:touch:end', requestId: 'rq-adb-cancel' })
        expect(state.touchHelper!.touchCancel).toHaveBeenCalledTimes(1)
        expect(state.touchHelper!.touchEnd).not.toHaveBeenCalled()
      })

      // A touch cancel closes a touch only: taking an open pinch's record would leave its second pointer down.
      it('touch:cancel leaves an open pinch to its own end', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.5 }, f1: { x: 0.6, y: 0.5 } } })
        inject({ type: 'input:touch:cancel' })
        inject({ type: 'input:pinch:end', requestId: 'rq-pinch-after' })
        expect(control.touchCancel).not.toHaveBeenCalled()
        expect(control.pinchEnd).toHaveBeenCalledTimes(1)
      })

      // followups H-F: touch:end acks input:done when dispatched to a booted device (pointer channel present + adb reports booted).
      it('acks input:done on touch:end for a booted session', async () => {
        const done = waitForType(browser, 'input:done')
        browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
        browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in1', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
        const ack = await done
        expect(ack.sessionId).toBe(agent.sessionId)
        // L5c. The terminal frame's id, not any id: replacing the echo with a literal left all 263 tests
        // passing in the mutation round. `requestId` rides beside `seq` as a caller-captured argument for
        // the same reason — a gesture is dozens of frames and two can overlap, so a correlator read from
        // shared state would answer one input with another's id, which is #499 rebuilt inside the agent.
        expect(ack.requestId).toBe('rq-in1')
      })

      // Body mode measures the pointer on the frame and says so. The turn is the newest frame's skin, so a touch
      // right after a turn lands where it was aimed while the chrome still describes the turn before.
      // Mutation: drop `fromFrame` from either handler, or read `state.skin` (the chrome's) instead of the frame's.
      describe('a point measured on the frame', () => {
        it('is turned by the frame\'s skin', () => {
          const control = getState().scrcpySession!.control
          getState().latestFrame = { w: 2400, h: 1080, skin: 'REVERSE_LANDSCAPE' }
          inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2, space: 'frame' } })
          // frame (0.1,0.2) on a body a quarter clockwise is screen (0.2,0.9): 216, 2160
          expect(control.touchDown).toHaveBeenCalledWith(0, 216, 2160)
          inject({ type: 'input:touch:move', payload: { x: 0.1, y: 0.2, space: 'frame' } })
          expect(control.touchMove).toHaveBeenCalledWith(0, 216, 2160)
        })

        it('lands the same while the screen\'s rotation still lags the frame', () => {
          const control = getState().scrcpySession!.control
          Object.assign(getState(), { latestFrame: { w: 2400, h: 1080, skin: 'REVERSE_LANDSCAPE' }, rotation: 90 })
          inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2, space: 'frame' } })
          expect(control.touchDown).toHaveBeenCalledWith(0, 216, 2160)
        })

        it('is not turned by a stale chrome skin', () => {
          const control = getState().scrcpySession!.control
          Object.assign(getState(), { latestFrame: { w: 1080, h: 2400, skin: 'PORTRAIT' }, skin: 'REVERSE_LANDSCAPE' })
          inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2, space: 'frame' } })
          expect(control.touchDown).toHaveBeenCalledWith(0, 108, 480)
        })

        it('is the screen when no skin is known, and when the sender names no space', () => {
          const control = getState().scrcpySession!.control
          inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2, space: 'frame' } })
          expect(control.touchDown).toHaveBeenLastCalledWith(0, 108, 480)
          getState().latestFrame = { w: 2400, h: 1080, skin: 'REVERSE_LANDSCAPE' }
          inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2 } })
          expect(control.touchDown).toHaveBeenLastCalledWith(0, 108, 480)
        })
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
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        inject({ type: 'input:pinch:move', payload: { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } } })
        expect(control.pinchMove).toHaveBeenCalledWith(540, 1200, 540, 1200)
        inject({ type: 'input:pinch:end', requestId: 'rq-pinch' })
        expect(control.pinchEnd).toHaveBeenCalledOnce()
      })

      it('turns both fingers of a frame pinch by the frame\'s skin', () => {
        const control = getState().scrcpySession!.control
        getState().latestFrame = { w: 2400, h: 1080, skin: 'REVERSE_LANDSCAPE' }
        const payload = { f0: { x: 0.2, y: 0.3 }, f1: { x: 0.8, y: 0.9 }, space: 'frame' }
        inject({ type: 'input:pinch:start', payload })
        // f0 → screen (0.3,0.8): 324, 1920 · f1 → (0.9,0.2): 972, 480
        expect(control.pinchStart).toHaveBeenCalledWith(324, 1920, 972, 480)
        inject({ type: 'input:pinch:move', payload })
        expect(control.pinchMove).toHaveBeenCalledWith(324, 1920, 972, 480)
      })
    })

    describe('input — rotate', () => {
      // A `direction` comes only from a viewer drawing the body. With no gRPC client — a stream restarting, or a
      // step that ran after its session was cleaned up — it must still never take the toggle, which writes
      // `wm user-rotation lock`. Mutation: gate the body turn on `grpcClient` alone.
      it('turns the body for a direction, and never locks, when no gRPC client is up', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        inject({ type: 'input:rotate', payload: { direction: 'clockwise' } })
        await vi.waitFor(() => expect((adb as unknown as { body: { at: number } }).body.at).toBe(90))
        expect(rotateSpy).not.toHaveBeenCalled()
      })

      // A real device has no body; nothing that draws one sends it a direction, and the toggle is not an answer.
      // Mutation: let the direction fall through to the toggle.
      it('ignores a direction for a device with no body', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        adb.setSerial('avd:Pixel_8_API_34', 'R58M1234567')
        inject({ type: 'input:rotate', payload: { direction: 'clockwise' } })
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(1))
        expect(rotateSpy).toHaveBeenCalledWith('R58M1234567', 3)
        expect(adb.rotateBodyClockwise).not.toHaveBeenCalled()
      })

      // The toggle still locks an emulator streaming without gRPC, and that lock is tapflow's: the AVD is
      // forgotten so the next gRPC session frees it. Mutation: leave the marker.
      it('forgets having freed the AVD when the toggle locks an emulator', async () => {
        const forgot: string[] = []
        ;(agent as unknown as { rotationLock: { forget(n: string): void } }).rotationLock.forget = (n) => { forgot.push(n) }
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        await vi.waitFor(() => expect(forgot).toEqual(['Pixel_8_API_34']))
      })

      // An older dashboard sends no target, and toggles.
      it('toggles landscape and asks the device to rotate to canonical landscape (3)', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        expect(getState().landscape).toBe(false)

        inject({ type: 'input:rotate' })
        await vi.waitFor(() => expect(getState().landscape).toBe(true))
        expect(rotateSpy).toHaveBeenCalledWith('emulator-5554', 3)
      })

      it('rotates back to portrait (0) on the second toggle', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        inject({ type: 'input:rotate' })
        inject({ type: 'input:rotate' })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(2))
        expect(rotateSpy).toHaveBeenNthCalledWith(2, 'emulator-5554', 0)
        expect(getState().landscape).toBe(false)
      })

      // #910: a target is safe to repeat, which is what makes the viewer's unmount undo correct
      // against an agent whose memory was reset by a re-register.
      //
      // Mutation: ignore the payload. The second `landscape` toggles back to portrait.
      it('goes to the target it is given, however often', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        inject({ type: 'input:rotate', payload: { orientation: 'portrait' } })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(3))
        expect(rotateSpy.mock.calls.map((c) => c[1])).toEqual([3, 3, 0])
        expect(getState().landscape).toBe(false)
      })

      // Each `setRotation` is its own adb process. Without the queue, the second starts before the
      // first lands, and the device ends on whichever finishes last.
      //
      // Mutation: call `step` directly instead of chaining it. The portrait call starts while the
      // landscape one is still pending.
      it('sends one rotation at a time, in the order they came', async () => {
        let release!: () => void
        const rotateSpy = vi.spyOn(adb, 'setRotation')
          .mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        inject({ type: 'input:rotate', payload: { orientation: 'portrait' } })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(1))
        await new Promise((r) => setTimeout(r, 20))
        expect(rotateSpy).toHaveBeenCalledTimes(1)
        release()
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(2))
        expect(rotateSpy.mock.calls.map((c) => c[1])).toEqual([3, 0])
      })

      // The memory is what an older dashboard's next toggle reads, so it has to say where the device
      // is. A failed rotation left the device where it was.
      //
      // Mutation: write the memory before the device answers. The failed `landscape` then leaves the
      // memory landscape over a portrait device, and the next toggle goes nowhere.
      it('keeps the memory where the device is when a rotation fails, and goes on with the next', async () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation').mockRejectedValueOnce(new Error('adb went away'))
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(1))
        await new Promise((r) => setTimeout(r, 10))
        expect(getState().landscape).toBe(false)
        inject({ type: 'input:rotate' })
        await vi.waitFor(() => expect(rotateSpy).toHaveBeenCalledTimes(2))
        expect(rotateSpy).toHaveBeenLastCalledWith('emulator-5554', 3)
      })

      // A restart keeps the viewer mounted, and it keeps showing landscape — so neither the device
      // nor an older dashboard's next toggle may be put back to portrait.
      //
      // Mutations: reset `landscape` on a restart too; stand the device up on a restart too.
      it('keeps the memory, and the device, across a stream restart', async () => {
        inject({ type: 'input:rotate', payload: { orientation: 'landscape' } })
        await vi.waitFor(() => expect(getState().landscape).toBe(true))
        vi.mocked(adb.getUserRotation).mockResolvedValue({ mode: 'lock', rotation: 3 })
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        rotateSpy.mockClear()
        await internals(agent).restartVideoStream(getState())
        expect(getState().landscape).toBe(true)
        expect(rotateSpy).not.toHaveBeenCalled()
      })

      // scrcpy does not go through `normaliseOnBoot`, so the boot's body step sits ahead of the backend split —
      // an emulator on scrcpy is read and stood up too. This suite boots on scrcpy. Mutation: move the step into
      // `normaliseOnBoot`; or keep reading the rotation lock (`uprightOnBoot`) for an emulator.
      it('reads where an emulator\'s body is held on a scrcpy boot, not its rotation lock', () => {
        expect(adb.readBodyRotation).toHaveBeenCalledWith('emulator-5554')
        expect(adb.getUserRotation).not.toHaveBeenCalled()
      })
    })

    describe('input — type', () => {
      it('routes input:type to adb.inputText and acks only after it completes', async () => {
        // gate inputText so we can prove the ack is not sent until it resolves
        let resolveInput!: () => void
        const spy = vi.spyOn(adb, 'inputText').mockReturnValue(new Promise<void>((r) => { resolveInput = r }))
        const ack = waitForType(browser, 'input:type-done')
        inject({ type: 'input:type', requestId: 'rq-in2', payload: { text: 'hello' } })
        await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('emulator-5554', 'hello'), { timeout: 500 })
        // ack must NOT have fired while inputText is still pending
        let acked = false
        void ack.then(() => { acked = true })
        await new Promise((r) => setTimeout(r, 50))
        expect(acked).toBe(false)
        resolveInput()
        expect((await ack).sessionId).toBe(agent.sessionId)
      })

      // Empty text is a successful no-op on both platforms, and the flow schema and MCP `type_text`
      // both accept `""`. Answering an error for it would trade this change's real fix — "dispatched
      // nothing while claiming otherwise" — for a false failure.
      it('acks input:type-done for empty text without touching adb', async () => {
        const inputText = vi.spyOn(adb, 'inputText')
        const ack = waitForType(browser, 'input:type-done')
        inject({ type: 'input:type', requestId: 'rq-in3', payload: { text: '' } })
        // The correlator on the success half. All three `input:type-*` producers here took a literal in the
        // mutation round without a single test noticing — and the two client tests that echo it echo it
        // *correctly*, so a predicate that stopped checking would have matched either way.
        expect((await ack).requestId).toBe('rq-in3')
        expect(inputText).not.toHaveBeenCalled()
      })

      it('acks input:type-error when the text is rejected', async () => {
        vi.spyOn(adb, 'inputText').mockRejectedValue(new Error('ASCII only'))
        const ack = waitForType(browser, 'input:type-error')
        inject({ type: 'input:type', requestId: 'rq-in4', payload: { text: '안녕' } })
        const err = await ack
        expect(err.message).toBe('ASCII only')
        expect(err.requestId).toBe('rq-in4')
      })
    })

    describe('input — button', () => {
      it('forwards a named button press to the touch helper', () => {
        const helper = getState().touchHelper!
        inject({ type: 'input:button', requestId: 'rq-in5', payload: { name: 'home' } })
        expect(helper.pressButton).toHaveBeenCalledWith('home')
      })
    })

    describe('input — keyboard', () => {
      it('sends a keyevent for a special key (Enter → 66)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        inject({ type: 'input:key', requestId: 'rq-in6', payload: { code: 'Enter', modifiers: 0 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', '66')
      })

      // #416. `input keyevent` carries no meta state, so Shift+Arrow reached the device as a bare arrow
      // and moved the caret instead of selecting.
      it('holds the modifiers for a special key (Shift+ArrowLeft → SHIFT_LEFT + DPAD_LEFT)', () => {
        const comboSpy = vi.spyOn(adb, 'sendKeyCombination')
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        inject({ type: 'input:key', requestId: 'rq-in6a', payload: { code: 'ArrowLeft', modifiers: 0x02 } })
        expect(comboSpy).toHaveBeenCalledWith('emulator-5554', ['59', '21'])
        expect(keyEvSpy).not.toHaveBeenCalled()
      })

      it('holds Ctrl, Shift and Alt together, in the order the HID bits give them', () => {
        const comboSpy = vi.spyOn(adb, 'sendKeyCombination')
        inject({ type: 'input:key', requestId: 'rq-in6b', payload: { code: 'ArrowRight', modifiers: 0x01 | 0x02 | 0x04 } })
        expect(comboSpy).toHaveBeenCalledWith('emulator-5554', ['113', '59', '57', '22'])
      })

      // Android gives Meta+Arrow no editing meaning, and Cmd is a Mac viewer's only route to word-wise
      // selection. Ctrl and Cmd together still hold Ctrl once.
      it('holds Meta (Cmd) as Ctrl, once even when both are set', () => {
        const comboSpy = vi.spyOn(adb, 'sendKeyCombination')
        inject({ type: 'input:key', requestId: 'rq-in6f', payload: { code: 'ArrowLeft', modifiers: 0x08 | 0x02 } })
        inject({ type: 'input:key', requestId: 'rq-in6g', payload: { code: 'ArrowLeft', modifiers: 0x08 | 0x01 } })
        expect(comboSpy).toHaveBeenNthCalledWith(1, 'emulator-5554', ['113', '59', '21'])
        expect(comboSpy).toHaveBeenNthCalledWith(2, 'emulator-5554', ['113', '21'])
      })

      it('answers delivered when the combination was pressed', async () => {
        vi.spyOn(adb, 'sendKeyCombination').mockResolvedValue(true)
        const acked = waitForType(browser, 'input:done')
        inject({ type: 'input:key', requestId: 'rq-in6c', payload: { code: 'Home', modifiers: 0x02 } })
        expect((await acked).requestId).toBe('rq-in6c')
      })

      // Android below 13 has no `keycombination`. Falling back to the bare key would move the caret
      // when the tester asked to select, which is the bug itself, so nothing is pressed.
      it('answers unsupported, and presses nothing, where the device cannot hold a modifier', async () => {
        vi.spyOn(adb, 'sendKeyCombination').mockResolvedValue(false)
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in6d', payload: { code: 'ArrowLeft', modifiers: 0x02 } })
        const e = await errored
        expect(e.requestId).toBe('rq-in6d')
        expect(e.reason).toBe('unsupported')
        expect(keyEvSpy).not.toHaveBeenCalled()
      })

      it.each(['Home', 'End', 'PageUp', 'PageDown'])('treats %s as a caret key: unsupported, not pressed bare', async (code) => {
        vi.spyOn(adb, 'sendKeyCombination').mockResolvedValue(false)
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: `rq-caret-${code}`, payload: { code, modifiers: 0x02 } })
        expect((await errored).reason).toBe('unsupported')
        expect(keyEvSpy).not.toHaveBeenCalled()
      })

      // A modifier changes only what a caret key means. Shift+Space is still a space, so where the
      // device cannot hold Shift it is pressed bare, as it always was — not dropped with an error.
      it('presses a non-caret key bare where the device cannot hold a modifier (Shift+Space)', async () => {
        vi.spyOn(adb, 'sendKeyCombination').mockResolvedValue(false)
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const acked = waitForType(browser, 'input:done')
        inject({ type: 'input:key', requestId: 'rq-in6h', payload: { code: 'Space', modifiers: 0x02 } })
        expect((await acked).requestId).toBe('rq-in6h')
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', '62')
      })

      // Cmd+Enter was always the bare Enter that submits a field; Ctrl+Enter may not be.
      it('drops Meta on a non-caret key, as before (Cmd+Enter → bare Enter)', () => {
        const comboSpy = vi.spyOn(adb, 'sendKeyCombination')
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        inject({ type: 'input:key', requestId: 'rq-in6i', payload: { code: 'Enter', modifiers: 0x08 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', '66')
        expect(comboSpy).not.toHaveBeenCalled()
      })

      it('answers failed when the combination command itself rejects', async () => {
        vi.spyOn(adb, 'sendKeyCombination').mockRejectedValue(new Error('device offline'))
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in6e', payload: { code: 'ArrowLeft', modifiers: 0x02 } })
        expect((await errored).message).toBe('the device rejected the input')
      })

      it('types a lowercase character for a letter key with no shift', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in7', payload: { code: 'KeyA', modifiers: 0 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'a')
      })

      it('types an uppercase character when shift modifier is set', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in8', payload: { code: 'KeyA', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'A')
      })

      it('maps a shifted digit to its symbol (Digit1 + shift → !)', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in9', payload: { code: 'Digit1', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', '!')
      })

      // followups M1: a Cmd/Ctrl chord used to be typed as the raw letter (Cmd+C → 'c'), so
      // copy/paste both silently failed. They must map to the dedicated keycodes instead.
      it('maps Cmd+C (meta) to KEYCODE_COPY, not a typed "c"', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in10', payload: { code: 'KeyC', modifiers: 0x08 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_COPY')
        expect(inputSpy).not.toHaveBeenCalled()
      })

      it('maps Cmd+V to KEYCODE_PASTE and Ctrl+X to KEYCODE_CUT', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in11', payload: { code: 'KeyV', modifiers: 0x08 } })
        inject({ type: 'input:key', requestId: 'rq-in12', payload: { code: 'KeyX', modifiers: 0x01 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_PASTE')
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_CUT')
        expect(inputSpy).not.toHaveBeenCalled()
      })

      it('does not type the raw letter for a non-clipboard chord (Cmd+A)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in13', payload: { code: 'KeyA', modifiers: 0x08 } })
        expect(inputSpy).not.toHaveBeenCalled()
        expect(keyEvSpy).not.toHaveBeenCalled()
      })

      it('still types a plain letter with no chord modifier (regression)', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in14', payload: { code: 'KeyC', modifiers: 0 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'c')
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
      it('ignores an opening frame for an unknown session without throwing', () => {
        // Opening frames have no ack obligation, so silence is the right answer here.
        expect(() =>
          internals(agent).handleRelayMessage({ type: 'input:touch:start', sessionId: 'nope', payload: { x: 0.5, y: 0.5 } }),
        ).not.toThrow()
      })

      // A *terminal* frame is different: the caller is waiting. The reachable shape is a session
      // the relay still routes for while the agent holds no state for it — an agent that restarted
      // with a dashboard tab still attached (#426). The relay answers on an agent's behalf only
      // when the agent is *offline*, so here nothing would answer at all and the caller waits out
      // its own timeout, which its fallback then reports as success.
      // Asserted on what the agent sends, not on what arrives at the browser: the relay answers
      // `agent offline` for these types on its own when the agent socket is down, so routing a
      // reply through it would test the relay's fallback rather than the agent's.
      for (const [type, payload] of [
        ['input:touch:end', { x: 0.5, y: 0.5 }],
        ['input:pinch:end', { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } }],
        ['input:button', { name: 'back' }],
        ['input:key', { code: 'KeyA' }],
      ] as Array<[string, Record<string, unknown>]>) {
        it(`answers input:error for ${type} when the agent has lost the session's state`, () => {
          // Captured first: `agent.sessionId` is derived from `deviceStates`, so clearing the map
          // would also make the id null — and then the ack has nothing to address.
          const sessionId = agent.sessionId
          const sent = vi.spyOn(internals(agent).ws!, 'send')
          internals(agent).deviceStates.clear()

          internals(agent).handleRelayMessage({ type, sessionId, requestId: 'rq-gone', payload })

          const acks = sent.mock.calls
            .map(([raw]) => JSON.parse(raw as string) as { type: string; requestId?: string; message?: string })
            .filter((m) => m.type === 'input:error')
          expect(acks).toHaveLength(1)
          expect(acks[0].message).toContain('no active session')
          // `ackNoSession` has no `state` to hang a correlator on, so it must arrive as an argument.
          expect(acks[0].requestId).toBe('rq-gone')
        })
      }
    })

    // Every terminal ack used to be computed from a proxy — a channel reference, a helper object
    // that has no process, or a resolvable serial — rather than from what the dispatch reported.
    describe('input acks report the dispatch, not a proxy', () => {
      it('answers channel-down without writing when the channel is not ready', async () => {
        const control = getState().scrcpySession!.control
        vi.mocked(control.isReady).mockReturnValue(false)

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in15', payload: { x: 0.5, y: 0.5 } })

        const e = await errored
        expect(e['message']).toBe('input channel not ready')
        // The error half of `ackInput`. See the iOS twin: an unmatched `input:error` is resolved
        // optimistically by `awaitInputAck`, so a stated device failure reaches the caller as success.
        expect(e['requestId']).toBe('rq-in15')
        expect(control.touchUp).not.toHaveBeenCalled()
      })

      // Deliberately driven through the *helper*, not the scrcpy control: this describe is pinned to
      // the scrcpy backend, whose writes are synchronous and void, so a rejecting pointer channel
      // there would only be testing the mock's contract. The gRPC backend is the one that can
      // genuinely reject, and `EmulatorGrpcClient.test.ts` covers that end of it.
      it('answers failed when a dispatch rejects on a live path', async () => {
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.touchHelper!.touchEnd.mockResolvedValue('failed')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in16', payload: { x: 0.5, y: 0.5 } })

        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('answers failed when the button dispatch rejects', async () => {
        // Buttons go through the adb helper on both backends — the path that actually runs a
        // command in production.
        const helper = getState().touchHelper!
        helper.pressButton.mockResolvedValue('failed')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:button', requestId: 'rq-in17', payload: { name: 'back' } })

        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('answers unsupported for a button name the helper has no mapping for', async () => {
        const helper = getState().touchHelper!
        helper.pressButton.mockResolvedValue('unsupported')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:button', requestId: 'rq-in18', payload: { name: 'not_a_button' } })

        expect((await errored)['message']).toContain('not supported')
      })

      it('answers unsupported for a pinch that fell back to the adb path', async () => {
        // No pointer channel → the adb helper, which implements no pinch at all and used to accept
        // the frames and answer success.
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        inject({ type: 'input:pinch:end', requestId: 'rq-in19', payload: { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } } })

        expect((await errored)['message']).toContain('not supported')
      })

      it('answers channel-down for a tap with neither a channel nor a helper', async () => {
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.touchHelper = null

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-in20', payload: { x: 0.5, y: 0.5 } })

        expect((await errored)['message']).toBe('input channel not ready')
      })

      // The ws dispatch swallows synchronous throws, so destructuring out in the handler body left
      // the caller with no ack at all. The *reason* matters as much as the answer: a payload problem
      // is not a dead channel, and saying so would be the lie this vocabulary exists to prevent.
      for (const type of ['input:button', 'input:key']) {
        it(`answers malformed — not channel-down — for a ${type} with no payload`, async () => {
          const errored = waitForType(browser, 'input:error')
          internals(agent).handleRelayMessage({ type, sessionId: agent.sessionId, requestId: 'rq-malformed' })
          expect((await errored)['message']).toContain('missing what it needs')
        })
      }

      it('does not cache the boot verify across a reboot that started under the dispatch', async () => {
        // The ack is now sent after an awaited dispatch, so a `device:boot` can land in between.
        // Caching `booted` from a verify that raced it would let every later input on the session
        // skip the check while the device is still coming up.
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.booted = false
        let release: (v: string) => void = () => {}
        state.touchHelper!.touchEnd.mockReturnValue(new Promise((r) => { release = r }))

        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in21', payload: { x: 0.5, y: 0.5 } })
        state.bootSeq += 1 // a reboot begins while the dispatch is still in flight
        release('delivered')
        await done

        expect(state.booted).toBe(false)
      })

      // The mutation this missed: `state.booted` was cached from the verify without checking the
      // outcome, so the *second* input on an unbooted session skipped the verify and answered done.
      it('does not cache the boot verify when the device is not booted', async () => {
        const listDevices = vi.spyOn(adb, 'listDevices').mockResolvedValue([
          { id: 'avd:Pixel_8_API_34', name: 'Pixel 8', platform: 'android', status: 'shutdown', osVersion: '14' },
        ])
        getState().booted = false

        for (const attempt of [1, 2]) {
          const errored = waitForType(browser, 'input:error')
          inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
          inject({ type: 'input:touch:end', requestId: 'rq-in22', payload: { x: 0.5, y: 0.5 } })
          expect((await errored)['message'], `attempt ${attempt}`).toBe('device not booted')
        }
        // Re-verified rather than trusting a cache that the first attempt must not have written.
        expect(listDevices.mock.calls.length).toBeGreaterThanOrEqual(2)
      })
    })

    // #487: a gesture's opening and closing frames used to pick their backend by different
    // conditions, so one gesture could open on the adb helper and close on the pointer channel — a
    // touch-up with no touch-down answered `delivered`, and the helper left mid-gesture tapped the
    // abandoned position on the next end it got. The backend is now chosen once, when it opens.
    describe('a gesture stays on the backend that opened it', () => {
      const control = () => getState().scrcpySession!.control as unknown as Record<string, ReturnType<typeof vi.fn>>
      const helper = () => getState().touchHelper!
      const replaceSession = () => {
        // A fresh channel, as a stream restart leaves behind: same kind, different identity.
        getState().scrcpySession = new ScrcpySession() as unknown as TestState['scrcpySession']
      }

      it('closes on the helper a gesture that opened there, even once the channel is back', async () => {
        const state = getState()
        const session = state.scrcpySession
        state.scrcpySession = null            // the restart window: helper up, channel not yet
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        state.scrcpySession = session         // the channel arrives before the finger lifts

        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:touch:end', requestId: 'rq-g1', payload: { x: 0.25, y: 0.75 } })
        await done
        expect(helper().touchEnd).toHaveBeenCalled()
        expect(control().touchUp, 'a touch-up with no touch-down').not.toHaveBeenCalled()
      })

      it('answers no-gesture when the channel that opened it has been replaced', async () => {
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        const old = control()
        replaceSession()

        const err = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-g2', payload: { x: 0.25, y: 0.75 } })
        expect((await err)['reason']).toBe('no-gesture')
        expect(old.touchUp).not.toHaveBeenCalled()
        // Released on the channel serving now, where the gesture was: a gRPC emulator keeps the pointer
        // down across the client a restart replaced, and the next press would read as a drag from here.
        expect(control().touchUp).toHaveBeenCalledWith(0, 270, 1800)
        expect(helper().touchEnd).not.toHaveBeenCalled()
      })

      // A cancel lets go with a cancel there too: an up on the channel serving now would complete the gesture (#1115).
      it('cancels on the channel serving now when the one that opened the touch was replaced', () => {
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        const old = control()
        replaceSession()
        inject({ type: 'input:touch:cancel' })
        expect(old.touchCancel).not.toHaveBeenCalled()
        expect(control().touchCancel).toHaveBeenCalledWith(0, 270, 1800)
        expect(control().touchUp).not.toHaveBeenCalled()
      })

      it('answers no-gesture, not channel-down, when a restart has emptied everything', async () => {
        // The touch-down did land, on the channel the restart just dropped; the stream heals by itself
        // a moment later. `channel-down` would toast "not reaching this device" and tell MCP to reconnect.
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        const state = getState()
        state.scrcpySession = null
        state.touchHelper = null

        const err = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-g3', payload: { x: 0.25, y: 0.75 } })
        expect((await err)['reason']).toBe('no-gesture')
      })

      it('does not tap where an abandoned helper gesture was', async () => {
        const state = getState()
        const session = state.scrcpySession
        state.scrcpySession = null
        inject({ type: 'input:touch:start', payload: { x: 0.9, y: 0.1 } }) // opens on the helper…
        state.scrcpySession = session
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } }) // …and a new one replaces it
        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:touch:end', requestId: 'rq-g4a', payload: { x: 0.5, y: 0.5 } })
        await done

        // The stray end arrives while the channel is down again, so it can only fall to the helper — the one
        // left armed with the abandoned gesture's position. That is where the phantom tap came from.
        state.scrcpySession = null
        const err = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-g4b', payload: { x: 0.5, y: 0.5 } }) // a stray end
        expect((await err)['reason']).toBe('no-gesture')
        expect(helper().touchEnd, 'the stray end reached the helper holding the old position').not.toHaveBeenCalled()
      })

      it('drops a move with no gesture behind it', () => {
        inject({ type: 'input:touch:move', payload: { x: 0.3, y: 0.3 } })
        expect(control().touchMove).not.toHaveBeenCalled()
        expect(helper().touchMove).not.toHaveBeenCalled()
      })

      it('keeps the next tap when the previous end is still being dispatched', async () => {
        // The helper's end takes hundreds of ms (a size lookup and an adb child), and the viewer does
        // not wait for acks between taps — so the record is released before the dispatch, not after.
        const state = getState()
        state.scrcpySession = null
        let release: (v: 'delivered') => void = () => {}
        helper().touchEnd
          .mockImplementationOnce(() => new Promise((r) => { release = r }))
          .mockImplementationOnce(async () => 'delivered')

        inject({ type: 'input:touch:start', payload: { x: 0.2, y: 0.2 } })
        inject({ type: 'input:touch:end', requestId: 'rq-g6a', payload: { x: 0.2, y: 0.2 } })
        inject({ type: 'input:touch:start', payload: { x: 0.6, y: 0.6 } })
        const acks: string[] = []
        browser.on('message', (raw) => {
          const m = JSON.parse(String(raw)) as Record<string, string>
          if (m['type'] === 'input:done' || m['type'] === 'input:error') acks.push(`${m['requestId']}:${m['type']}`)
        })
        inject({ type: 'input:touch:end', requestId: 'rq-g6b', payload: { x: 0.6, y: 0.6 } })
        release('delivered')
        await vi.waitFor(() => expect(acks.sort()).toEqual(['rq-g6a:input:done', 'rq-g6b:input:done']))
      })

      it('does not route a touch move into an open pinch', () => {
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        inject({ type: 'input:touch:move', payload: { x: 0.5, y: 0.5 } })
        expect(control().touchMove).not.toHaveBeenCalled()
      })

      it('does not let a stray touch end close an open pinch', async () => {
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        const err = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-g8a', payload: { x: 0.5, y: 0.5 } })
        expect((await err)['reason']).toBe('no-gesture')
        expect(control().touchUp).not.toHaveBeenCalled()

        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:pinch:end', requestId: 'rq-g8b', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        await done
        expect(control().pinchEnd, 'the pinch would keep its second pointer down').toHaveBeenCalledOnce()
      })

      it('answers no-gesture for a pinch whose channel was replaced', async () => {
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        const old = control()
        replaceSession()

        const err = waitForType(browser, 'input:error')
        inject({ type: 'input:pinch:end', requestId: 'rq-g7', payload: { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } } })
        expect((await err)['reason']).toBe('no-gesture')
        expect(old.pinchEnd).not.toHaveBeenCalled()
        expect(control().pinchEnd, 'both pointers released on the channel serving now').toHaveBeenCalledOnce()
      })
    })

    // `handleKeyInput` resolves without sending anything in two branches. Judging by "did it throw"
    // reproduced the very lie this change removes.
    describe('input — key outcomes', () => {
      it('answers unsupported for a chord it deliberately does not send', async () => {
        const sendKeyEvent = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in23', payload: { code: 'KeyA', modifiers: 0x08 } }) // Cmd+A
        expect((await errored)['message']).toContain('not supported')
        expect(sendKeyEvent).not.toHaveBeenCalled()
      })

      it('answers unsupported for a code that is only a prototype member', async () => {
        const sendKeyEvent = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in24', payload: { code: 'constructor', modifiers: 0 } })
        expect((await errored)['message']).toContain('not supported')
        expect(sendKeyEvent).not.toHaveBeenCalled()
      })

      it('answers unsupported for a code with no character mapping', async () => {
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in25', payload: { code: 'CapsLock', modifiers: 0 } })
        expect((await errored)['message']).toContain('not supported')
      })

      it('answers failed when the key dispatch rejects', async () => {
        vi.spyOn(adb, 'sendInput').mockRejectedValue(new Error('offline'))
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in26', payload: { code: 'KeyA', modifiers: 0 } })
        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('still answers input:done for a key it does send', async () => {
        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:key', requestId: 'rq-in27', payload: { code: 'Enter', modifiers: 0 } })
        await done
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

      // #455. A failed `emu kill` used to be logged as "already gone?" and answered done, so a caller was
      // told the device was off while the emulator kept running. Whether it is gone is now asked of the
      // process table, which is what Full reset already trusts for the same question.
      describe('a kill that fails is judged by whether the emulator is still there', () => {
        const owned = () => (agent as unknown as { ownedDevices: Set<string> }).ownedDevices
        beforeEach(() => {
          ;(agent as unknown as { shutdownSettleMs: number }).shutdownSettleMs = 60
          // Module-level mocks: the Full reset tests above call both, and counts would carry over.
          vi.mocked(probeEmulator).mockClear()
          vi.mocked(stopEmulatorProcess).mockClear()
        })
        afterEach(() => vi.mocked(probeEmulator).mockReturnValue({ state: 'gone' }))

        it('answers shutdown-error while the emulator is still running, and keeps it', async () => {
          vi.spyOn(adb, 'shutdown').mockRejectedValue(new Error('console refused'))
          vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
          owned().add('avd:Pixel_8_API_34')

          const done = waitForTypeOrNull(browser, 'device:shutdown-done', 400)
          const err = waitForType(browser, 'device:shutdown-error')
          inject({ type: 'device:shutdown', requestId: 'rq-kill', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          const msg = await err
          expect(msg['requestId']).toBe('rq-kill')
          expect(msg['message']).toContain('console refused')
          expect(await done, 'a failed shutdown must not also claim success').toBeNull()
          // The process table is keyed by AVD name; the `avd:` id would match nothing and read as gone.
          expect(probeEmulator).toHaveBeenCalledWith('Pixel_8_API_34')
          expect(adb.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
          expect(owned().has('avd:Pixel_8_API_34')).toBe(true)
        })

        it('answers shutdown-error when it cannot tell', async () => {
          vi.spyOn(adb, 'shutdown').mockRejectedValue(new Error('console refused'))
          vi.mocked(probeEmulator).mockReturnValue({ state: 'unknown' })

          const err = waitForType(browser, 'device:shutdown-error')
          inject({ type: 'device:shutdown', requestId: 'rq-unknown', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          expect((await err)['requestId']).toBe('rq-unknown')
          // A missing or failing pgrep does not start working inside the window, so it is asked once.
          expect(probeEmulator).toHaveBeenCalledTimes(1)
        })

        it('leaves the device to a boot that started while it was confirming', async () => {
          // Back pressed mid-boot, then the device re-picked inside the window. Without the check the
          // probe's later `gone` is answered done — telling the relay the device is down in the middle
          // of the new boot — and clears the serial that boot is about to use.
          vi.spyOn(adb, 'shutdown').mockRejectedValue(new Error('device offline'))
          vi.mocked(probeEmulator)
            .mockImplementationOnce(() => { getState().bootSeq += 1; return { state: 'running', pid: 4321 } })
            .mockReturnValue({ state: 'gone' })

          const done = waitForTypeOrNull(browser, 'device:shutdown-done', 400)
          const err = waitForType(browser, 'device:shutdown-error')
          inject({ type: 'device:shutdown', requestId: 'rq-overtaken', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          const msg = await err
          expect(msg['requestId']).toBe('rq-overtaken')
          expect(msg['message']).toContain('A boot started')
          expect(await done).toBeNull()
          expect(adb.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
        })

        it('answers done once an emulator that was already exiting is gone', async () => {
          // The usual reason `emu kill` fails: adb has let go of an emulator qemu is still tearing down.
          // Asked once, straight after the failure, the process table still shows it.
          vi.spyOn(adb, 'shutdown').mockRejectedValue(new Error('device offline'))
          vi.mocked(probeEmulator)
            .mockReturnValueOnce({ state: 'running', pid: 4321 })
            .mockReturnValue({ state: 'gone' })

          const done = waitForType(browser, 'device:shutdown-done')
          inject({ type: 'device:shutdown', requestId: 'rq-exiting', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          expect((await done)['requestId']).toBe('rq-exiting')
          expect(adb.getSerial('avd:Pixel_8_API_34')).toBeUndefined()
        })

        it('answers shutdown-error with no serial while an emulator is still running', async () => {
          // No console to send the kill to — an adb server restart, or an emulator still coming up — used
          // to skip the kill and answer done regardless.
          const shutdown = vi.spyOn(adb, 'shutdown')
          adb.clearSerial('avd:Pixel_8_API_34')
          vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })

          const err = waitForType(browser, 'device:shutdown-error')
          inject({ type: 'device:shutdown', requestId: 'rq-noserial', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          expect((await err)['requestId']).toBe('rq-noserial')
          expect(shutdown).not.toHaveBeenCalled()
          // Not signalled either: a hard stop is reserved for Full reset, where the data is about to go.
          expect(stopEmulatorProcess).not.toHaveBeenCalled()
        })

        it('answers done with no serial when nothing is running', async () => {
          adb.clearSerial('avd:Pixel_8_API_34')
          const done = waitForType(browser, 'device:shutdown-done')
          inject({ type: 'device:shutdown', requestId: 'rq-noserial-gone', payload: { deviceId: 'avd:Pixel_8_API_34' } })
          expect((await done)['requestId']).toBe('rq-noserial-gone')
        })
      })

      it('answers a correlated shutdown it has no session state for, and only that one', async () => {
        const sessionId = agent.sessionId
        internals(agent).deviceStates.clear()

        const silent = waitForTypeOrNull(browser, 'device:shutdown-error', 300)
        internals(agent).handleRelayMessage({ type: 'device:shutdown', sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } })
        expect(await silent, 'nobody waits on an uncorrelated shutdown').toBeNull()

        const err = waitForType(browser, 'device:shutdown-error')
        internals(agent).handleRelayMessage({ type: 'device:shutdown', sessionId, requestId: 'rq-nostate', payload: { deviceId: 'avd:Pixel_8_API_34' } })
        const msg = await err
        expect(msg['requestId']).toBe('rq-nostate')
        expect(msg['message']).toBe(SHUTDOWN_NO_SESSION_STATE)
      })
    })

    // The reply direction for all three app commands. See the iOS suite for why: review made all six
    // `respond` helpers emit a fabricated correlator and both agent suites held their baselines exactly.
    describe('app command correlation', () => {
      const PAIRS = [
        { req: 'app:install', payload: { filePath: '/tmp/app.apk' }, call: 'installApp' as const },
        { req: 'app:launch', payload: { bundleId: 'com.example.app' }, call: 'launchApp' as const },
        { req: 'app:clear-state', payload: { bundleId: 'com.example.app' }, call: 'clearAppData' as const },
      ]

      for (const { req, payload, call } of PAIRS) {
        it(`${req} echoes the requestId on both outcomes`, async () => {
          // Mocked explicitly rather than left to fall through: `adb` here is a real object with spies
          // added per test, so an unmocked call reaches the real binary and the test times out instead of
          // failing. (`app:install` also calls `clearAppData` on its way, which is how that surfaced.)
          vi.spyOn(adb, call).mockResolvedValue(undefined)
          vi.spyOn(adb, 'clearAppData').mockResolvedValue(undefined)
          const done = waitForType(browser, `${req}-done`)
          inject({ type: req, requestId: 'echo-1', payload })
          expect((await done)['requestId']).toBe('echo-1')

          vi.spyOn(adb, call).mockRejectedValueOnce(new Error('nope'))
          const err = waitForType(browser, `${req}-error`)
          inject({ type: req, requestId: 'echo-2', payload })
          const msg = await err
          expect(msg['requestId']).toBe('echo-2')
          expect(msg['message']).toBe('nope')
        })

        it(`${req} answers two concurrent requests with their own ids`, async () => {
          // TC5 — the only test that sees a correlator hoisted out of per-request scope.
          let release: (() => void) | undefined
          vi.spyOn(adb, call)
            .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
            .mockImplementationOnce(() => Promise.resolve())

          inject({ type: req, requestId: 'con-A', payload })
          await vi.waitFor(() => expect(release).toBeDefined())

          // Sequential: `waitForType` does not correlate, so two concurrent waits would pass under the
          // mutation this exists to catch.
          inject({ type: req, requestId: 'con-B', payload })
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-B')

          release!()
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-A')
        })
      }
    })

    describe('misc — app:launch', () => {
      it('launches the package and acks with app:launch-done', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp')
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', requestId: 'rqi-1', payload: { bundleId: 'com.example.app' } })
        await done
        expect(launchSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app', undefined, false)
      })

      it('answers app:launch before process discovery completes', async () => {
        let releaseUidLookup!: (uid: number | null) => void
        const getAppUidSpy = vi.spyOn(adb, 'getAppUid').mockImplementation(() => new Promise((resolve) => {
          releaseUidLookup = resolve
        }))
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', requestId: 'rqi-log', payload: { bundleId: 'com.example.app' } })

        expect((await done)['requestId']).toBe('rqi-log')
        await vi.waitFor(() => expect(getAppUidSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app', expect.any(Number)))
        releaseUidLookup(null)
      })

      it('does not continue UID-scoped discovery after its deadline', async () => {
        let now = 10_000
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
        const previousAdbPath = process.env['ADB_PATH']
        process.env['ADB_PATH'] = process.execPath
        const state = getState() as TestState & {
          appLogGeneration: number
          appLogStream: { stop(): void } | null
        }
        state.appLogGeneration = 1
        state.appLogStream = null
        let packageTimeoutMs = 0
        const getAppUidSpy = vi.spyOn(adb, 'getAppUid').mockImplementation(async (_serial, _bundleId, timeoutMs = 2_000) => {
          expect(timeoutMs).toBe(2_000)
          now = 14_900
          return 10_123
        })
        const getPackagesSpy = vi.spyOn(adb, 'getPackagesForUid').mockImplementation(async (_serial, _uid, timeoutMs = 2_000) => {
          packageTimeoutMs = timeoutMs
          now = 15_000
          return ['com.example.app']
        })
        const hasProcessSpy = vi.spyOn(adb, 'hasAppProcessForUid').mockResolvedValue(true)

        try {
          await internals(agent).startAppLogStreamAfterLaunch(
            agent.sessionId!, state, 'emulator-5554', 'com.example.app', 'launch-deadline', 1
          )

          expect(getAppUidSpy).toHaveBeenCalledOnce()
          expect(getPackagesSpy).toHaveBeenCalledOnce()
          expect(packageTimeoutMs).toBe(100)
          expect(hasProcessSpy).not.toHaveBeenCalled()
          expect(state.appLogStream).toBeNull()
        } finally {
          const stream = (state as unknown as { appLogStream: { stop(): void } | null }).appLogStream
          stream?.stop()
          if (previousAdbPath === undefined) delete process.env['ADB_PATH']
          else process.env['ADB_PATH'] = previousAdbPath
          clock.mockRestore()
        }
      })

      it('does not stream logs for a UID shared by another package', async () => {
        const state = getState() as TestState & {
          appLogGeneration: number
          appLogStream: { stop(): void } | null
        }
        state.appLogGeneration = 1
        state.appLogStream = null
        const previousAdbPath = process.env['ADB_PATH']
        process.env['ADB_PATH'] = process.execPath
        vi.spyOn(adb, 'getAppUid').mockResolvedValue(10_123)
        const packagesSpy = vi.spyOn(adb, 'getPackagesForUid').mockResolvedValue([
          'com.example.app', 'com.example.helper'
        ])
        const hasProcessSpy = vi.spyOn(adb, 'hasAppProcessForUid').mockResolvedValue(true)

        try {
          await internals(agent).startAppLogStreamAfterLaunch(
            agent.sessionId!, state, 'emulator-5554', 'com.example.app', 'shared-uid', 1
          )

          expect(packagesSpy).toHaveBeenCalledOnce()
          expect(hasProcessSpy).not.toHaveBeenCalled()
          expect(state.appLogStream).toBeNull()
        } finally {
          const stream = (state as unknown as { appLogStream: { stop(): void } | null }).appLogStream
          stream?.stop()
          if (previousAdbPath === undefined) delete process.env['ADB_PATH']
          else process.env['ADB_PATH'] = previousAdbPath
        }
      })

      it('passes launch arguments through and reports their names', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp').mockResolvedValue({ arguments: { flag: true } })
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', requestId: 'rqi-2', payload: { bundleId: 'com.example.app', arguments: { flag: true } } })
        expect((await done)['applied']).toEqual({ arguments: ['flag'], env: [] })
        expect(launchSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app', { arguments: { flag: true } }, false)
      })

      // The relay's defaults the device could not take are reported as not applied, which is what a run record shows.
      it('reports what was delivered of the relay defaults, down to nothing', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp').mockResolvedValue(undefined)
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', requestId: 'rqi-5', payload: { bundleId: 'com.example.app', arguments: { flag: true }, defaultsOnly: true } })
        expect((await done)['applied']).toEqual({ arguments: [], env: [] })
        expect(launchSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app', { arguments: { flag: true } }, true)
      })

      it('refuses options the shared check refuses, without launching', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp')
        const err = waitForType(browser, 'app:launch-error')
        inject({ type: 'app:launch', requestId: 'rqi-3', payload: { bundleId: 'com.example.app', arguments: { '-x': 1 } } })
        const msg = await err
        expect(msg['requestId']).toBe('rqi-3')
        expect(msg['message']).toMatch(/leading "-"/)
        expect(launchSpy).not.toHaveBeenCalled()
      })

      it('answers an env launch with the platform refusal', async () => {
        const err = waitForType(browser, 'app:launch-error')
        inject({ type: 'app:launch', requestId: 'rqi-4', payload: { bundleId: 'com.example.app', env: { A: '1' } } })
        expect((await err)['message']).toMatch(/env is iOS-only/)
      })
    })

    describe('misc — open-url', () => {
      it('opens the URL on the device and echoes the requestId on open-url:done', async () => {
        const urlSpy = vi.spyOn(adb, 'openUrl')
        const done = waitForType(browser, 'open-url:done')
        inject({ type: 'open-url', requestId: 'req-1', payload: { url: 'https://example.com' } })
        expect((await done)['requestId']).toBe('req-1')
        expect(urlSpy).toHaveBeenCalledWith('emulator-5554', 'https://example.com')
      })

      it('reports open-url:error with the failure message, and echoes the requestId', async () => {
        vi.spyOn(adb, 'openUrl').mockRejectedValue(new Error('activity not found'))
        const err = waitForType(browser, 'open-url:error')
        inject({ type: 'open-url', requestId: 'req-2', payload: { url: 'https://example.com' } })
        const msg = await err
        expect(msg['message']).toBe('activity not found')
        expect(msg['requestId']).toBe('req-2')
      })

      it('drops a request with no requestId rather than answering uncorrelatably', async () => {
        // The correlator is required on the wire and there is no fallback, so a reply to this could not
        // be matched by anyone — and inventing an id would make it look like an answer to a request
        // nobody made. Every in-repo sender supplies one; validating third-party frames at the relay's
        // door is #444. Until then the honest outcome is nothing, which is what this pins.
        const urlSpy = vi.spyOn(adb, 'openUrl')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        inject({ type: 'open-url', payload: { url: 'https://example.com' } })
        await barrier(browser)
        expect(await waitForTypeOrNull(browser, 'open-url:done', 0)).toBeNull()
        expect(urlSpy).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('open-url without a requestId'))
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

      it('answers png for a jpeg request, because that is what it produced (#508)', async () => {
        // `screencap -p` produces PNG and takes no format argument, so the request is a preference
        // this platform cannot honour (see `ScreenshotRequest` in protocol). Echoing it sent PNG
        // bytes out under `format: 'jpeg'`, which the relay wrote into the HTTP Content-Type — and
        // `mcp-server` then picked a JPEG parser for the dimensions it feeds to `tap` as divisors.
        vi.spyOn(adb, 'screenshot').mockResolvedValue(Buffer.from('PNGDATA'))
        const sendSpy = vi.spyOn(internals(agent).ws!, 'send')

        inject({ type: 'screenshot:request', requestId: 'req-2', format: 'jpeg' })

        const sent = await vi.waitFor(() => {
          const msg = sendSpy.mock.calls
            .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
            .find((m) => m['type'] === 'screenshot:done')
          expect(msg).toBeDefined()
          return msg!
        }, { timeout: 1000 })

        expect(sent['format']).toBe('png')
        expect(sent['requestId']).toBe('req-2')
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
        requestId: 'rq-fix-13',
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
      grpcDisplaySize = { width: 1080, height: 2400 }

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

    it('boots into a known state rather than inheriting the last session\'s', async () => {
      // The wiring, not the arithmetic. `normaliseOnBoot` has its own suite; what this holds is
      // that the boot path calls it — the gap that let two sessions describe "the same" screen
      // and mean different things, and made every rotation reading unattributable.
      const setRotation = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
      const setPosture = vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
      vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(
        `DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}`)
      // Folded, the way the previous session left it.
      vi.spyOn(adb, 'deviceState').mockResolvedValue(`Committed state: DeviceState{identifier=0, name='CLOSED'}`)
      ;(adb as unknown as { body: { at: number } }).body.at = 90 // and turned, as a Fold AVD boots

      await bootDevice()

      expect(setPosture).toHaveBeenCalledWith('emulator-5554', '2')
      // No rotation lock any more — that is what kept apps from following the body. And this device was already
      // running, so its body is left where it is held: only a boot that brings it up, or a run, stands it up.
      expect(setRotation).not.toHaveBeenCalled()
      expect(adb.rotateBodyClockwise).not.toHaveBeenCalled()

      // **And before the stream, which is the half that took a second attempt.** Unfolding a
      // running stream makes the session's first act a resolution change, and this capture sends
      // nothing while the screen is static — so the viewer sat on "Waiting for stream…" until a
      // manual rotation produced a frame. Ordering is the fix, so ordering is what is held.
      expect(setPosture.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(EmulatorVideo).mock.invocationCallOrder[0]!)
      expect(vi.mocked(adb.readBodyRotation).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(EmulatorVideo).mock.invocationCallOrder[0]!)
    })

    it('takes the input divisor from the emulator before the stream opens', async () => {
      // The emulator and the guest disagree exactly when a foldable is folded, and a tap that
      // arrives before this is read is a tap divided by the wrong number. Reading it beside the
      // client, not lazily on first touch, is what makes that unreachable.
      grpcDisplaySize = { width: 2076, height: 2152 }
      await bootDevice()
      expect(getState().touchRange).toEqual({ width: 2076, height: 2152 })
      expect(vi.mocked(EmulatorVideo).mock.invocationCallOrder[0]).toBeGreaterThan(0)
    })

    it('leaves the divisor unset when the emulator does not answer', async () => {
      grpcDisplaySize = null
      await bootDevice()
      // Not a boot failure: `toDevicePx` falls back to the panel, which is what it always used.
      expect(getState().touchRange).toBeNull()
      expect(getState().emulatorVideo).not.toBeNull()
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

    // Clipboard bridge — the emulator gRPC controller exposes get/setClipboard, so the
    // Android side needs no adb (`cmd clipboard` is not implemented on the AVD images).
    describe('clipboard bridge', () => {
      beforeEach(() => { grpcClipboardText = ''; grpcClipboardError = null; grpcClipboardApplyDelayMs = 0 })
      afterEach(() => { grpcClipboardError = null; grpcClipboardApplyDelayMs = 0 })

      // `setClipboard` only schedules the change, so the step is done once the clipboard reads back empty — not before.
      it('reports the clipboard reset only after the clipboard reads back empty', async () => {
        grpcClipboardText = 'left by the last run'
        grpcClipboardApplyDelayMs = 150
        try {
          browser = new WebSocket(`ws://localhost:${port}`)
          await waitForOpen(browser)
          browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
          await waitForType(browser, 'session:joined')
          const readyPromise = waitForType(browser, 'device:ready')
          browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-reset-clip', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34', runReset: { uninstall: [], clear: [] } } }))
          const ready = await readyPromise
          expect((ready['payload'] as { runReset?: unknown }).runReset).toEqual({ done: ['pasteboard'], failed: [] })
          expect(grpcClipboardText).toBe('')
        } finally {
          grpcClipboardApplyDelayMs = 0
          grpcClipboardText = ''
        }
      })

      // Same gate as iOS: the viewer only enables the bridge when this arrives.
      it('advertises the clipboard capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('clipboard')
      })

      // #447: the toggle is gated on this, not on the platform string — so the capability and the
      // `-wipe-data` launch flag have to arrive together. Advertising it without the flag puts a
      // control on screen that erases nothing and then disarms, which reads as "done".
      it('advertises the full-reset capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('full-reset')
      })

      // #607. Added last on purpose: the string says "this agent has the code", so advertising it
      // before the handler exists puts a control on screen that does nothing — the failure #447
      // exists to document, two tests above in this same file.
      it('advertises the network-control capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('network-control')
      })

      it('clipboard:read returns the guest clipboard as clipboard:data', async () => {
        grpcClipboardText = '한글 テスト 🎉\nline2'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a1' }))
        const data = await waitForType(browser, 'clipboard:data')
        expect(data.requestId).toBe('a1')
        expect((data.payload as { text: string }).text).toBe('한글 テスト 🎉\nline2')
      })

      // The agent owns the chord: the browser cannot know when the keyevent lands, and
      // reading before it does returns the PREVIOUS clipboard.
      it('press:copy sends KEYCODE_COPY before it reads', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const order: string[] = []
        // the guest "copies" when the keyevent lands
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async (_s, k) => {
          order.push(String(k)); grpcClipboardText = 'copied'
        })
        const client = getState().grpcClient as unknown as { getClipboard: ReturnType<typeof vi.fn> }
        const realGet = client.getClipboard.getMockImplementation()! as () => Promise<string>
        client.getClipboard.mockImplementation(async () => { order.push('read'); return realGet() })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('copied')
        expect(order.indexOf('KEYCODE_COPY')).toBeLessThan(order.lastIndexOf('read'))
      })

      // The core guarantee: no answer until the guest clipboard actually changed.
      it('keeps watching until the clipboard actually changes', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        let reads = 0
        const client = getState().grpcClient as unknown as { getClipboard: ReturnType<typeof vi.fn> }
        const realGet = client.getClipboard.getMockImplementation()! as () => Promise<string>
        client.getClipboard.mockImplementation(async () => (++reads <= 3 ? realGet() : 'what the app copied'))
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2b', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('what the app copied')
        expect(reads).toBeGreaterThan(2)   // a fixed delay would have answered on the first read
      })

      // B1: setClipboard only *schedules* the change. If the chord is pressed before the
      // sentinel is visible, the first poll reads the pre-sentinel value and returns it as the
      // copy result — the exact stale value the sentinel exists to prevent.
      it('waits for the sentinel to be applied before pressing the chord', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        grpcClipboardApplyDelayMs = 60          // the guest lags behind the resolved call
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => {
          setTimeout(() => { grpcClipboardText = 'WHAT THE APP COPIED' }, 60)
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b1', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('WHAT THE APP COPIED')
      }, 10_000)

      // M2: without the per-device queue, two reads trade sentinels — one returns the other's
      // marker and a sentinel is left on the device.
      // Mirror of the iOS test of the same name. Reverting Android to reply-after-restore
      // previously broke nothing here, so the platform's half of the ordering was unguarded.
      it('answers before it restores, and still restores before releasing the device', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        const realSet = client.setClipboard.getMockImplementation() as ((t: string) => Promise<void>) | undefined
        let restoreDone = false
        // Make the restore slow enough that "reply first" cannot be a scheduling artefact.
        client.setClipboard.mockImplementation(async (text: string) => {
          if (text === 'ORIGINAL') {
            await new Promise((r) => setTimeout(r, 400))
            restoreDone = true
          }
          return realSet?.(text)
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'ord', payload: { press: 'copy' },
        }))
        await waitForType(browser, 'clipboard:error')
        expect(restoreDone).toBe(false)   // answered while the restore was still in flight
        await vi.waitFor(() => expect(restoreDone).toBe(true), { timeout: 3000 })
      }, 15_000)

      it('reports a parked sentinel when the copy failed after the marker went down', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp1', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)
      }, 10_000)

      // The flag describes the DEVICE, not the operation that answers: the chord the viewer would
      // press in response travels as `input:key`, outside the queue that keeps operations apart.
      it('reports a sentinel parked by a different in-flight operation', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'hold', payload: { press: 'copy' },
        }))
        await vi.waitFor(() => expect(grpcClipboardText.startsWith('\u200Btapflow-clipboard-')).toBe(true), { timeout: 2000 })

        // Rejected up front, before the queue — so it answers while the read above still holds.
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'big',
          payload: { text: 'x'.repeat(1024 * 1024 + 1) },   // MAX_CLIPBOARD_BYTES + 1
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('big')
        expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

        // Let the read finish before leaving: it still holds the device queue, and the next test
        // would otherwise wait out its deadline and restore.
        await vi.waitFor(() => expect(grpcClipboardText).toBe('ORIGINAL'), { timeout: 5000 })
      }, 20_000)

      // Only reachable if the per-device queue fails, but the queue is the sole thing standing
      // between these and a corrupted clipboard, so the discrimination itself is pinned.
      it('never hands a foreign sentinel back as copied text', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => {
          grpcClipboardText = '\u200Btapflow-clipboard-someone-else'   // another operation's marker
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f1', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/did not copy/i)   // not clipboard:data carrying the marker
      }, 10_000)

      it('does not restore a foreign sentinel as if it were the user text', async () => {
        grpcClipboardText = '\u200Btapflow-clipboard-someone-else'   // already parked on arrival
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f2', payload: { press: 'copy' },
        }))
        await waitForType(browser, 'clipboard:error')
        // Restoring it would leave it for the NEXT read to mistake for the original.
        await vi.waitFor(() => expect(grpcClipboardText).toBe(''), { timeout: 2000 })
      }, 10_000)

      it('serialises overlapping reads so they cannot trade sentinels', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies

        const seen: string[] = []
        browser.on('message', (d) => {
          const m = JSON.parse(d.toString()) as { type: string; requestId?: string; payload?: unknown }
          if (m.type === 'clipboard:data') seen.push(`${m.requestId}:${(m.payload as { text: string }).text}`)
          if (m.type === 'clipboard:error') seen.push(`${m.requestId}:ERR`)
        })
        // The guest applies a scheduled setClipboard late, so releasing the queue before the
        // restore lands lets the next read see the sentinel as "the original" — and then wipe it.
        grpcClipboardApplyDelayMs = 120

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'P1', payload: { press: 'copy' } }))
        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'P2', payload: { press: 'copy' } }))
        await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 9000 })

        // Neither may report a sentinel as the copied text, and the original must survive.
        expect(seen).toEqual(['P1:ERR', 'P2:ERR'])
        await vi.waitFor(() => expect(grpcClipboardText).toBe('ORIGINAL'), { timeout: 2000 })
      }, 15_000)

      it('fails and restores the original when the device never copies', async () => {
        grpcClipboardText = 'untouched original'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest ignores it

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2c', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/did not copy/i)
        expect(grpcClipboardText).toBe('untouched original')   // no sentinel left behind
      }, 10_000)

      it('press:cut sends KEYCODE_CUT instead', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => { grpcClipboardText = 'cut text' })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a3', payload: { press: 'cut' },
        }))
        await waitForType(browser, 'clipboard:data')
        expect(keys).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_CUT')
      })

      it('clipboard:write sets the guest clipboard and acks only after it landed', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        client.setClipboard.mockReturnValue(gate)

        let acked = false
        void waitForType(browser, 'clipboard:write-done').then(() => { acked = true })
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a4', payload: { text: 'pasted' },
        }))
        await vi.waitFor(() => expect(client.setClipboard).toHaveBeenCalledWith('pasted'))
        await new Promise((r) => setTimeout(r, 50))
        expect(acked).toBe(false)
        release()
        await vi.waitFor(() => expect(acked).toBe(true))
      })

      it('pasteAfter sends KEYCODE_PASTE after the write', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        const done = waitForType(browser, 'clipboard:write-done')
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a5', payload: { text: 'x', pasteAfter: true },
        }))
        await done
        expect(keys).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_PASTE')
        expect(grpcClipboardText).toBe('x')
      })

      it('does not press paste when pasteAfter is not asked for', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        const done = waitForType(browser, 'clipboard:write-done')
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a6', payload: { text: 'x' },
        }))
        await done
        expect(keys).not.toHaveBeenCalled()
      })

      it('rejects an oversized clipboard instead of forwarding it', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        client.setClipboard.mockClear()

        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a7',
          payload: { text: 'x'.repeat(1024 * 1024 + 1) },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/too large/i)
        expect(client.setClipboard).not.toHaveBeenCalled()
      })

      // The press-less read forwarded whatever the guest held straight to the relay. iOS is
      // bounded by getPasteboard's maxBuffer; Android had nothing, so a multi-MB guest
      // clipboard could land on the socket the video stream shares.
      it('caps a press-less read too, not just the sentinel path', async () => {
        grpcClipboardText = 'x'.repeat(1024 * 1024 + 1)
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'cap' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/too large/i)
      })

      it('an empty clipboard is data, not an error', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a8' }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('')
      })

      it('surfaces a gRPC failure as clipboard:error', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        grpcClipboardError = new Error('UNAVAILABLE: no connection')

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a9' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('a9')
        expect(err.message).toContain('UNAVAILABLE')
        // A transient gRPC fault is NOT "unsupported": the backend has a clipboard channel, it
        // just failed this time. This request carries no `press`, so nothing was ever parked and
        // the viewer is free to fall back to the chord.
        const payload = err.payload as { unsupported: boolean; sentinelParked: boolean }
        expect(payload.unsupported).toBe(false)
        expect(payload.sentinelParked).toBe(false)
      })

      // R8: the scrcpy backend (real devices, and the gRPC fallback) has no clipboard
      // channel. It must say so — and say something DIFFERENT from "not booted", since
      // the two need different fixes.
      it('reports the backend limitation on scrcpy, distinctly from a missing device', async () => {
        grpcStartError = new Error('emulator -grpc not available')
        await bootDevice()
        await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
        expect(getState().grpcClient).toBeNull()

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a10' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('a10')
        expect(err.message).toMatch(/gRPC backend/i)
        expect(err.message).not.toMatch(/no booted device/i)
        // Flagged so the viewer can safely press the plain chord: a backend without a
        // clipboard channel can never leave a sentinel on the device.
        expect((err.payload as { unsupported: boolean }).unsupported).toBe(true)
      })
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

    // #341: with audio on, mute the emulator's host output on the agent Mac via a mute-only tap.
    it('host-mute: launches a mute-only tap on the emulator pid (audio on, macOS 14.2+)', async () => {
      vi.mocked(isAudioSupported).mockReturnValue(true)
      vi.mocked(findEmulatorPid).mockReturnValue(9999)
      vi.mocked(launchMuteOnlyTap).mockClear()
      await bootDevice()
      await vi.waitFor(() => expect(vi.mocked(launchMuteOnlyTap)).toHaveBeenCalledTimes(1))
      const [appPath, pids] = vi.mocked(launchMuteOnlyTap).mock.calls[0]
      expect(appPath).toBe('/fake/audiotap-helper.app')
      expect(pids).toEqual([9999])
      vi.mocked(isAudioSupported).mockReturnValue(false) // restore for the other tests
      vi.mocked(findEmulatorPid).mockReturnValue(null)
    })

    it('host-mute: skipped below macOS 14.2 (falls back to the Mac volume)', async () => {
      vi.mocked(isAudioSupported).mockReturnValue(false)
      vi.mocked(launchMuteOnlyTap).mockClear()
      await bootDevice()
      await new Promise((r) => setTimeout(r, 30))
      expect(vi.mocked(launchMuteOnlyTap)).not.toHaveBeenCalled()
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
    serverWs!.send(JSON.stringify({ type: 'app:install', requestId: 'rqi-2', sessionId: 'unknown', payload: { filePath: '/tmp/app.apk' } }))

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
      // 느린 러너에서 address()가 null일 수 있으므로 listening 이후 포트를 읽는다
      await new Promise<void>((r) => wss.once('listening', r))
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
    // listening 이후 포트를 읽어 느린 러너의 null address()를 피한다 (CodeRabbit #272 ③)
    async function withServer(
      onConnection: (sock: WebSocket) => void,
      run: (url: string) => Promise<void>,
    ): Promise<void> {
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>((r) => wss.once('listening', r))
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', (sock) => onConnection(sock as unknown as WebSocket))
      try {
        await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('등록 전 1008 close → code/reason을 담아 reject한다 (무한 대기 없음)', async () => {
      await withServer(
        (sock) => sock.close(1008, 'Unauthorized: agents need a PAT'),
        async (url) => {
          const agent = new AndroidAgent({}, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/code=1008.*Unauthorized: agents need a PAT/)
        },
      )
    })

    it('agent:registered 응답이 없으면 handshakeTimeoutMs 후 reject한다', async () => {
      await withServer(
        () => { /* 업그레이드만 수락, 무응답 */ },
        async (url) => {
          const agent = new AndroidAgent({ handshakeTimeoutMs: 150 }, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/timed out after 150ms/)
        },
      )
    })

    // CodeRabbit #272 ② — malformed 첫 프레임이 핸들러에서 throw되어 connect()가 행되지 않는다
    it('등록 전 malformed(비-JSON) 프레임 → 행 없이 reject한다', async () => {
      await withServer(
        (sock) => sock.on('message', () => sock.send('not-json{{{')),
        async (url) => {
          const agent = new AndroidAgent({ handshakeTimeoutMs: 1000 }, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/malformed|handshake/i)
        },
      )
    })
  })
})

describe('reconcileScreen (the wiring, not the arithmetic)', () => {
  /** **Carries no posture.** Which panel is lit shows up in the metrics alone — an earlier
   *  version passed a posture id here to feed a per-posture offset, and the posture-exception
   *  test below is what holds that the correction never reads one. */
  const stateFor = () => ({
    videoWidth: 0, videoHeight: 0, displayWidth: 0, displayHeight: 0, rotation: null, streamRotation: 0,
    reconciling: false, screenWatch: null, skin: null,
  }) as unknown as TestState

  /** `dumpsys window displays` as the device prints it. */
  const metrics = (nat: string, cur: string, rot: number) =>
    `    init=${nat} 390dpi mMinSizeOfResizeableTaskDp=220 cur=${cur} app=${cur} rng=x\n`
    + `  overrideConfig={winConfig={ mRotation=ROTATION_${rot}} }`

  function agentWith(dump: string) {
    const adb = mockAdb()
    vi.spyOn(adb, 'getDisplayMetrics').mockImplementation(async () =>
      (await import('../displayMetrics')).parseDisplayMetrics(dump))
    return new AndroidAgent({}, adb)
  }

  it('separates the touch space from what the viewer frames', async () => {
    // Pixel 9 Pro Fold unfolded: the panel is portrait, Android draws it landscape.
    const agent = agentWith(metrics('2076x2152', '2152x2076', 270))
    const state = stateFor()  // unfolded

    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')).toBe(true)
    // gRPC input takes natural pixels (measured); the viewer frames what Android draws.
    expect([state.videoWidth, state.videoHeight]).toEqual([2076, 2152])
    expect([state.displayWidth, state.displayHeight]).toEqual([2152, 2076])
    expect(state.rotation).toBe(270)
    // 270 − 270 = 0: Android has already turned the content to meet the skin, so nothing is left.
    expect(state.streamRotation).toBe(0)
  })

  it('follows a fold, where Android rotates back to 0 on a different panel', async () => {
    const agent = agentWith(metrics('1080x2424', '1080x2424', 0))
    const state = stateFor()  // folded

    // The frame still arrives 2424x1080 — the emulator's physical orientation — and must not be
    // what decides this, which is why the frame size is passed only as a fallback.
    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 2424, 1080, 'REVERSE_LANDSCAPE')).toBe(true)
    expect([state.videoWidth, state.videoHeight]).toEqual([1080, 2424])
    expect([state.displayWidth, state.displayHeight]).toEqual([1080, 2424])
    expect(state.rotation).toBe(0)
    // 270 − 0 = 270. The skin stayed put while Android rotated back to 0, so the whole skin
    // offset is left to undo.
    expect(state.streamRotation).toBe(270)
  })

  it('corrects itself on a later pass rather than staying wrong', async () => {
    // The property that makes this sound rather than lucky. No single reading can be trusted — 150ms
    // into an unfold every field in `dumpsys` is self-consistent and describes the posture being
    // left — so the guarantee is not "reads correctly" but "does not stay wrong": a session polls,
    // and a reading taken too early is replaced by the next one.
    const adb = mockAdb()
    const dm = await import('../displayMetrics')
    const early = dm.parseDisplayMetrics(metrics('2076x2152', '2076x2152', 0))
    const settled = dm.parseDisplayMetrics(metrics('2076x2152', '2152x2076', 270))
    const reads = vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(early)
    const agent = new AndroidAgent({}, adb)
    const state = stateFor()

    // A pass that lands entirely inside the lag: every reading agrees, and all of them are early.
    await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')
    expect(state.streamRotation).toBe(270)  // the early reading's answer, a quarter turn out

    // The device finishes rotating; the next pass reports the change so the viewer is told.
    reads.mockResolvedValue(settled)
    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')).toBe(true)
    expect(state.streamRotation).toBe(0)
  })

  it('is not fooled by two readings that agree inside the lag', async () => {
    // The failure this run length exists for. The rotation lags the panel by ~300ms; two samples
    // taken inside that window agree with each other and describe the posture being *left*.
    // Measured across seven folds with a pair as the test: six right, one unfold reading `rot 0`
    // where it should have read 270 — a visible quarter turn, and only on some folds.
    const adb = mockAdb()
    const dm = await import('../displayMetrics')
    const mid = dm.parseDisplayMetrics(metrics('2076x2152', '2076x2152', 0))
    const settled = dm.parseDisplayMetrics(metrics('2076x2152', '2152x2076', 270))
    vi.spyOn(adb, 'getDisplayMetrics')
      .mockResolvedValueOnce(mid)        // inside the lag
      .mockResolvedValueOnce(mid)        // still inside it, and agreeing with itself
      .mockResolvedValue(settled)
    const agent = new AndroidAgent({}, adb)
    const state = stateFor()

    await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')

    // A pair would have stopped at the second reading — rotation 0, correction 270 — and left the
    // picture a quarter turn from where it belongs.
    expect(state.rotation).toBe(270)
    expect(state.streamRotation).toBe(0)
  })

  it('waits for the display to settle rather than reading mid-fold', async () => {
    // Measured on a Pixel 9 Pro Fold: 300ms after unfolding, `init` was already the inner panel
    // while `cur` and `mRotation` still described the cover; both had caught up by 600ms. Reading
    // in that window yields the new size with the old rotation, and the viewer turns the picture by
    // the difference — which is why the error alternated with every other fold.
    const adb = mockAdb()
    const mid = (await import('../displayMetrics')).parseDisplayMetrics(metrics('2076x2152', '2076x2152', 0))
    const settled = (await import('../displayMetrics')).parseDisplayMetrics(metrics('2076x2152', '2152x2076', 270))
    const reads = vi.spyOn(adb, 'getDisplayMetrics')
      .mockResolvedValueOnce(mid)      // panel changed, rotation has not
      .mockResolvedValue(settled)      // caught up, and stays put
    const agent = new AndroidAgent({}, adb)
    const state = stateFor()

    await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')

    // Three reads: the mid-fold one, then two that agree.
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(state.rotation).toBe(270)
    // Settled: 270 − 270 = 0. The mid-fold reading (rot 0) would have given 270.
    expect(state.streamRotation).toBe(0)
  })

  it('follows the skin the emulator reports rather than assuming one', async () => {
    // The skin's orientation comes from the AVD's startup orientation, so it is not a constant. A
    // first version hard-coded 270 — the value this foldable happens to produce — which would have
    // been silently wrong on a device created in portrait, on a machine nobody was testing on.
    const agent = agentWith(metrics('1080x2424', '1080x2424', 0))
    const state = stateFor()

    await internals(agent).reconcileScreen(state, 'emulator-5554', 1080, 2424, 'PORTRAIT')

    // Skin upright, screen upright: nothing to undo, and the frame arrives the same way round.
    expect(state.streamRotation).toBe(0)
  })

  it('undoes the screen\'s turn, because the capture does not follow it', async () => {
    // **The rotation subtracts**, and this sign has been flipped twice, so here is what decides it
    // rather than which way round it reads. The emulator captures the panel in its own fixed
    // physical orientation: the skin. A turn Android applies *inside* that panel therefore arrives
    // already in the frame, and what is left to correct is the part the capture did not follow.
    //
    // Adding was tried on the theory that the picture should turn with the screen. It produced a
    // half-turned picture at rotation 270 in both postures, measured on an app screen.
    const agent = agentWith(metrics('1080x2424', '2424x1080', 90))
    const state = stateFor()
    await internals(agent).reconcileScreen(state, 'emulator-5554', 1080, 2424, 'PORTRAIT')
    expect(state.streamRotation).toBe(270)   // 0 − 90

    const other = stateFor()
    const agent2 = agentWith(metrics('1080x2424', '2424x1080', 270))
    await internals(agent2).reconcileScreen(other, 'emulator-5554', 1080, 2424, 'PORTRAIT')
    expect(other.streamRotation).toBe(90)    // 0 − 270
  })

  it('needs no posture-specific exception — one rule covers every measurement', async () => {
    // The three readings the rule comes from. An earlier version fitted a per-posture offset to
    // these because its baseline was wrong (it took the boot rotation for 270; it is 0), and that
    // offset made folding turn the picture all by itself.
    const folded0 = agentWith(metrics('1080x2424', '1080x2424', 0))
    const a = stateFor()
    await internals(folded0).reconcileScreen(a, 'emulator-5554', 2424, 1080, 'REVERSE_LANDSCAPE')
    expect(a.streamRotation).toBe(270)   // 270 − 0

    const folded270 = agentWith(metrics('1080x2424', '2424x1080', 270))
    const b = stateFor()
    await internals(folded270).reconcileScreen(b, 'emulator-5554', 2424, 1080, 'REVERSE_LANDSCAPE')
    expect(b.streamRotation).toBe(0)     // 270 − 270

    const open0 = agentWith(metrics('2076x2152', '2076x2152', 0))
    const c = stateFor()
    await internals(open0).reconcileScreen(c, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')
    expect(c.streamRotation).toBe(270)   // 270 − 0 — the same as folded at 0, which is the point
  })

  it('does not turn the picture just because the posture changed', async () => {
    // What the offset broke: at a fixed rotation, folding must leave the correction alone.
    const folded = agentWith(metrics('1080x2424', '1080x2424', 0))
    const f = stateFor()
    await internals(folded).reconcileScreen(f, 'emulator-5554', 2424, 1080, 'REVERSE_LANDSCAPE')

    const open = agentWith(metrics('2076x2152', '2076x2152', 0))
    const o = stateFor()
    await internals(open).reconcileScreen(o, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')

    expect(o.streamRotation).toBe(f.streamRotation)
  })

  it('reports no change when nothing moved', async () => {
    const agent = agentWith(metrics('2076x2152', '2152x2076', 270))
    const state = stateFor()
    // Paired with its own mutation: the first call must return true, so the false below is a
    // settled state rather than a call that did nothing.
    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')).toBe(true)
    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 2152, 2076, 'REVERSE_LANDSCAPE')).toBe(false)
  })

  it('treats an unknown skin as no correction rather than a NaN nobody can apply', async () => {
    // The type says the emulator only sends the four it declares; the value comes off the wire,
    // so a newer one would index the table to `undefined` and propagate as `NaN` all the way to
    // the viewer's `rotate(NaNdeg)` — a correction that silently does nothing, with nothing said.
    const agent = agentWith(metrics('1080x2424', '1080x2424', 0))
    const state = stateFor()
    await internals(agent).reconcileScreen(
      state, 'emulator-5554', 1080, 2424, 'TENT' as unknown as SkinRotation)
    expect(state.streamRotation).toBe(0)
  })

  it('falls back to the frame size when the metrics cannot be read', async () => {
    const adb = mockAdb()
    vi.spyOn(adb, 'getDisplayMetrics').mockRejectedValue(new Error('device offline'))
    const agent = new AndroidAgent({}, adb)
    const state = stateFor()

    expect(await internals(agent).reconcileScreen(state, 'emulator-5554', 1080, 2424, 'REVERSE_LANDSCAPE')).toBe(true)
    expect([state.videoWidth, state.videoHeight]).toEqual([1080, 2424])
    expect(state.rotation).toBe(0)
  })
})

// #910: a session starts upright on both platforms, because a fresh viewer does.
describe('standing a device up on boot', () => {
  const upright = async (lock: Awaited<ReturnType<AdbWrapper['getUserRotation']>> | Error) => {
    const adb = mockAdb(true)
    if (lock instanceof Error) vi.spyOn(adb, 'getUserRotation').mockRejectedValue(lock)
    else vi.spyOn(adb, 'getUserRotation').mockResolvedValue(lock)
    const set = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    const outcome = internals(agent).uprightOnBoot('emulator-5554')
    return { outcome, set }
  }

  // Mutation: reset only 1 and 3. Upside down (2) is left by a fold carried across at 180, and on
  // scrcpy it shows the picture inverted.
  it.each([3, 2, 1] as const)('stands a device locked at %i back at 0', async (rotation) => {
    const { outcome, set } = await upright({ mode: 'lock', rotation })
    await outcome
    expect(set).toHaveBeenCalledWith('emulator-5554', 0)
  })

  // The recorded decision in `normaliseOnBoot`: a lock written onto an auto-rotating AVD takes
  // auto-rotate away from it outside tapflow too.
  //
  // Mutation: lock 0 whatever the reading.
  it('leaves an auto-rotating device, and one already upright, alone', async () => {
    for (const lock of [{ mode: 'free' } as const, { mode: 'lock', rotation: 0 } as const]) {
      const { outcome, set } = await upright(lock)
      await outcome
      expect(set).not.toHaveBeenCalled()
    }
  })

  it('writes nothing when the lock cannot be read', async () => {
    const { outcome, set } = await upright(new Error('Cannot read the rotation lock'))
    await expect(outcome).rejects.toThrow(/rotation lock/)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('what a rotation does on each backend', () => {
  const stateOn = (backend: 'grpc' | 'scrcpy') => ({
    deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', landscape: false, booted: true,
    videoWidth: 1080, videoHeight: 2400, displayWidth: 1080, displayHeight: 2400,
    rotation: null, streamRotation: 0, skin: null, reconciling: false, screenWatch: null,
    grpcClient: backend === 'grpc' ? {} : null,
    scrcpySession: backend === 'scrcpy' ? { control: {} } : null,
  }) as unknown as TestState

  const rotate = async (backend: 'grpc' | 'scrcpy') => {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const metrics = vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue({
      natural: { width: 1080, height: 2400 },
      current: { width: 2400, height: 1080 },
      rotation: 270,
    })
    const agent = new AndroidAgent({}, adb)
    const state = stateOn(backend)
    internals(agent).deviceStates.set('s1', state)
    internals(agent).handleRelayMessage({ type: 'input:rotate', sessionId: 's1' })
    // The body turn and display reconciliation run asynchronously; wait for the actual state
    // change rather than assuming a fixed delay covers both on every host.
    if (backend === 'grpc') await vi.waitFor(() => expect(state.rotation).toBe(270))
    else await vi.waitFor(() => expect(state.landscape).toBe(true))
    return { metrics, state }
  }

  // Settling the display after a rotation samples it until it holds still — up to 3.6s. That ran in
  // the background before rotations were queued (#910), and has to stay there: inside the queue it
  // held every later rotation, and the boot waiting to stand the device up, for that long.
  //
  // Mutation: await the re-read inside the queued step.
  it('does not hold the next rotation while the screen is re-read', async () => {
    const adb = mockAdb(true)
    const agent = new AndroidAgent({}, adb)
    vi.spyOn(agent as unknown as { reconcileSerial(): Promise<boolean> }, 'reconcileSerial')
      .mockReturnValue(new Promise<boolean>(() => {}))
    internals(agent).deviceStates.set('s1', stateOn('grpc'))
    internals(agent).handleRelayMessage({ type: 'input:rotate', sessionId: 's1', payload: { orientation: 'landscape' } })
    internals(agent).handleRelayMessage({ type: 'input:rotate', sessionId: 's1', payload: { orientation: 'portrait' } })
    // On gRPC the body turns: a quarter to landscape, then three more round to upright.
    await vi.waitFor(() => expect(adb.rotateBodyClockwise).toHaveBeenCalledTimes(4))
    expect((adb as unknown as { body: { at: number } }).body.at).toBe(0)
  })

  it('does not re-describe the screen on scrcpy, which would blank the viewer', async () => {
    // **The regression this guard exists for.** scrcpy captures with `capture_orientation=@0`, so
    // its frame never changes shape. Reporting the rotated `cur=` as the screen makes the viewer
    // see landscape content, switch its CSS quarter off — the only thing that rotates this
    // backend — and then find the frame no longer matches the screen it was told about. The
    // picture goes blank with no way back but pressing rotate again.
    const { metrics, state } = await rotate('scrcpy')
    expect(metrics).not.toHaveBeenCalled()
    // And `toDevicePx` says this backend must never carry a rotation: its frames are natural
    // already, so applying one double-maps every tap.
    expect(state.rotation).toBeNull()
    expect(state.displayWidth).toBe(1080)
  })

  it('does re-describe it on gRPC, which is what makes the button feel immediate', async () => {
    // The pair that stops the test above passing because nothing ran.
    const { metrics, state } = await rotate('grpc')
    expect(metrics).toHaveBeenCalled()
    expect(state.rotation).toBe(270)
    expect(state.displayWidth).toBe(2400)
  })
})

describe('clearGrpcState — every teardown that can come back on scrcpy', () => {
  const grpcLeftovers = () => ({
    deviceId: 'avd:Pixel_8_API_34', screenWatch: null, scrcpySession: null,
    emulatorVideo: null, emulatorAudio: null, grpcClient: null, touchHelper: null,
    streamWs: null, booted: true, restarting: true,
    cornerRadiusPx: 115, rotation: 270, streamRotation: 180,
    skin: 'REVERSE_LANDSCAPE', touchRange: { width: 2076, height: 2152 },
  }) as unknown as TestState
  const cleared = (state: TestState) => {
    expect(state.rotation).toBeNull()
    expect(state.skin).toBeNull()
    expect(state.touchRange).toBeNull()
    expect(state.streamRotation).toBe(0)
    expect(state.cornerRadiusPx).toBe(0)
  }

  it('clears them on the auto-restart, which is a whole separate path', async () => {
    // The teardown a dying stream takes. It reaches `startVideoStream` again, which may pick
    // scrcpy — and a first version of this fix only covered session cleanup, so this path kept
    // handing the emulator's map to the backend that must not have it.
    const agent = new AndroidAgent({}, mockAdb(true))
    const state = grpcLeftovers()
    // No open stream socket, so the teardown runs and the restart stops right after it.
    await internals(agent).restartVideoStream(state)
    cleared(state)
  })

  it('leaves nothing behind for a scrcpy fallback to inherit', () => {
    // A stream that dies and comes back on scrcpy — an emulator booted externally, a moved port —
    // otherwise keeps the emulator's coordinate map: a non-null `rotation` double-maps every tap,
    // a stale `skin` computes a correction for a capture that does not turn, and `touchRange`
    // divides by a grid this backend does not inject into.
    const agent = new AndroidAgent({}, mockAdb(true))
    const state = grpcLeftovers()

    internals(agent).cleanupDeviceState(state)

    cleared(state)
  })
})

describe('a posture change reports as soon as the guest commits', () => {
  const STATES = `DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}`
  const committed = (name: string) => `Committed state: DeviceState{identifier=1, name='${name}'}`

  /** Drives `input:posture` and records the order of everything the agent did. */
  function fold(opts: { commitsAfter: number; postureFails?: boolean }) {
    const adb = mockAdb(true)
    const order: string[] = []
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(STATES)
    let reads = 0
    vi.spyOn(adb, 'deviceState').mockImplementation(async () => {
      order.push('deviceState')
      return committed(reads++ < opts.commitsAfter ? 'CLOSED' : 'HALF_OPENED')
    })
    vi.spyOn(adb, 'setPosture').mockImplementation(async () => {
      order.push('setPosture')
      if (opts.postureFails) throw new Error('KO: unknown command')
    })
    vi.spyOn(adb, 'getDisplayMetrics').mockImplementation(async () => {
      order.push('getDisplayMetrics')
      return { natural: { width: 1080, height: 2424 }, current: { width: 1080, height: 2424 }, rotation: 0 as const }
    })
    vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    ;(agent as unknown as { ws: { readyState: number; send(d: string): void } }).ws = {
      readyState: 1,
      send: (d: string) => { if ((JSON.parse(d) as { type: string }).type === 'device:postures') order.push('device:postures') },
    }
    // On scrcpy: the rotation carry these tests time runs only there.
    const state = { deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true, scrcpySession: {} } as unknown as TestState
    internals(agent).deviceStates.set('s1', state)
    internals(agent).handleRelayMessage({ type: 'input:posture', sessionId: 's1', payload: { postureId: '2' } })
    return order
  }

  const settle = async () => { await new Promise((r) => setTimeout(r, 400)) }

  it('does not make the viewer wait for the rotation carry\'s settling read', async () => {
    // **The ~380ms this split removes.** The report used to be chained to the whole operation,
    // including a settling read whose answer only the rotation carry consumes — measured on a
    // Pixel 9 Pro Fold as the screen's description landing at ~740ms and the posture report at
    // ~1100ms. The carry still happens; it just stopped being something the viewer waits on.
    const order = await (async () => { const o = fold({ commitsAfter: 1 }); await settle(); return o })()
    const reported = order.indexOf('device:postures')
    expect(reported).toBeGreaterThan(-1)
    // One `getDisplayMetrics` precedes it — the pre-change rotation the carry will restore. The
    // settling run is several more, and all of them must come after.
    expect(order.slice(0, reported).filter((o) => o === 'getDisplayMetrics')).toHaveLength(1)
    expect(order.slice(reported).filter((o) => o === 'getDisplayMetrics').length).toBeGreaterThanOrEqual(2)
  })

  it('waits for the guest to commit before reporting, not just for the console', async () => {
    // `adb emu posture` returns as soon as the emulator takes it; the guest follows a moment
    // later. Reporting in between names the posture being left, and the viewer's control is
    // released by the report *matching what was asked for* — so it would hang on its 8s stop.
    const order = await (async () => { const o = fold({ commitsAfter: 2 }); await settle(); return o })()
    const reported = order.indexOf('device:postures')
    expect(order.slice(0, reported).filter((o) => o === 'deviceState').length).toBeGreaterThanOrEqual(3)
  })

  it('still reports when the device refuses the change', async () => {
    // A posture that could not be written ends with an honest report rather than with the
    // control sitting on its long stop.
    const order = await (async () => { const o = fold({ commitsAfter: 0, postureFails: true }); await settle(); return o })()
    expect(order).toContain('device:postures')
  })
})

describe('a fold takes down the keyguard it put up', () => {
  const STATES = `DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}`

  /**
   * Drives `input:posture` to `target` ('1' folds, '2' unfolds) with the keyguard reads answering `reads` in turn
   * (the last repeating), and records the order of what the agent did.
   */
  function change(target: '1' | '2', reads: Array<{ showing: boolean; secure: boolean } | null>) {
    const adb = mockAdb(true)
    const order: string[] = []
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(STATES)
    vi.spyOn(adb, 'deviceState').mockResolvedValue(`Committed state: DeviceState{identifier=0, name='${target === '1' ? 'CLOSED' : 'HALF_OPENED'}'}`)
    vi.spyOn(adb, 'setPosture').mockImplementation(async () => { order.push('setPosture') })
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(null)
    let n = 0
    vi.spyOn(adb, 'keyguardState').mockImplementation(async () => { order.push('keyguardState'); return reads[Math.min(n++, reads.length - 1)]! })
    const dismiss = vi.spyOn(adb, 'dismissKeyguard').mockImplementation(async () => { order.push('dismissKeyguard') })
    const agent = new AndroidAgent({}, adb)
    ;(agent as unknown as { ws: { readyState: number; send(d: string): void } }).ws = {
      readyState: 1,
      send: (d: string) => { if ((JSON.parse(d) as { type: string }).type === 'device:postures') order.push('device:postures') },
    }
    const state = { deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true } as unknown as TestState
    internals(agent).deviceStates.set('s1', state)
    internals(agent).handleRelayMessage({ type: 'input:posture', sessionId: 's1', payload: { postureId: target } })
    return { order, dismiss }
  }

  const settle = () => new Promise((r) => setTimeout(r, 400))
  const up = { showing: true, secure: false }
  const down = { showing: false, secure: false }

  // Before the report, because the report is what a flow's `setPosture` waits for: its next step must find the app.
  it('dismisses the keyguard a fold put up before reporting the posture, and reads it back', async () => {
    const { order, dismiss } = change('1', [down, up, down])
    await settle()
    expect(dismiss).toHaveBeenCalledTimes(1)
    const reported = order.indexOf('device:postures')
    expect(order.indexOf('dismissKeyguard')).toBeLessThan(reported)
    expect(order.slice(order.indexOf('dismissKeyguard'), reported)).toContain('keyguardState')
  })

  // Measured: the keyguard can still be on its way at the read that sees the commit.
  it('waits a moment on a fold for the keyguard to come up', async () => {
    const { dismiss } = change('1', [down, down, down, up, down])
    await settle()
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('leaves a keyguard that was already up before the change', async () => {
    const { dismiss } = change('1', [up])
    await settle()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('leaves a secure keyguard for its credential', async () => {
    const { dismiss } = change('1', [down, { showing: true, secure: true }])
    await settle()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('leaves the keyguard alone when it cannot be read', async () => {
    const { dismiss } = change('1', [null, up])
    await settle()
    expect(dismiss).not.toHaveBeenCalled()
  })

  // Unfolding does not put one up, so it pays one read and no wait.
  it('reads once after an unfold and does not wait', async () => {
    const { order, dismiss } = change('2', [down])
    await settle()
    expect(dismiss).not.toHaveBeenCalled()
    expect(order.filter((o) => o === 'keyguardState')).toHaveLength(2)
  })
})

describe('what the delta review found', () => {
  const metrics = (rot: 0 | 90 | 180 | 270 = 0) => ({
    natural: { width: 1080, height: 2424 },
    current: rot === 0 ? { width: 1080, height: 2424 } : { width: 2424, height: 1080 },
    rotation: rot,
  })

  it('stops the screen watch with the stream that started it', () => {
    // The watcher writes `rotation`/`skin`/`streamRotation` and is started only by the gRPC
    // stream. Left running while those are cleared, its next tick puts them straight back — and
    // a restart that lands on scrcpy never starts a new one, so the stale interval outlives the
    // backend it belonged to and keeps a dead stream's skin alive for the session.
    const agent = new AndroidAgent({}, mockAdb(true))
    const timer = setInterval(() => {}, 60_000)
    const state = { deviceId: 'avd:Pixel_8_API_34', screenWatch: timer, grpcClient: null } as unknown as TestState
    ;(agent as unknown as { clearGrpcState(s: TestState): void }).clearGrpcState(state)
    expect(state.screenWatch).toBeNull()
    clearInterval(timer)
  })

  it('does not unfold the device when a dead stream restarts', async () => {
    // `startGrpcVideoStream` is reached by the auto-restart as well as by a boot — and there the
    // tester is mid-test. A hiccup in the pump is not a reason to throw away the posture and rotation
    // they were working in. Decided by the caller since #587 rather than by a flag on the state,
    // which a new boot arriving during an old restart read as its own.
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(
      `DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}`)
    vi.spyOn(adb, 'deviceState').mockResolvedValue(`Committed state: DeviceState{identifier=0, name='CLOSED'}`)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(0))
    const setPosture = vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
    const setRotation = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    const state = {
      deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', landscape: true, booted: true,
      reconciling: false, screenWatch: null,
    } as unknown as TestState
    const start = (restart: boolean) => (agent as unknown as {
      startGrpcVideoStream(s: TestState, ws: unknown, serial: string, owns: () => boolean, o: { restart: boolean }): Promise<void>
    }).startGrpcVideoStream(state, { readyState: 1, send: () => {} }, 'emulator-5554', () => true, { restart })

    try {
      await start(true)
      expect(setPosture).not.toHaveBeenCalled()
      expect(setRotation).not.toHaveBeenCalled()
      // The twin: the same call as a boot does normalise, so the restart case is not passing by accident.
      await start(false)
      expect(setPosture).toHaveBeenCalled()
    } finally {
      if (state.screenWatch) clearInterval(state.screenWatch)
    }
  })

  // On gRPC the viewer draws the body, which a fold does not move, and Android picks the new panel's rotation
  // from the sensor; a lock carried across is what kept apps from following the body. Mutation: carry it anyway.
  it('carries no rotation lock across a fold on gRPC', async () => {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(270))
    const setRotation = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    const state = {
      deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true, grpcClient: {},
      videoWidth: 1080, videoHeight: 2424, displayWidth: 1080, displayHeight: 2424,
      rotation: 0, streamRotation: 0, skin: 'PORTRAIT', cornerRadiusPx: 0,
    } as unknown as TestState

    await internals(agent).finishPosture(state, 'emulator-5554', 0)

    expect(setRotation).not.toHaveBeenCalled()
  })

  it('says nothing when there is no viewer to say it to', async () => {
    // The capability entry point takes a device, not a session, so it passes no state — and the
    // pair with the test above is what stops that being an accident.
    const adb = mockAdb(true)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(270))
    vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    await expect(internals(agent).finishPosture(null, 'emulator-5554', 0)).resolves.toBeUndefined()
  })

  it('ignores a second posture request while one is in flight', async () => {
    // The report now goes out before the carry finishes, which puts the control back within
    // reach while the first change is still settling. A second press would read its `before`
    // from a panel mid-swap, and the two carries would land in arbitrary order.
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(
      `DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}`)
    vi.spyOn(adb, 'deviceState').mockResolvedValue(`Committed state: DeviceState{identifier=1, name='HALF_OPENED'}`)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(0))
    const setPosture = vi.spyOn(adb, 'setPosture').mockImplementation(
      () => new Promise((r) => setTimeout(r, 120)))
    const agent = new AndroidAgent({}, adb)
    const state = { deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true, posturing: false } as unknown as TestState
    internals(agent).deviceStates.set('s1', state)

    internals(agent).handleRelayMessage({ type: 'input:posture', sessionId: 's1', payload: { postureId: '2' } })
    internals(agent).handleRelayMessage({ type: 'input:posture', sessionId: 's1', payload: { postureId: '1' } })
    await new Promise((r) => setTimeout(r, 400))

    expect(setPosture).toHaveBeenCalledTimes(1)
    // And the flag is released, so the next real press is not swallowed too.
    expect(state.posturing).toBe(false)
  })

  it('waits for a fresh pass rather than dropping a change that arrived mid-reconcile', async () => {
    // `EmulatorVideo` reports each change once and records it, so a callback dropped while a
    // reconcile was running was the only notice there would ever be — and a skin-only change
    // moves none of the fields the watcher's cheap read compares, so nothing picked it up. It is
    // coalesced onto a trailing pass now, which is why the field that remembered drops is gone.
    grpcVideoOptions = null
    const adb = mockAdb(true)
    vi.spyOn(adb, 'getScreenSize').mockResolvedValue({ width: 1080, height: 2400 })
    const reads = vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(0))
    const pinned = process.env.TAPFLOW_ANDROID_BACKEND
    process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
    const agent = new AndroidAgent({}, adb)
    const state = {
      deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true,
      reconciling: false, screenWatch: null,
    } as unknown as TestState
    try {
      await (agent as unknown as {
        startGrpcVideoStream(s: TestState, ws: unknown, serial: string): Promise<void>
      }).startGrpcVideoStream(state, { readyState: 1, send: () => {} }, 'emulator-5554')
      if (state.screenWatch) clearInterval(state.screenWatch)
      const opts = grpcVideoOptions as GrpcVideoOptions | null
      expect(opts?.onSizeChange).toBeTypeOf('function')
      reads.mockClear()
      // One already running, one arriving behind it. Dropped, the second read never happens.
      const first = (agent as unknown as {
        reconcileSerial(s: TestState, serial: string, w: number, h: number, skin: string): Promise<boolean>
      }).reconcileSerial(state, 'emulator-5554', 1080, 2400, 'PORTRAIT')
      opts!.onSizeChange!(2152, 2076, 'REVERSE_LANDSCAPE', 0)
      await first
      await new Promise((r) => setTimeout(r, 200))
      // Two passes, not one: the trailing pass re-reads rather than reusing the first's answer.
      expect(reads.mock.calls.length).toBeGreaterThan(3)
    } finally {
      if (pinned === undefined) delete process.env.TAPFLOW_ANDROID_BACKEND
      else process.env.TAPFLOW_ANDROID_BACKEND = pinned
    }
  })

  it('coalesces a third request onto the pass a second one already scheduled', async () => {
    // Three questions while one runs are one question. Queueing them instead would cost a
    // settling pass each — seconds — for a value that did not change between them.
    const adb = mockAdb(true)
    const reads = vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(metrics(0))
    const agent = new AndroidAgent({}, adb) as unknown as {
      reconcileSerial(s: TestState, serial: string, w: number, h: number, skin: string): Promise<boolean>
    }
    const state = {
      deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true, reconciling: false,
      videoWidth: 1080, videoHeight: 2424, displayWidth: 1080, displayHeight: 2424,
      rotation: 0, streamRotation: 0, skin: 'PORTRAIT', cornerRadiusPx: 0,
    } as unknown as TestState
    const running = agent.reconcileSerial(state, 'emulator-5554', 1080, 2424, 'PORTRAIT')
    const second = agent.reconcileSerial(state, 'emulator-5554', 1080, 2424, 'PORTRAIT')
    const third = agent.reconcileSerial(state, 'emulator-5554', 1080, 2424, 'PORTRAIT')
    expect(second).toBe(third)
    expect(second).not.toBe(running)
    await Promise.all([running, second, third])
    // Two passes for three requests: the running one, and the single trailing one they share.
    expect(reads.mock.calls.length).toBeLessThan(9)
  })
})

describe('the screen watch is cheap while nothing moves', () => {
  const settled = { natural: { width: 1080, height: 2424 }, current: { width: 1080, height: 2424 }, rotation: 0 as const }
  const watching = (metricsImpl: () => Promise<typeof settled>) => {
    const adb = mockAdb(true)
    const metrics = vi.spyOn(adb, 'getDisplayMetrics').mockImplementation(metricsImpl)
    const agent = new AndroidAgent({}, adb)
    const state = {
      deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', booted: true, reconciling: false,
      screenWatch: null, skin: 'PORTRAIT',
      videoWidth: 1080, videoHeight: 2424, displayWidth: 1080, displayHeight: 2424, rotation: 0,
      streamRotation: 0, cornerRadiusPx: 0,
    } as unknown as TestState
    internals(agent).watchScreen(state, 'emulator-5554', 'PORTRAIT')
    return { metrics, state }
  }

  afterEach(() => { vi.useRealTimers() })

  it('reads once per tick on a device that has not changed', async () => {
    // **The waste this replaced.** The tick used to run the settling pass unconditionally, which
    // samples until three readings agree — measured at ~700ms of waiting, every two seconds, for
    // the life of the session, on a display nobody had touched. The read itself is 20ms.
    vi.useFakeTimers()
    const { metrics, state } = watching(async () => settled)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(metrics).toHaveBeenCalledTimes(1)
    // And the tick released its guard, so the next one is not skipped.
    expect(state.reconciling).toBe(false)
  })

  it('still settles when the display did move, which is the whole point of the poll', async () => {
    // A single reading taken mid-fold describes the posture being left, so a change has to be
    // confirmed rather than believed. Paired with the test above so "reads once" cannot pass by
    // the watch doing nothing at all.
    vi.useFakeTimers()
    const folded = { natural: { width: 2076, height: 2152 }, current: { width: 2076, height: 2152 }, rotation: 0 as const }
    const { metrics } = watching(async () => folded)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(metrics.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('the corner radius on the wire', () => {
  // The bug three screenshots showed: portrait right, landscape 2.24x too round, and the landscape
  // *lock screen* right again — because a lock screen refuses to rotate, so `shown` stayed
  // portrait there. One panel, one physical corner, three different answers.
  const chromeRadius = (agent: AndroidAgent, state: TestState) => {
    const sent: Record<string, unknown>[] = []
    ;(agent as unknown as { ws: { readyState: number; send(d: string): void } | null }).ws = {
      readyState: 1,
      send: (d: string) => sent.push(JSON.parse(d) as Record<string, unknown>),
    }
    ;(agent as unknown as { sendChrome(s: TestState): void }).sendChrome(state)
    const chrome = sent.find((m) => m['type'] === 'session:chrome')
    return (chrome?.['payload'] as Record<string, unknown> | undefined)?.['cornerRadius']
  }
  const folded = (displayWidth: number, displayHeight: number) => ({
    sessionId: 's1', cornerRadiusPx: 115, displayWidth, displayHeight,
    streamRotation: 0, videoWidth: 1080, videoHeight: 2424,
  }) as unknown as TestState

  it('is a fraction of the width the viewer lays out, so it survives a rotation', () => {
    const agent = new AndroidAgent({}, mockAdb())
    // The cover panel's 115px, portrait and then turned. The same physical curve both times.
    expect(chromeRadius(agent, folded(1080, 2424))).toBeCloseTo(115 / 1080, 10)
    expect(chromeRadius(agent, folded(2424, 1080))).toBeCloseTo(115 / 2424, 10)
  })

  it('scales to the same pixels on screen in both orientations', () => {
    const agent = new AndroidAgent({}, mockAdb())
    // What the viewer computes: `cornerRadius * androidDisplayW`, where that width is the shown
    // width times a layout scale. Equal here means equal on screen, which is the whole property.
    const portrait = (chromeRadius(agent, folded(1080, 2424)) as number) * 1080
    const landscape = (chromeRadius(agent, folded(2424, 1080)) as number) * 2424
    expect(portrait).toBeCloseTo(landscape, 10)
  })

  it('answers 0 rather than dividing by a width it does not have yet', () => {
    const agent = new AndroidAgent({}, mockAdb())
    expect(chromeRadius(agent, folded(0, 0))).toBe(0)
  })
})

describe('normaliseOnBoot', () => {
  const states = (name: string) =>
    `DeviceState{identifier=0, name='CLOSED', app_requestable=true}\n`
    + `DeviceState{identifier=1, name='HALF_OPENED', app_requestable=true}\n`
    + `Committed state: DeviceState{identifier=1, name='${name}', app_requestable=true}`

  /** A device that reports both postures and is sitting in `name`. */
  function agentIn(name: string) {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(states(name))
    vi.spyOn(adb, 'deviceState').mockResolvedValue(`Committed state: DeviceState{identifier=1, name='${name}'}`)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue({
      natural: { width: 1080, height: 2424 }, current: { width: 1080, height: 2424 }, rotation: 0,
    })
    return { adb, agent: new AndroidAgent({}, adb) }
  }

  it('unfolds a device the last session left folded', async () => {
    const { adb, agent } = agentIn('CLOSED')
    const setPosture = vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: true } as unknown as TestState

    await internals(agent).normaliseOnBoot(state, 'emulator-5554')

    // '2' is the emulator id for HALF_OPENED, which is the posture labelled Unfolded.
    expect(setPosture).toHaveBeenCalledWith('emulator-5554', '2')
  })

  it('leaves an already unfolded device alone', async () => {
    const { adb, agent } = agentIn('HALF_OPENED')
    const setPosture = vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: false } as unknown as TestState

    await internals(agent).normaliseOnBoot(state, 'emulator-5554')

    // Not merely tidy: the unfold is followed by a settling read of ~300ms per sample, and paying
    // it on every boot is what once left the viewer on "Waiting for stream…".
    expect(setPosture).not.toHaveBeenCalled()
  })

  // The lock this used to write is what kept apps from following the body; standing up is the body step's
  // now (`prepareBody`). Mutation: write the lock again.
  it('writes no rotation lock on a foldable\'s boot', async () => {
    const { adb, agent } = agentIn('HALF_OPENED')
    const setRotation = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: true } as unknown as TestState

    await internals(agent).normaliseOnBoot(state, 'emulator-5554')

    expect(setRotation).not.toHaveBeenCalled()
  })

  it('settles between the two writes, because a lock written mid-swap is discarded', async () => {
    const { adb, agent } = agentIn('CLOSED')
    const order: string[] = []
    vi.spyOn(adb, 'setPosture').mockImplementation(async () => { order.push('posture') })
    vi.spyOn(adb, 'getDisplayMetrics').mockImplementation(async () => {
      order.push('read')
      return { natural: { width: 1080, height: 2424 }, current: { width: 1080, height: 2424 }, rotation: 0 }
    })
    vi.spyOn(adb, 'setRotation').mockImplementation(async () => { order.push('rotation') })
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: false } as unknown as TestState

    await internals(agent).normaliseOnBoot(state, 'emulator-5554')

    // The panels swap during a posture change and the incoming one brings its own rotation, so a
    // lock written before the swap finishes is overwritten — `setPosture` carries the same note.
    const posture = order.indexOf('posture')
    const rotation = order.indexOf('rotation')
    expect(posture).toBeGreaterThanOrEqual(0)
    expect(order.slice(posture, rotation).filter((o) => o === 'read').length).toBeGreaterThanOrEqual(2)
  })

  it('leaves a device that does not fold exactly as it found it', async () => {
    // **The rotation write is for foldables only.** Standing the device upright exists so a
    // posture change starts from a state both sides can name; a phone has no posture to change.
    // And `wm user-rotation lock` is persistent device state that nothing here frees, so writing
    // it on every emulator would leave a plain AVD unable to auto-rotate — in this session, in
    // later ones, and outside tapflow.
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockRejectedValue(new Error('unknown command'))
    vi.spyOn(adb, 'deviceState').mockRejectedValue(new Error('unknown command'))
    const setRotation = vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    const setPosture = vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
    const agent = new AndroidAgent({}, adb)
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: true } as unknown as TestState

    await internals(agent).normaliseOnBoot(state, 'emulator-5554')

    expect(setRotation).not.toHaveBeenCalled()
    expect(setPosture).not.toHaveBeenCalled()
    // Paired with the foldable case above, which asserts both writes DO happen — so this is a
    // decision about postures, not a test that passes because nothing ran.
    expect(state.landscape).toBe(true)
  })

  it('does not fail the boot when the device refuses either write', async () => {
    const { adb, agent } = agentIn('CLOSED')
    vi.spyOn(adb, 'setPosture').mockRejectedValue(new Error('KO: unknown command'))
    vi.spyOn(adb, 'setRotation').mockRejectedValue(new Error('device offline'))
    const state = { deviceId: 'avd:Pixel_8_API_34', landscape: true } as unknown as TestState

    // A device tapflow cannot steer is still a device somebody is waiting to look at.
    await expect(internals(agent).normaliseOnBoot(state, 'emulator-5554')).resolves.toBeUndefined()
  })
})

// The map that was missing, and the reason a tap landed 90° from the finger.
describe('toNaturalPoint', () => {
  it('is the identity at rotation 0 — why an ordinary phone never needed it', () => {
    expect(toNaturalPoint(0, 0.25, 0.75)).toEqual({ x: 0.25, y: 0.75 })
  })

  it('maps 270, the unfolded foldable', () => {
    expect(toNaturalPoint(270, 0, 0)).toEqual({ x: 0, y: 1 })
    expect(toNaturalPoint(270, 0.25, 0.75)).toEqual({ x: 0.75, y: 0.75 })
  })

  it('maps 90 as the mirror of 270', () => {
    expect(toNaturalPoint(90, 0, 0)).toEqual({ x: 1, y: 0 })
    expect(toNaturalPoint(90, 0.25, 0.75)).toEqual({ x: 0.25, y: 0.25 })
  })

  it('maps 180 as a half turn', () => {
    expect(toNaturalPoint(180, 0.25, 0.75)).toEqual({ x: 0.75, y: 0.25 })
  })

  it('round-trips through four quarter turns back to itself', () => {
    let p = { x: 0.3, y: 0.8 }
    for (let i = 0; i < 4; i++) p = toNaturalPoint(90, p.x, p.y)
    expect(p.x).toBeCloseTo(0.3)
    expect(p.y).toBeCloseTo(0.8)
  })
})

// `toNaturalPoint` being correct proves nothing about the input path using it. Measured twice on
// this branch: deleting the call left every test green.
describe('toDevicePx (the input wiring)', () => {
  const stateFor = (rotation: 0 | 90 | 180 | 270 | null) => ({
    videoWidth: 2076, videoHeight: 2152, rotation,
  }) as unknown as TestState

  it('maps through the display rotation', () => {
    const agent = new AndroidAgent({}, mockAdb())
    expect(internals(agent).toDevicePx(stateFor(270), 0, 0)).toEqual({ px: 0, py: 2152 })
  })

  it('is a plain scale at rotation 0, and on the scrcpy backend where it is null', () => {
    const agent = new AndroidAgent({}, mockAdb())
    const plain = { px: Math.round(0.25 * 2076), py: Math.round(0.75 * 2152) }
    expect(internals(agent).toDevicePx(stateFor(0), 0.25, 0.75)).toEqual(plain)
    expect(internals(agent).toDevicePx(stateFor(null), 0.25, 0.75)).toEqual(plain)
  })

  it('differs from the unrotated scale — the pair that makes the test above mean something', () => {
    const agent = new AndroidAgent({}, mockAdb())
    expect(internals(agent).toDevicePx(stateFor(270), 0.25, 0.75))
      .not.toEqual(internals(agent).toDevicePx(stateFor(null), 0.25, 0.75))
  })

  // The folded Pixel 9 Pro Fold. The panel is 1080x2424 and the emulator still has display 0 at
  // 2076x2152 — the unfolded size, which is also `hw.lcd`. Both axes disagree, and the reason the
  // bug hid for so long is that unfolded they agree exactly.
  const folded = (over: Partial<Record<string, unknown>> = {}) => ({
    videoWidth: 1080, videoHeight: 2424, rotation: 270,
    touchRange: { width: 2076, height: 2152 }, grpcClient: {}, ...over,
  }) as unknown as TestState

  it('scales by the emulator\'s display, not the guest\'s panel, on the gRPC backend', () => {
    const agent = new AndroidAgent({}, mockAdb())
    // The measured tap: viewer 0.3785,0.7113 → natural 0.7113,0.6215. Divided by the panel that
    // is px 768,1507, and a tap on Camera opened the app one row above it.
    expect(internals(agent).toDevicePx(folded(), 0.3785, 0.7113))
      .toEqual({ px: Math.round(0.7113 * 2076), py: Math.round(0.6215 * 2152) })
  })

  it('keeps the panel size for scrcpy, which injects into the frame instead', () => {
    const agent = new AndroidAgent({}, mockAdb())
    // Same state, no gRPC client. scrcpy's control channel takes the frame's own pixels, so
    // applying the emulator's display size there would break the backend that works.
    expect(internals(agent).toDevicePx(folded({ grpcClient: null }), 0.3785, 0.7113))
      .toEqual({ px: Math.round(0.7113 * 1080), py: Math.round(0.6215 * 2424) })
  })

  it('falls back to the panel when the emulator would not say', () => {
    const agent = new AndroidAgent({}, mockAdb())
    // A device that does not answer is still a device somebody is tapping on, and the panel size
    // is what this did before — wrong on a folded foldable, right everywhere else.
    expect(internals(agent).toDevicePx(folded({ touchRange: null }), 0.3785, 0.7113))
      .toEqual({ px: Math.round(0.7113 * 1080), py: Math.round(0.6215 * 2424) })
  })

  it('is the identity when the two agree, which is every phone and every unfolded foldable', () => {
    const agent = new AndroidAgent({}, mockAdb())
    const same = {
      videoWidth: 2076, videoHeight: 2152, rotation: 0,
      touchRange: { width: 2076, height: 2152 }, grpcClient: {},
    } as unknown as TestState
    const panel = { ...same, touchRange: null } as unknown as TestState
    expect(internals(agent).toDevicePx(same, 0.25, 0.75))
      .toEqual(internals(agent).toDevicePx(panel, 0.25, 0.75))
  })
})

describe('PosturableAgent (the wiring)', () => {
  const STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true},
  DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true},
  DeviceState{identifier=2, name='OPENED', app_accessible=true},
]`

  function posturableAdb(current = 'OPENED') {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue(STATES)
    vi.spyOn(adb, 'deviceState').mockResolvedValue(
      `Committed state: DeviceState{identifier=0, name='${current}'}`)
    vi.spyOn(adb, 'setPosture').mockResolvedValue(undefined)
    vi.spyOn(adb, 'setRotation').mockResolvedValue(undefined)
    return adb
  }

  it('lists the device\'s postures in contract order', async () => {
    const agent = new AndroidAgent({}, posturableAdb())
    expect((await agent.listPostures('avd:Pixel_8_API_34')).map((p) => p.label))
      .toEqual(['Folded', 'Unfolded'])
  })

  it('reports the posture the device is actually in', async () => {
    const agent = new AndroidAgent({}, posturableAdb('CLOSED'))
    expect(await agent.getPosture('avd:Pixel_8_API_34')).toEqual({ id: '1', label: 'Folded' })
    const open = new AndroidAgent({}, posturableAdb('HALF_OPENED'))
    expect(await open.getPosture('avd:Pixel_8_API_34')).toEqual({ id: '2', label: 'Unfolded' })
  })

  it('carries the orientation across the change', async () => {
    // Each panel remembers its own rotation, so folding a device held sideways and unfolding it
    // used to hand back the inner panel's last rotation rather than the one on screen.
    const adb = posturableAdb()
    const dm = await import('../displayMetrics')
    const before = dm.parseDisplayMetrics(
      '    init=2076x2152 cur=2152x2076\n mRotation=ROTATION_270')
    const after = dm.parseDisplayMetrics(
      '    init=1080x2424 cur=1080x2424\n mRotation=ROTATION_0')
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValueOnce(before).mockResolvedValue(after)
    const agent = new AndroidAgent({}, adb)
    // On scrcpy, where the viewer's toggle is the rotation — the only backend this carry is for.
    internals(agent).deviceStates.set('s1', { deviceId: 'avd:Pixel_8_API_34', booted: true, grpcClient: null, scrcpySession: {} } as unknown as TestState)

    await agent.setPosture('avd:Pixel_8_API_34', '1')

    // 270° before, 0° after — so the rotation is put back, as quarter turns (3 = 270).
    expect(adb.setRotation).toHaveBeenCalledWith('emulator-5554', 3)
  })

  // A body-drawn emulator must never get a lock: it is what kept apps from following the body. `setPosture` takes a
  // device, not a session, so it has to find the device's state to see gRPC — and an emulator with no session is
  // drawn by its body when it next streams; a restarting gRPC stream has no client for a moment. Mutations: pass no
  // state; carry when no session says otherwise; ask "is it gRPC" instead of "is it scrcpy".
  it.each([
    ['a gRPC session', { deviceId: 'avd:Pixel_8_API_34', booted: true, grpcClient: {} }],
    ['a gRPC stream restarting', { deviceId: 'avd:Pixel_8_API_34', booted: true, grpcClient: null, scrcpySession: null }],
    ['no session', null],
  ])('carries no lock across a fold on an emulator with %s', async (_name, live) => {
    const adb = posturableAdb()
    const dm = await import('../displayMetrics')
    vi.spyOn(adb, 'getDisplayMetrics')
      .mockResolvedValueOnce(dm.parseDisplayMetrics('    init=2076x2152 cur=2152x2076\n mRotation=ROTATION_270'))
      .mockResolvedValue(dm.parseDisplayMetrics('    init=1080x2424 cur=1080x2424\n mRotation=ROTATION_0'))
    const agent = new AndroidAgent({}, adb)
    if (live) internals(agent).deviceStates.set('s1', live as unknown as TestState)

    await agent.setPosture('avd:Pixel_8_API_34', '1')

    expect(adb.setRotation).not.toHaveBeenCalled()
  })

  // A boot that swaps scrcpy for gRPC during the settling read has already freed the lock this would write.
  // Mutation: ask about the backend only before the read.
  it('carries no lock when the stream turns gRPC while the carry settles', async () => {
    const adb = posturableAdb()
    const dm = await import('../displayMetrics')
    const live = { deviceId: 'avd:Pixel_8_API_34', booted: true, grpcClient: null, scrcpySession: {} as unknown }
    vi.spyOn(adb, 'getDisplayMetrics')
      .mockResolvedValueOnce(dm.parseDisplayMetrics('    init=2076x2152 cur=2152x2076\n mRotation=ROTATION_270'))
      .mockImplementation(async () => {
        Object.assign(live, { scrcpySession: null, grpcClient: {} })
        return dm.parseDisplayMetrics('    init=1080x2424 cur=1080x2424\n mRotation=ROTATION_0')
      })
    const agent = new AndroidAgent({}, adb)
    internals(agent).deviceStates.set('s1', live as unknown as TestState)

    await agent.setPosture('avd:Pixel_8_API_34', '1')

    expect(adb.setRotation).not.toHaveBeenCalled()
  })

  it('leaves the rotation alone when the change did not disturb it', async () => {
    // The pair: without it, "puts the rotation back" is satisfied by code that always writes one,
    // which would fight a device that rotated for its own reasons.
    const adb = posturableAdb()
    const dm = await import('../displayMetrics')
    const same = dm.parseDisplayMetrics('    init=2076x2152 cur=2152x2076\n mRotation=ROTATION_270')
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue(same)
    const agent = new AndroidAgent({}, adb)

    await agent.setPosture('avd:Pixel_8_API_34', '1')

    expect(adb.setRotation).not.toHaveBeenCalled()
  })

  it('sends the chosen identifier to the device', async () => {
    const adb = posturableAdb()
    const agent = new AndroidAgent({}, adb)
    await agent.setPosture('avd:Pixel_8_API_34', '1')
    expect(adb.setPosture).toHaveBeenCalledWith('emulator-5554', '1')
  })

  it('refuses an id the device does not offer, and sends nothing', async () => {
    const adb = posturableAdb()
    const agent = new AndroidAgent({}, adb)
    // `cmd device_state` accepts an unknown identifier without adb surfacing the failure, so an
    // unchecked id would read as a posture change that silently did nothing.
    await expect(agent.setPosture('avd:Pixel_8_API_34', '99')).rejects.toThrow(/Unknown posture/)
    expect(adb.setPosture).not.toHaveBeenCalled()
  })

  it('answers [] for a device that has no postures', async () => {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'printDeviceStates').mockResolvedValue('Supported states: [\n]')
    const agent = new AndroidAgent({}, adb)
    expect(await agent.listPostures('avd:Pixel_8_API_34')).toEqual([])
    expect(await agent.getPosture('avd:Pixel_8_API_34')).toBeNull()
  })

  it('is posturable by feature detection, whatever the device turns out to be', () => {
    // The capability is the agent's, not the device's — one AndroidAgent hosts both kinds.
    expect(isPosturable(new AndroidAgent({}, mockAdb()))).toBe(true)
  })
})

// The body-turning model (four-way rotation): an emulator streaming over gRPC turns its body and says how far.
describe('an emulator\'s body', () => {
  const grpcState = (body: 0 | 90 | 180 | 270 | null = null) => ({
    deviceId: 'avd:Pixel_8_API_34', sessionId: 's1', landscape: false, booted: true,
    videoWidth: 1080, videoHeight: 2400, displayWidth: 1080, displayHeight: 2400,
    rotation: 0, streamRotation: 0, skin: null, body, reconciling: false, screenWatch: null, cornerRadiusPx: 0,
    grpcClient: {}, scrcpySession: null,
  }) as unknown as TestState
  const sentChromes = (agent: AndroidAgent) => {
    const sent: Array<Record<string, unknown>> = []
    ;(agent as unknown as { ws: { readyState: number; send(d: string): void } }).ws = {
      readyState: 1, send: (d: string) => { const m = JSON.parse(d) as { type: string; payload: Record<string, unknown> }; if (m.type === 'session:chrome') sent.push(m.payload) },
    }
    return sent
  }
  const body = (adb: AdbWrapper) => (adb as unknown as { body: { at: 0 | 90 | 180 | 270 } }).body

  // Mutations: send it on scrcpy; leave it out on gRPC.
  it('reports how far the body is turned on gRPC, and nothing on scrcpy', () => {
    const agent = new AndroidAgent({}, mockAdb(true))
    const sent = sentChromes(agent)
    internals(agent).sendChrome(grpcState(90))
    internals(agent).sendChrome({ ...grpcState(90), grpcClient: null } as unknown as TestState)
    expect(sent[0]!['bodyRotation']).toBe(90)
    expect('bodyRotation' in sent[1]!).toBe(false)
  })

  // The skin a frame carries is the body inverted: REVERSE_LANDSCAPE is a quarter clockwise (measured — the frame
  // then arrives as the device is held). Mutation: take the skin's degrees as they are.
  it('takes the body from the frame\'s skin, inverted', async () => {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue({ natural: { width: 1080, height: 2400 }, current: { width: 1080, height: 2400 }, rotation: 0 })
    const agent = new AndroidAgent({}, adb)
    const state = grpcState(0)
    await internals(agent).reconcileScreen(state, 'emulator-5554', 2400, 1080, 'REVERSE_LANDSCAPE')
    expect((state as unknown as { body: number }).body).toBe(90)
  })

  // A rotate's pass asks with the skin last *committed*; the frame that turned arrived first and is the truth.
  // Seen on a Galaxy S23: the stale pass ran last and the viewer framed a landscape frame in a portrait shell.
  // Mutation: reconcile with the asker's skin.
  it('reconciles with the newest frame\'s skin, whoever asked', async () => {
    const adb = mockAdb(true)
    vi.spyOn(adb, 'getDisplayMetrics').mockResolvedValue({ natural: { width: 1080, height: 2400 }, current: { width: 1080, height: 2400 }, rotation: 0 })
    const agent = new AndroidAgent({}, adb)
    const state = { ...grpcState(0), skin: 'PORTRAIT', latestFrame: { w: 2400, h: 1080, skin: 'REVERSE_LANDSCAPE' } } as unknown as TestState
    await internals(agent).reconcileSerial(state, 'emulator-5554', 1080, 2400, 'PORTRAIT')
    expect((state as unknown as { skin: string }).skin).toBe('REVERSE_LANDSCAPE')
    expect((state as unknown as { streamRotation: number }).streamRotation).toBe(270)
    expect((state as unknown as { body: number }).body).toBe(90)
  })

  // A quarter clockwise or anticlockwise from where the body reads, and an older viewer's landscape met by
  // either landscape. Mutations: turn from a remembered body; meet landscape with one landscape only.
  it('turns the body from a fresh reading, a quarter at a time', async () => {
    const adb = mockAdb(true)
    const agent = new AndroidAgent({}, adb)
    vi.spyOn(agent as unknown as { reconcileSerial(): Promise<boolean> }, 'reconcileSerial').mockResolvedValue(false)
    internals(agent).deviceStates.set('s1', grpcState(0))
    const rotate = (payload: unknown) => internals(agent).handleRelayMessage({ type: 'input:rotate', sessionId: 's1', payload })
    const held = () => (internals(agent).deviceStates.get('s1') as unknown as { body: number }).body
    rotate({ direction: 'clockwise' })
    await vi.waitFor(() => expect(held()).toBe(90)) // confirmed, not merely sent
    body(adb).at = 270 // turned in the emulator's own controls
    rotate({ direction: 'clockwise' })
    await vi.waitFor(() => expect(body(adb).at).toBe(0))
    rotate({ direction: 'counterclockwise' })
    await vi.waitFor(() => expect(body(adb).at).toBe(270))
    vi.mocked(adb.rotateBodyClockwise).mockClear()
    rotate({ orientation: 'landscape' })
    await new Promise((r) => setTimeout(r, 30))
    expect(adb.rotateBodyClockwise).not.toHaveBeenCalled()
  })

  // A turn the emulator took and did not make leaves the body where it reads, not where it was asked to go.
  // Mutation: record the target without confirming it.
  it('keeps the body where it reads when a turn does not land', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adb = mockAdb(true)
    vi.mocked(adb.rotateBodyClockwise).mockResolvedValue(undefined) // takes it, does not turn
    const agent = new AndroidAgent({}, adb)
    const state = grpcState(0)
    await internals(agent).prepareBody({ ...state, deviceId: 'avd:X' } as unknown as TestState, 'emulator-5554', false)
    body(adb).at = 90
    const s2 = grpcState(90)
    await (agent as unknown as { turnBodyTo(s: TestState, serial: string, want: number): Promise<unknown> }).turnBodyTo(s2, 'emulator-5554', 0)
    expect((s2 as unknown as { body: number }).body).toBe(90)
  }, 10_000)

  // Earlier tapflow versions locked the rotation and a lock cannot be told from one a person chose: freed the
  // first time tapflow sees the AVD, never again. Mutations: free on every boot; never free.
  it('frees the rotation lock once per AVD', async () => {
    const adb = mockAdb(true)
    const freedAvds = new Set<string>()
    const agent = new AndroidAgent({ rotationLockMemory: { freed: (n) => freedAvds.has(n), markFreed: (n) => { freedAvds.add(n) }, forget: (n) => { freedAvds.delete(n) } } }, adb)
    await internals(agent).prepareBody(grpcState(), 'emulator-5554', false)
    await internals(agent).prepareBody(grpcState(), 'emulator-5554', false)
    expect(adb.freeRotation).toHaveBeenCalledTimes(1)
    expect([...freedAvds]).toEqual(['Pixel_8_API_34'])
  })

  // A marker that cannot be written is not a lock that stayed: the free is reported as done, and the body is
  // still read. Mutation: share one try between the free and the marker.
  it('does not call a freed lock unfreed when the marker cannot be written', async () => {
    const adb = mockAdb(true)
    body(adb).at = 90
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent = new AndroidAgent({ rotationLockMemory: { freed: () => false, markFreed: () => { throw new Error('EROFS') }, forget: () => {} } }, adb)
    const state = grpcState()
    await internals(agent).prepareBody(state, 'emulator-5554', false)
    expect((state as unknown as { body: number }).body).toBe(90)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('could not free')
  })

  // Only a boot that brought the emulator up, or a run, stands the body up; otherwise it is read and left.
  // Mutation: always stand it up.
  it('stands the body up only when asked, and otherwise only reads it', async () => {
    const adb = mockAdb(true)
    body(adb).at = 270
    const agent = new AndroidAgent({}, adb)
    const left = grpcState()
    await internals(agent).prepareBody(left, 'emulator-5554', false)
    expect(body(adb).at).toBe(270)
    expect((left as unknown as { body: number }).body).toBe(270)
    await internals(agent).prepareBody(grpcState(), 'emulator-5554', true)
    expect(body(adb).at).toBe(0)
  })
})
