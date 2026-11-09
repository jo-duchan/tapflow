import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { ValidationError, PlatformError, MAX_CLIPBOARD_BYTES, SHUTDOWN_NO_SESSION_STATE, CLIPBOARD_SENTINEL_PREFIX } from '@tapflowio/agent-core'
import { ClipboardTooLargeError } from '../SimctlWrapper.js'
import { SimulatorNetwork } from '../SimulatorNetwork.js'

// A live helper. Since #482 every write reports whether it reached the helper process and the
// agent acks on that answer, so the mock has to state it — returning undefined would model a
// helper that silently drops everything. `killHelper()` below flips one over to that state.
const touchGate = vi.hoisted(() => ({ ready: (): Promise<boolean> => Promise.resolve(true) }))

vi.mock('../TouchHelper', () => ({
  TouchHelper: vi.fn(function () { return withMinContact({
    start: vi.fn(),
    stop: vi.fn(),
    isReady: vi.fn(() => true),
    // The agent asks this when a write is refused, to tell "still starting" from "gone" — a mock
    // without it makes the ws dispatch swallow a TypeError and send no ack at all, which surfaces
    // as tests hanging with no message rather than failing.
    inputState: vi.fn(() => 'ready'),
    // A boot holds `device:ready` until this resolves (#1114); a test swaps the gate to hold it.
    whenReady: vi.fn(() => touchGate.ready()),
    // Asked before readiness for a continuation frame: a gesture whose open never landed can never
    // be finished, however ready the helper becomes.
    ownsGesture: vi.fn(() => true),
    touchStart: vi.fn(() => true),
    touchMove: vi.fn(() => true),
    touchEnd: vi.fn(() => true),
    touchCancel: vi.fn(() => true),
    pressButton: vi.fn(() => true),
    pressButtonDown: vi.fn(() => true),
    pressButtonUp: vi.fn(() => true),
    pressLegacyButton: vi.fn(() => true),
    pinchStart: vi.fn(() => true),
    pinchMove: vi.fn(() => true),
    pinchEnd: vi.fn(() => true),
    sendKey: vi.fn(() => true),
  }) }),
}))

// The agent writes a terminal frame through `touchEndAfterMinContact`, whose answer is `touchEnd`'s once the
// touch has lasted long enough. Mirrored here without the wait, and non-enumerable so `killHelper` (which
// rewrites every mock) leaves it following `touchEnd` — a dead helper's dropped up is still answered false.
function withMinContact<T extends { touchEnd: () => boolean }>(helper: T): T {
  Object.defineProperty(helper, 'touchEndAfterMinContact', {
    value: () => Promise.resolve(helper.touchEnd()),
    enumerable: false,
  })
  return helper
}

// The #482 state: the helper object is still there and the stream is still running, but its
// child process is gone, so every write is dropped.
function killHelper(th: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const [name, fn] of Object.entries(th)) {
    if (name !== 'start' && name !== 'stop') fn.mockReturnValue(false)
  }
  th.inputState.mockReturnValue('unavailable')
  th.ownsGesture.mockReturnValue(false)
}

// Running but not yet injecting — measured at 186–247ms after spawn on a real simulator. Writes are
// refused exactly as on a dead channel, so only `inputState()` separates the two.
function startingHelper(th: Record<string, ReturnType<typeof vi.fn>>): void {
  killHelper(th)
  th.inputState.mockReturnValue('starting')
}

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
      selectPanel: vi.fn(),
    }) }),
  }
})

// Mock the audio path so the whole-sim tap can be asserted without building/launching the real helper
// or enumerating live processes. listen() resolves a fake port; frames() never closes (live capture).
vi.mock('../AudioCaptureStreamer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AudioCaptureStreamer')>()
  return {
    ...actual,
    AudioCaptureStreamer: vi.fn(function () { return {
      listen: vi.fn().mockResolvedValue(54321),
      frames: () => new ReadableStream({ start() {} }),
      updatePids: vi.fn(),
      stop: vi.fn(),
    } }),
  }
})
// Build/launch/permission helper utils moved to the shared @tapflowio/audiotap-helper package.
vi.mock('@tapflowio/audiotap-helper', () => ({
  ensureHelperApp: vi.fn(() => '/fake/audiotap-helper.app'),
  launchAudioHelper: vi.fn(),
  isAudioSupported: vi.fn(() => true),
}))
vi.mock('../SimProcessTree', () => ({
  enumerateSimPids: vi.fn(() => Promise.resolve([101, 102, 103])),
}))

import crypto from 'crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer, initDb, closeDb, getDb } from '@tapflowio/relay'
import { IOSAgent, leanSupported, streamRestartPlan } from '../IOSAgent'
import type { DeviceChromeLoader, ChromeData } from '../DeviceChromeLoader'
import { ScreenCaptureStreamer } from '../ScreenCaptureStreamer'
import { AudioCaptureStreamer } from '../AudioCaptureStreamer'
import { enumerateSimPids } from '../SimProcessTree'
import { launchAudioHelper } from '@tapflowio/audiotap-helper'
import { SimctlWrapper } from '../SimctlWrapper'
import { LeanStore, parseDisabledStore } from '../LeanStore'
import { labelsFor } from '../serviceTiers'
import type { ServiceTier } from '@tapflowio/protocol'
import { LEAN_LABELS } from '../leanLabels'
import { TouchHelper } from '../TouchHelper'
import { XCUITreeReader } from '../XCUITreeReader'
import { PanelState } from '../PanelState'
import { PhysicalOrientation, type DeviceOrientation } from '../PhysicalOrientation'
import type { GuestHelperNative } from '../GuestHelper'
import { EventEmitter } from 'events'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { SessionJoined } from '@tapflowio/protocol'
const MockTouchHelper = vi.mocked(TouchHelper)
const MockAudioStreamer = vi.mocked(AudioCaptureStreamer)
const mockLaunchAudioHelper = vi.mocked(launchAudioHelper)

// Test-only view of IOSAgent internals (reconnect state lives behind private fields).
interface IOSAgentInternals {
  ws: WebSocket | null
  _stopping: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempt: number
  _scheduleReconnect(): void
  lastPingAt: number | null
  lastSocketError: string | undefined
  deviceStates: Map<string, { booted: boolean; deviceId: string }>
}
const internals = (agent: IOSAgent): IOSAgentInternals => agent as unknown as IOSAgentInternals
/** The one private method a test drives directly. Separate from `IOSAgentInternals` so that view stays
 *  about reconnect state, which is what every other test uses it for. */
const internals2 = (agent: IOSAgent): { reportEnforcementLost(deviceId: string): void } =>
  agent as unknown as { reportEnforcementLost(deviceId: string): void }

// HID usage codes from KeyCodeMap (duplicated here so tests are self-contained)
const HID_BACKSPACE = 0x2A
const HID_KEY_A = 0x04


let pasteboard = ''
const isSentinelish = (v: string): boolean => v.startsWith('\u200Btapflow-clipboard-')
// How long the simulator takes to actually show a written pasteboard. `pbcopy` exiting means
// accepted, not visible — the read path must not assume otherwise.
let pasteboardApplyDelayMs = 0
/** Simulate the app reacting to an injected copy chord by writing to the pasteboard. `afterMs`
 *  models the real gap between injecting HID and the app actually copying — with 0 the write is
 *  synchronous, which would mask any read-too-early bug. */
const copyOnChord = (th: { sendKey: ReturnType<typeof vi.fn> }, text = 'copied text', afterMs = 0) =>
  th.sendKey.mockImplementation(() => {
    if (afterMs > 0) setTimeout(() => { pasteboard = text }, afterMs)
    else pasteboard = text
  })

// `booted` stays boolean for the callers that only care about on/off. `'unknown'` is what
// `toDeviceStatus` returns for every transient state — Booting, Shutting Down, Creating — and
// `simctl erase` refuses all of them, so it needs to be reachable from a test.
/** Two registered simulators, both shut down. The relay opens a session per registered device, so
 *  this is what an ordinary Mac looks like — `mockSimctl`'s single device makes "the session's
 *  device" and "the first registered device" indistinguishable, which is the whole defect. */
function mockSimctlTwoDevices(): SimctlWrapper {
  const sw = mockSimctl(false)
  ;(sw.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
    { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
  ])
  return sw
}

function mockSimctl(booted: boolean | 'unknown' = false): SimctlWrapper {
  const status = booted === 'unknown' ? 'unknown' : booted ? 'booted' : 'shutdown'
  pasteboard = ''
  pasteboardApplyDelayMs = 0
  const sw = {
    listDevices: vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status, osVersion: 'iOS 18.3', typeId: 'type-iphone-15' },
    ]),
    formFactorsByType: vi.fn().mockResolvedValue(new Map([['type-iphone-15', 'phone']])),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    erase: vi.fn().mockResolvedValue(undefined),
    uninstallApp: vi.fn().mockResolvedValue(undefined),
    clearAppData: vi.fn().mockResolvedValue(undefined),
    // Absent until L5 added the first `open-url` tests — which is why the handler had none.
    openUrl: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    syncKeyboardsFromLanguages: vi.fn().mockResolvedValue(undefined),
    resetKeyboardLanguage: vi.fn().mockResolvedValue(undefined),
    setKeyboardLanguage: vi.fn().mockResolvedValue(true),
    keyboardLanguage: vi.fn().mockResolvedValue(undefined),
    showSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    hideSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    // Stateful pasteboard: the agent confirms a write by reading it back, so a mock that
    // always answers '' would never converge.
    setPasteboard: vi.fn(async function (this: void, _d: string, t: string) {
      if (pasteboardApplyDelayMs > 0) setTimeout(() => { pasteboard = t }, pasteboardApplyDelayMs)
      else pasteboard = t
    }),
    getPasteboard: vi.fn(async () => pasteboard),
    stopKeyboardDaemon: vi.fn(),
    // The network layers (#607). Absent, the agent's `arm()` threw into a `.catch` and every network
    // assertion below read a state assembled from a failure nobody could see.
    setStatusBarOffline: vi.fn().mockResolvedValue(undefined),
    setSimulatorEnv: vi.fn().mockResolvedValue(undefined),
    // Every boot stands the simulator up (#910). Absent, that step threw into the rotation queue's
    // `.catch` and every boot test ran the failure path without saying so.
    rotate: vi.fn().mockResolvedValue(undefined),
  } as unknown as SimctlWrapper
  // `handleDeviceBoot` awaits this before it announces readiness (#486). The real one polls
  // `listDevices` until the device reports `booted`, so the double reads the same list — a test that
  // rewrites it (`mockSimctlTwoDevices`, and the per-test `mockResolvedValue` overrides) then gets
  // the device the agent actually asked for rather than a fixture pinned here. It answers `booted`
  // because that is the only status the poll returns on; the polling itself, its deadline, its grace
  // for a settled device and its `isStale` signal are all covered in `SimctlWrapper.test.ts`, which
  // drives real transitions through the runner.
  //
  // **`opts.isStale` is deliberately ignored here.** This double does not poll, so there is nothing
  // to cancel — and the agent-side claim worth testing is the other guard: the `bootSeq` re-check on
  // the far side of the wait, which only runs once the wait returns.
  //
  // One caller does not get the shared list: `{ ...mockSimctl(false), listDevices: … }` spreads the
  // object, and the copy's `waitUntilBooted` still closes over the original `sw`. That test does not
  // boot, and the failure mode if one did would be a loud `device:boot-error`, not a silent pass.
  sw.waitUntilBooted = vi.fn(async (deviceId: string, _opts?: { isStale?: () => boolean }) => {
    const device = (await sw.listDevices()).find((d) => d.id === deviceId)
    if (!device) throw new PlatformError(`Device ${deviceId} did not finish booting`)
    return { ...device, status: 'booted' as const }
  })
  return sw
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

  // CodeRabbit #272 ⑥ — 직접 인스턴스화 시 비-macOS에서 일찍 명확히 실패한다 (AGENTS.md 규칙)
  describe('platform guard', () => {
    it('비-macOS + simctl 미주입(실제 런타임 경로)은 throw', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      expect(() => new IOSAgent()).toThrow(/macOS/)
      spy.mockRestore()
    })

    it('비-macOS여도 simctl 주입(테스트/모킹 경로)은 허용', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      expect(() => new IOSAgent({}, mockSimctl())).not.toThrow()
      spy.mockRestore()
    })
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

    // The DeviceAgent interface carries no device (it is shared with Android and predates
    // multi-session agents), so these resolve the one live session — or refuse. Refusing beats
    // falling through to simctl's `booted` alias, which would act on whichever simulator is up.
    it('installApp refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.installApp('/path/MyApp.app')).rejects.toThrow(/no booted device/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('launchApp refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.launchApp('com.example.app')).rejects.toThrow(/no booted device/)
      expect(simctl.launchApp).not.toHaveBeenCalled()
    })

    it('screenshot refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.screenshot()).rejects.toThrow(/no booted device/)
      expect(simctl.screenshot).not.toHaveBeenCalled()
    })

    // installBuild: extract .app.zip / .tar.gz to a temp dir, then simctl install the .app.
    // The real simulator install+launch (fidelity/exec-bit) is manual QA; here we verify the
    // archive branch resolves the .app path via mocked simctl.
    type WithInstallBuild = { installBuild(udid: string, filePath: string, bundleId?: string): Promise<void> }
    const makeSimAppArchive = (name: string, ext: string): string => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-src-'))
      const appDir = path.join(src, `${name}.app`)
      fs.mkdirSync(appDir, { recursive: true })
      fs.writeFileSync(path.join(appDir, 'Info.plist'), '<plist><dict/></plist>')
      fs.writeFileSync(path.join(appDir, name), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
      const out = path.join(src, `${name}${ext}`)
      if (ext.includes('tar') || ext.includes('tgz')) {
        spawnSync('tar', ['-czf', out, '-C', src, `${name}.app`])
      } else {
        spawnSync('zip', ['-r', out, `${name}.app`], { cwd: src })
      }
      return out
    }

    // ── Extraction must not hold the event loop ─────────────────────────────
    //
    // `spawnSync` froze the whole agent for as long as `unzip` ran: on a large build or a busy Mac that
    // was long enough for the relay's heartbeat to end the agent's connection. A slow fake `unzip` makes
    // the hold measurable — a 1 ms interval keeps ticking only if the extraction is asynchronous.
    describe('extraction off the event loop', () => {
      const realUnzip = spawnSync('/bin/sh', ['-c', 'command -v unzip']).stdout.toString().trim()
      const originalPath = process.env.PATH
      afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
      })

      it('keeps the event loop running while the archive extracts', async () => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-slow-unzip-'))
        fs.writeFileSync(path.join(bin, 'unzip'), `#!/bin/sh\nsleep 0.3\nexec "${realUnzip}" "$@"\n`, { mode: 0o755 })
        process.env.PATH = `${bin}:${originalPath ?? ''}`
        const archive = makeSimAppArchive('SlowApp', '.app.zip')
        const simctl = mockSimctl()
        let ticks = 0
        let ticksAtInstall = -1
        vi.mocked(simctl.installApp).mockImplementation(async () => { ticksAtInstall = ticks })
        const timer = setInterval(() => { ticks++ }, 1)
        try {
          await (new IOSAgent({}, simctl) as unknown as WithInstallBuild).installBuild('dev-1', archive)
        } finally {
          clearInterval(timer)
        }
        expect(simctl.installApp).toHaveBeenCalledWith('dev-1', expect.stringMatching(/SlowApp\.app$/))
        expect(ticksAtInstall).toBeGreaterThanOrEqual(20)
      })

      it('still reports a missing extractor as a failure to run it, not a bad archive', async () => {
        const archive = makeSimAppArchive('NoTool', '.app.zip')
        process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-empty-path-'))
        const err = await (new IOSAgent({}, mockSimctl()) as unknown as WithInstallBuild)
          .installBuild('dev-1', archive).catch((e: unknown) => e)
        expect(String(err)).toMatch(/아카이브 추출 실행 실패 \(unzip: ENOENT\)/)
      })
    })

    // ── Downloading the build instead of opening the relay's path ───────────
    //
    // The relay used to send its own filesystem path and this agent opened it, which holds only when
    // the two share a disk. The downloader and the relay route each have their own tests; **this is
    // the wiring between them**, and it had none — the half that decides whether a ticket is used at
    // all, and whether the downloaded file keeps the extension the extract branch below reads.
    type WithRemoteInstall = {
      installBuild(
        udid: string, filePath: string, bundleId?: string,
        remote?: { buildTicket?: string; buildName?: string; buildBytes?: number },
      ): Promise<void>
      relayUrl: string | null
    }

    /** A relay that serves one file against any ticket, and records what it was asked for. */
    const fakeRelay = async (body: Buffer) => {
      const seen: { url?: string; ticket?: string } = {}
      const server = http.createServer((req, res) => {
        seen.url = req.url
        seen.ticket = req.headers['x-tapflow-build-ticket'] as string
        res.writeHead(200, { 'Content-Length': body.length })
        res.end(body)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) }
    }

    it('fetches the build over HTTP when the relay sends a ticket', async () => {
      const archive = makeSimAppArchive('RemoteApp', '.app.zip')
      const relay = await fakeRelay(fs.readFileSync(archive))
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = `ws://127.0.0.1:${relay.port}`

      // A path that exists **nowhere on this machine** — the shape the relay actually sends from a
      // container. If the ticket branch is skipped, `unzip` reports it and the install fails.
      await agent.installBuild('dev-1', '/app/.tapflow/data/uploads/builds/RemoteApp.app.zip', undefined, {
        buildTicket: 'tkt', buildName: 'RemoteApp.app.zip', buildBytes: fs.statSync(archive).size,
      })

      expect(simctl.installApp).toHaveBeenCalledTimes(1)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/RemoteApp\.app$/)
      expect(relay.seen.url).toBe('/api/v1/build-download')
      expect(relay.seen.ticket).toBe('tkt')
      await relay.close()
    })

    // Mutation: write the download to a random temp name. `installFrom` branches on the extension,
    // so a zip would go straight to `simctl` unopened — the comment beside that branch says exactly
    // this, and nothing held it.
    it('keeps the upload filename, because the extension decides how it installs', async () => {
      const archive = makeSimAppArchive('TarRemote', '.tar.gz')
      const relay = await fakeRelay(fs.readFileSync(archive))
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = `ws://127.0.0.1:${relay.port}`

      await agent.installBuild('dev-1', '/app/nowhere/TarRemote.tar.gz', undefined, {
        buildTicket: 'tkt', buildName: 'TarRemote.tar.gz', buildBytes: fs.statSync(archive).size,
      })

      // It reached tar rather than `simctl install <the archive>`, which is the whole difference.
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/TarRemote\.app$/)
      await relay.close()
    })

    // Mutation: download whenever a ticket is present, regardless of `relayUrl`. There is no origin
    // to build one from before the agent has connected, and the URL constructor throws rather than
    // answering — a crash where the old path would simply have worked.
    it('falls back to the path when it has no relay url to fetch from', async () => {
      const archive = makeSimAppArchive('LocalApp', '.app.zip')
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = null

      await agent.installBuild('dev-1', archive, undefined, {
        buildTicket: 'tkt', buildName: 'LocalApp.app.zip', buildBytes: 1,
      })

      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/LocalApp\.app$/)
    })

    // **The uninstall must not run before there is a build to put back.** It used to, which was
    // survivable while the only thing between it and the install was a local extract — this change
    // put a network transfer in that gap. A tester whose download fails would lose the app they
    // were using to an install that never had a chance of finishing.
    //
    // Mutation: move the uninstall back above the download. `uninstallApp` is then called and the
    // simulator is left empty.
    it('does not uninstall the app it is replacing until the build has arrived', async () => {
      const relay = await fakeRelay(Buffer.from('far too short'))
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = `ws://127.0.0.1:${relay.port}`

      await agent.installBuild('dev-1', '/app/nowhere/X.app.zip', 'com.example.demo', {
        buildTicket: 'tkt', buildName: 'X.app.zip', buildBytes: 9_999,
      }).catch(() => { /* the download is meant to fail */ })

      expect(simctl.uninstallApp).not.toHaveBeenCalled()
      expect(simctl.installApp).not.toHaveBeenCalled()
      await relay.close()
    })

    // And it still runs on the way through when the build does arrive — otherwise the guard above
    // would be satisfied by never uninstalling at all.
    it('uninstalls the previous app once the build is in hand', async () => {
      const archive = makeSimAppArchive('ReplaceApp', '.app.zip')
      const relay = await fakeRelay(fs.readFileSync(archive))
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = `ws://127.0.0.1:${relay.port}`

      await agent.installBuild('dev-1', '/app/nowhere/ReplaceApp.app.zip', 'com.example.demo', {
        buildTicket: 'tkt', buildName: 'ReplaceApp.app.zip', buildBytes: fs.statSync(archive).size,
      })

      expect(simctl.uninstallApp).toHaveBeenCalledWith('dev-1', 'com.example.demo')
      expect(simctl.installApp).toHaveBeenCalledTimes(1)
      await relay.close()
    })

    // Mutation: report a download failure as an extraction failure. That collapse is the defect this
    // whole change exists to end — a build that was fine, described as a bad archive.
    it('says the transfer was cut short, not that the archive is damaged', async () => {
      const relay = await fakeRelay(Buffer.from('too short'))
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithRemoteInstall
      agent.relayUrl = `ws://127.0.0.1:${relay.port}`

      const err = await agent.installBuild('dev-1', '/app/nowhere/X.app.zip', undefined, {
        buildTicket: 'tkt', buildName: 'X.app.zip', buildBytes: 9_999,
      }).catch((e: unknown) => e)

      expect((err as Error).message).toMatch(/not damaged/)
      expect((err as Error).message).not.toMatch(/압축 해제 실패/)
      expect(simctl.installApp).not.toHaveBeenCalled()
      await relay.close()
    })

    it('installBuild extracts a .tar.gz and installs the .app (R4)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const tarPath = makeSimAppArchive('TarApp', '.tar.gz')
      await agent.installBuild('dev-1', tarPath)
      expect(simctl.installApp).toHaveBeenCalledTimes(1)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/TarApp\.app$/)
    })

    it('installBuild supports the .tgz extension', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const tarPath = makeSimAppArchive('TgzApp', '.tgz')
      await agent.installBuild('dev-1', tarPath)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/TgzApp\.app$/)
    })

    it('installBuild still handles legacy .app.zip (regression)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const zipPath = makeSimAppArchive('ZipApp', '.app.zip')
      await agent.installBuild('dev-1', zipPath)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/ZipApp\.app$/)
    })

    it('installBuild rejects a tar.gz with no .app directory', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-noapp-'))
      fs.writeFileSync(path.join(src, 'readme.txt'), 'hi')
      const out = path.join(src, 'noapp.tar.gz')
      spawnSync('tar', ['-czf', out, '-C', src, 'readme.txt'])
      await expect(agent.installBuild('dev-1', out)).rejects.toThrow(/\.app/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('installBuild throws a validation error on a corrupt .tar.gz (bad archive, not a spawn failure)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-bad-'))
      const out = path.join(src, 'corrupt.tar.gz')
      fs.writeFileSync(out, Buffer.from('not a real gzip stream'))
      await expect(agent.installBuild('dev-1', out)).rejects.toThrow(/압축 해제 실패/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('launchApp refuses when no session is open (interface path)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.launchApp('com.example.app')).rejects.toThrow(/no booted device/)
      expect(simctl.launchApp).not.toHaveBeenCalled()
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

  describe('input setup — lazy TouchHelper on a null-helper booted session (followups H-E)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    // A reconnect clears+re-registers deviceStates with touchHelper=null while the sim stays booted (IOSAgent _scheduleReconnect → initDeviceStates); input must self-heal without a fresh device:boot. These tests drive that null-helper-on-booted-sim state directly — skipping device:boot is intentional, since booting would create the helper and bypass the lazy path under test.
    async function joinBootlessSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true)) // sim booted, session has touchHelper=null (no device:boot)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      MockTouchHelper.mockClear()
      return { browser, agent }
    }

    // The socket boundary requires a string `sessionId` before dispatching, and that is what lets the
    // dispatcher declare it required — which removed 25 `msg.sessionId!` assertions. Without a test the guard
    // could be deleted and nothing would notice until one of those `!` was needed again.
    //
    // Driven by emitting on the agent's own socket rather than sending through the relay, because **the relay
    // already blocks this**: its forward gate resolves `sessions.get(msg.sessionId)` and answers the browser
    // itself for a terminal input, so a frame with no sessionId never reaches an agent by that path. That is
    // the same fact the required declaration rests on — and it means the guard exists for a client that
    // connects to the agent directly, which no relay-level test can simulate. Two earlier versions of this
    // test went through the relay and passed the mutation for exactly that reason.
    it('does not dispatch a frame with no sessionId', async () => {
      const { browser, agent } = await joinBootlessSession()
      const ws = internals(agent).ws!
      const sent = vi.spyOn(ws, 'send')

      for (const frame of [
        { type: 'input:touch:end', requestId: 'rq-in1', payload: { x: 0.4, y: 0.6 } },
        { type: 'input:touch:end', requestId: 'rq-in2', sessionId: 42, payload: { x: 0.4, y: 0.6 } },
      ]) ws.emit('message', Buffer.from(JSON.stringify(frame)))

      const answers = () => sent.mock.calls
        .map(([f]) => JSON.parse(String(f)) as { type: string })
        .filter((m) => m.type === 'input:error' || m.type === 'input:done')
      expect(answers()).toEqual([])

      // A well-formed frame on the same path is still dispatched, so the guard is not rejecting everything.
      ws.emit('message', Buffer.from(JSON.stringify(
        { type: 'input:touch:end', requestId: 'rq-in3', sessionId: agent.sessionId, payload: { x: 0.4, y: 0.6 } },
      )))
      await vi.waitFor(() => expect(answers()).toHaveLength(1), { timeout: 500 })

      agent.disconnect()
      browser.close()
    })

    it('lazily creates TouchHelper when input arrives with no device:boot for the session', async () => {
      const { browser, agent } = await joinBootlessSession()

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.4, y: 0.6 } }))

      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const th = MockTouchHelper.mock.results[0].value
      expect(th.start).toHaveBeenCalled()
      expect(th.touchStart).toHaveBeenCalledWith(0.4, 0.6)

      agent.disconnect()
      browser.close()
    })

    // A tap is start + end (two messages); sync setup lets the end see the helper the start created (async would drop touchEnd → stuck finger).
    it('keeps touch start/end paired through lazy setup (no stuck finger)', async () => {
      const { browser, agent } = await joinBootlessSession()

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in4', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      await vi.waitFor(() => {
        expect(MockTouchHelper.mock.results).toHaveLength(1)
        const th = MockTouchHelper.mock.results[0].value
        expect(th.touchStart).toHaveBeenCalledTimes(1)
        expect(th.touchEnd).toHaveBeenCalledTimes(1)
      }, { timeout: 500 })

      agent.disconnect()
      browser.close()
    })
  })

  // A client leaving mid-gesture sends a cancel before its end (#1115): the helper is asked to cancel, unanswered.
  describe('input:touch:cancel', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    it('asks the helper to cancel the touch, and sends no ack', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const seen: string[] = []
      browser.on('message', (d, binary) => { if (!binary) seen.push((JSON.parse(String(d)) as { type: string }).type) })
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-cancel', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0))
      const th = MockTouchHelper.mock.results.at(-1)!.value
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:cancel', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(th.touchCancel).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 100))
      expect(seen.filter((t) => t.startsWith('input:'))).toEqual([])
      agent.disconnect()
      browser.close()
    })
  })

  // The touch helper is started by the boot and drops what it is sent until it says it is ready, so a client acting on
  // `device:ready` at once was refused its first input (#1114).
  describe('device:ready waits for the touch helper', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })
    afterEach(() => { touchGate.ready = () => Promise.resolve(true) })

    async function boot(options: { touchReadyWaitMs?: number } = {}) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const seen: string[] = []
      browser.on('message', (d, binary) => { if (!binary) seen.push((JSON.parse(String(d)) as { type: string }).type) })
      const agent = new IOSAgent({ intervalMs: 50, ...options }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-touch', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      return { agent, browser, seen }
    }

    it('is not sent until the helper is ready', async () => {
      let release: ((ready: boolean) => void) | undefined
      touchGate.ready = () => new Promise((resolve) => { release = resolve })
      const { agent, browser, seen } = await boot()
      // This boot's wait has asked, not merely a helper having been built.
      await vi.waitFor(() => expect(release).toBeDefined())
      await new Promise((r) => setTimeout(r, 200))
      expect(seen).not.toContain('device:ready')
      release!(true)
      await vi.waitFor(() => expect(seen).toContain('device:ready'), { timeout: 1000 })
      agent.disconnect()
      browser.close()
    })

    // A shutdown during the wait stops the helper, which ends the wait with `false`; the boot must be abandoned there,
    // not carry on to announce a device that was just shut down. Holds the order of the wait and the seq check.
    it('is not sent for a boot a shutdown abandoned during the wait', async () => {
      let release: ((ready: boolean) => void) | undefined
      touchGate.ready = () => new Promise((resolve) => { release = resolve })
      const { agent, browser, seen } = await boot()
      // This boot's wait has asked, not merely a helper having been built.
      await vi.waitFor(() => expect(release).toBeDefined())
      // Past the local stream connect, so the shutdown lands while the boot is waiting on the helper alone.
      await new Promise((r) => setTimeout(r, 300))
      browser.send(JSON.stringify({ type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(seen).toContain('device:shutdown-done'), { timeout: 2000 })
      release!(false)
      await new Promise((r) => setTimeout(r, 200))
      expect(seen).not.toContain('device:ready')
      agent.disconnect()
      browser.close()
    })

    // A helper being replaced past its own start-up deadline must not leave a device with a picture and no answer.
    it('is sent anyway once the wait runs out', async () => {
      touchGate.ready = () => new Promise(() => {})
      const { agent, browser, seen } = await boot({ touchReadyWaitMs: 100 })
      await vi.waitFor(() => expect(seen).toContain('device:ready'), { timeout: 2000 })
      agent.disconnect()
      browser.close()
    })
  })

  // A client turns a tree point into a touch point by the app's turn; a multi-panel device gets none (#1116).
  describe('ui:tree:response carries the app\'s interface turn', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it.each([[false, 270], [true, undefined]] as const)('multi-panel %s → interfaceTurn %s', async (multiPanel, expected) => {
      vi.spyOn(XCUITreeReader.prototype, 'warm').mockImplementation(() => {})
      vi.spyOn(XCUITreeReader.prototype, 'readWithTurn').mockResolvedValue({ elements: [], interfaceTurn: 270 })
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId, clientKind: 'flow-runner' }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-tree', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      // Driven at the agent's dispatcher: the relay sends `ui:tree:request` for an HTTP caller, not a browser one.
      const internals = agent as unknown as {
        lastBundleIds: Map<string, string>
        multiPanelDevices: Set<string>
        handleRelayMessage(msg: { type: string; sessionId: string; requestId?: string }): void
        sendMsg(msg: { type: string }): void
      }
      internals.lastBundleIds.set('dev-1', 'com.app')
      if (multiPanel) internals.multiPanelDevices.add('dev-1')
      const sent: Array<{ type: string; interfaceTurn?: number }> = []
      const real = internals.sendMsg.bind(agent)
      internals.sendMsg = (msg) => { sent.push(msg); real(msg as never) }
      internals.handleRelayMessage({ type: 'ui:tree:request', sessionId: agent.sessionId!, requestId: 'rq-t' })
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'ui:tree:response')).toBe(true), { timeout: 2000 })
      const reply = sent.find((m) => m.type === 'ui:tree:response')!
      expect(reply.interfaceTurn).toBe(expected)
      if (expected === undefined) expect(reply).not.toHaveProperty('interfaceTurn')

      agent.disconnect()
      browser.close()
    })
  })

  // Flow Capture (#1135) and the keyboard reset (#1134), driven at the agent's dispatcher as the relay sends them.
  describe('the focused field and the keyboard language', () => {
    afterEach(() => { vi.restoreAllMocks() })

    type Internals = {
      lastBundleIds: Map<string, string>
      handleRelayMessage(msg: { type: string; sessionId: string; requestId?: string }): void
      sendMsg(msg: { type: string }): void
    }
    async function bootedAgent(simctl: SimctlWrapper = mockSimctl(true), boot = true) {
      vi.spyOn(XCUITreeReader.prototype, 'warm').mockImplementation(() => {})
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId, clientKind: 'dashboard' }))
      await waitForType(browser, 'session:joined')
      const internals = agent as unknown as Internals
      const sent: Array<{ type: string; [k: string]: unknown }> = []
      const real = internals.sendMsg.bind(agent)
      internals.sendMsg = (msg) => { sent.push(msg as never); real(msg as never) }
      const doBoot = async () => {
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-k', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
        await waitForType(browser, 'device:ready')
      }
      if (boot) await doBoot()
      return { agent, browser, internals, sent, doBoot }
    }

    it('answers a field read with the runner\'s field, for the app last installed or launched', async () => {
      const readField = vi.spyOn(XCUITreeReader.prototype, 'readField').mockResolvedValue({ field: { identifier: 'form.email', placeholder: 'Email', frame: { x: 0, y: 0, width: 1, height: 1 }, secure: false, value: '안녕' } })
      const { agent, browser, internals, sent } = await bootedAgent()
      internals.lastBundleIds.set('dev-1', 'com.app')
      internals.handleRelayMessage({ type: 'ui:field:request', sessionId: agent.sessionId!, requestId: 'rq-f' })
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'ui:field:response')).toBe(true), { timeout: 2000 })
      expect(readField).toHaveBeenCalledWith('dev-1', 'com.app')
      expect(sent.find((m) => m.type === 'ui:field:response')).toMatchObject({ requestId: 'rq-f', field: { value: '안녕' } })
      agent.disconnect()
      browser.close()
    })

    it('answers a failed read rather than going silent', async () => {
      vi.spyOn(XCUITreeReader.prototype, 'readField').mockRejectedValue(new Error('runner gone'))
      const { agent, browser, internals, sent } = await bootedAgent()
      internals.handleRelayMessage({ type: 'ui:field:request', sessionId: agent.sessionId!, requestId: 'rq-f' })
      await vi.waitFor(() => expect(sent.find((m) => m.type === 'ui:field:response')).toMatchObject({ field: null, reason: 'failed' }), { timeout: 2000 })
      agent.disconnect()
      browser.close()
    })

    it('reads the app an install put on the device, which a person may open from its icon rather than with Launch', async () => {
      const readField = vi.spyOn(XCUITreeReader.prototype, 'readField').mockResolvedValue({ field: null, reason: 'no-focus' })
      const { agent, browser, internals, sent } = await bootedAgent()
      ;(agent as unknown as { installBuild: () => Promise<void> }).installBuild = async () => {}
      internals.handleRelayMessage({ type: 'app:install', sessionId: agent.sessionId!, requestId: 'rq-i', payload: { filePath: '/b.zip', bundleId: 'com.installed' } } as never)
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'app:install-done')).toBe(true), { timeout: 2000 })
      internals.handleRelayMessage({ type: 'ui:field:request', sessionId: agent.sessionId!, requestId: 'rq-f' })
      await vi.waitFor(() => expect(readField).toHaveBeenCalledWith('dev-1', 'com.installed'), { timeout: 2000 })
      agent.disconnect()
      browser.close()
    })

    it('warms the tree runner on a boot for a person Flow Capture records, as it does for an automation client', async () => {
      const { agent, browser, internals } = await bootedAgent(mockSimctl(true), false)
      const warm = vi.mocked(XCUITreeReader.prototype.warm)
      warm.mockClear()
      internals.handleRelayMessage({ type: 'device:boot', sessionId: agent.sessionId!, requestId: 'rq-r', payload: { deviceId: 'dev-1', recorded: true } } as never)
      await vi.waitFor(() => expect(warm).toHaveBeenCalledWith('dev-1'), { timeout: 3000 })
      agent.disconnect()
      browser.close()
    })

    it('resets the keyboard of a booted device once its boot\'s keyboard sync is done', async () => {
      const simctl = mockSimctl(true)
      let finishSync!: () => void
      ;(simctl.syncKeyboardsFromLanguages as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<void>((r) => { finishSync = r }))
      const { agent, browser, internals } = await bootedAgent(simctl)
      internals.handleRelayMessage({ type: 'device:keyboard-reset', sessionId: agent.sessionId! })
      await new Promise((r) => setTimeout(r, 50))
      expect(simctl.resetKeyboardLanguage).not.toHaveBeenCalled()
      finishSync()
      await vi.waitFor(() => expect(simctl.resetKeyboardLanguage).toHaveBeenCalledWith('dev-1'), { timeout: 2000 })
      agent.disconnect()
      browser.close()
    })

    it('carries the keyboard language beside the field', async () => {
      vi.spyOn(XCUITreeReader.prototype, 'readField').mockResolvedValue({ field: null, reason: 'no-focus', keyboard: { shown: true } })
      const simctl = mockSimctl(true)
      ;(simctl.keyboardLanguage as ReturnType<typeof vi.fn>).mockResolvedValue('ko_KR@sw=Korean;hw=Automatic')
      const { agent, browser, internals, sent } = await bootedAgent(simctl)
      internals.lastBundleIds.set('dev-1', 'com.app')
      internals.handleRelayMessage({ type: 'ui:field:request', sessionId: agent.sessionId!, requestId: 'rq-fl' })
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'ui:field:response')).toBe(true), { timeout: 2000 })
      expect(sent.find((m) => m.type === 'ui:field:response')).toMatchObject({
        requestId: 'rq-fl', keyboard: { shown: true }, language: 'ko_KR@sw=Korean;hw=Automatic',
      })
      agent.disconnect()
      browser.close()
    })

    it('answers ui:keyboard:request from the runner, and unknown when it fails', async () => {
      const read = vi.spyOn(XCUITreeReader.prototype, 'readKeyboard').mockResolvedValueOnce({ shown: false }).mockRejectedValueOnce(new Error('gone'))
      const { agent, browser, internals, sent } = await bootedAgent()
      internals.lastBundleIds.set('dev-1', 'com.app')
      internals.handleRelayMessage({ type: 'ui:keyboard:request', sessionId: agent.sessionId!, requestId: 'rq-k1' })
      internals.handleRelayMessage({ type: 'ui:keyboard:request', sessionId: agent.sessionId!, requestId: 'rq-k2' })
      await vi.waitFor(() => expect(sent.filter((m) => m.type === 'ui:keyboard:response')).toHaveLength(2), { timeout: 2000 })
      expect(read).toHaveBeenCalledWith('dev-1', 'com.app')
      expect(sent.find((m) => m.requestId === 'rq-k1')).toMatchObject({ keyboard: { shown: false } })
      expect(sent.find((m) => m.requestId === 'rq-k2')).toMatchObject({ keyboard: { shown: null } })
      agent.disconnect()
      browser.close()
    })

    // #1135: a replay's starting keyboard, answered so the replay launches the app only after it.
    it('sets a named keyboard once the boot\'s keyboard sync is done, and answers', async () => {
      const simctl = mockSimctl(true)
      let finishSync!: () => void
      ;(simctl.syncKeyboardsFromLanguages as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<void>((r) => { finishSync = r }))
      const { agent, browser, internals, sent } = await bootedAgent(simctl)
      internals.handleRelayMessage({ type: 'device:keyboard-set', sessionId: agent.sessionId!, requestId: 'rq-ks', payload: { keyboard: 'ko_KR@sw=Korean;hw=Automatic' } } as never)
      await new Promise((r) => setTimeout(r, 50))
      expect(simctl.setKeyboardLanguage).not.toHaveBeenCalled()
      finishSync()
      await vi.waitFor(() => expect(sent.find((m) => m.type === 'device:keyboard-set-done')).toMatchObject({ requestId: 'rq-ks' }), { timeout: 2000 })
      expect(simctl.setKeyboardLanguage).toHaveBeenCalledWith('dev-1', 'ko_KR@sw=Korean;hw=Automatic')
      agent.disconnect()
      browser.close()
    })

    it('answers an error for a keyboard the device does not have', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.setKeyboardLanguage as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      const { agent, browser, internals, sent } = await bootedAgent(simctl)
      internals.handleRelayMessage({ type: 'device:keyboard-set', sessionId: agent.sessionId!, requestId: 'rq-ks2', payload: {} } as never)
      await vi.waitFor(() => expect(sent.find((m) => m.type === 'device:keyboard-set-error')).toMatchObject({ requestId: 'rq-ks2', reason: 'failed' }), { timeout: 2000 })
      expect(simctl.setKeyboardLanguage).toHaveBeenCalledWith('dev-1', undefined)
      agent.disconnect()
      browser.close()
    })

    it('holds a reset that arrives before the boot, and does it once the device is up', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser, internals, doBoot } = await bootedAgent(simctl, false)
      internals.handleRelayMessage({ type: 'device:keyboard-reset', sessionId: agent.sessionId! })
      expect(simctl.resetKeyboardLanguage).not.toHaveBeenCalled()
      await doBoot()
      await vi.waitFor(() => expect(simctl.resetKeyboardLanguage).toHaveBeenCalledTimes(1), { timeout: 2000 })
      agent.disconnect()
      browser.close()
    })
  })

  // The relay tags a boot `automation` when a flow runner or MCP client holds the session; the agent then starts
  // the UI-tree runner so the first selector step does not spend its cold start. A dashboard boot never does: the
  // runner costs about 650 MB per device, and manual testing never reads the tree.
  describe('UI-tree runner warm-up on boot', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it.each([['flow-runner', 1], ['dashboard', 0]] as const)('warms on a boot by a %s holder: %i call(s)', async (clientKind, calls) => {
      const warm = vi.spyOn(XCUITreeReader.prototype, 'warm').mockImplementation(() => {})
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId, clientKind }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-warm', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      expect(warm).toHaveBeenCalledTimes(calls)
      if (calls) expect(warm).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })
 
    // `test-without-building` boots its destination, so a runner still starting for the device would bring it back up
    // between our shutdown and the erase, which refuses anything but a shut-down device.
    it('stops the device\'s runner before an erase boot shuts the device down', async () => {
      const stopIfDevice = vi.spyOn(XCUITreeReader.prototype, 'stopIfDevice')
      const simctl = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-erase', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', resetMode: 'full-erase' } }))
      await waitForType(browser, 'device:ready')

      expect(stopIfDevice).toHaveBeenCalledWith('dev-1')
      const shutdownOrder = (simctl.shutdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(stopIfDevice.mock.invocationCallOrder[0]!).toBeLessThan(shutdownOrder)

      agent.disconnect()
      browser.close()
    })
  })

  // iPhone Duo (Xcode 27.1): more than one integrated panel. Its input goes through the in-simulator
  // guest-helper, never the Indigo TouchHelper, whose writes answer success there and land nowhere.
  describe('a multi-panel device', () => {
    type GuestProc = EventEmitter & {
      pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>
      stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    }
    const COVER = 'COVER-UUID'
    const OPEN = 'OPEN-UUID'
    // A guest-helper that comes up ready and answers every done-command, recording what it was told.
    // The device the fakes describe: which panel is lit and which way the device is held. The helper's commands
    // move it the way the Duo does (measured, M1): past 90° the unfolded panel lights, a fold leaves the way it
    // is held alone, and each `orient` label is the physical orientation of the same name on either panel.
    const HELD: Record<string, DeviceOrientation> = {
      portrait: 'portrait', 'landscape-right': 'landscapeRight', pud: 'portraitUpsideDown', 'landscape-left': 'landscapeLeft',
    }
    const heldAs = (held: () => string) => new PhysicalOrientation({ readOrientation: async () => ({ result: { deviceOrientation: held() } }) })
    function duoWorld() {
      const world: { open: boolean; held: DeviceOrientation; reads: number } = { open: false, held: 'portrait', reads: 0 }
      const panelState = new PanelState({ readDisplays: async () => (world.reads++, { result: { displays: [
        { name: 'LCD', displayId: 1, active: !world.open, currentOrientation: 'rot0', type: { integrated: {} } },
        { name: 'LCD-1', displayId: 3, active: world.open, currentOrientation: 'rot90', type: { integrated: {} } },
      ] } }) }, 300)
      const physical = heldAs(() => world.held)
      const onCommand = (line: string) => {
        const [cmd, a, b] = line.trim().split(' ')
        if (cmd === 'hinge') { world.open = Number(b) > 90; void a }
        if (cmd === 'orient') world.held = HELD[a]
      }
      return { world, panelState, physical, onCommand }
    }
    function guestNative(opts: { fatal?: string; unavailable?: string; onCommand?: (line: string) => void; unanswered?: string[]; silent?: boolean } = {}) {
      const procs: GuestProc[] = []
      let readied = 0
      const native = {
        spawn: vi.fn<GuestHelperNative['spawn']>(() => {
          const proc = new EventEmitter() as GuestProc
          proc.pid = 50_000 + procs.length
          proc.stdout = new EventEmitter()
          proc.stderr = new EventEmitter()
          proc.kill = vi.fn(() => true)
          proc.stdin = Object.assign(new EventEmitter(), {
            writable: true,
            end: vi.fn(),
            write: vi.fn((line: string) => {
              opts.onCommand?.(line)
              const cmd = line.split(' ')[0]
              if (cmd !== 'touch' && cmd !== 'pinch' && !opts.unanswered?.includes(cmd)) setImmediate(() => proc.stdout.emit('data', Buffer.from(`done 0 ${cmd}\n`)))
              return true
            }),
          }) as never
          setImmediate(() => {
            if (opts.fatal) { proc.stdout.emit('data', Buffer.from(`fatal ${opts.fatal}\n`)); proc.stdin.writable = false; proc.emit('exit', 3); return }
            // Silent: running, and never ready — what a helper stalled in its device lookup looks like.
            if (opts.silent) { proc.stdout.emit('data', Buffer.from(`pid ${proc.pid + 1}\n`)); return }
            proc.stdout.emit('data', Buffer.from(`pid ${proc.pid + 1}\nready\n`)); readied++
          })
          procs.push(proc)
          return proc as never
        }),
        findOrphans: vi.fn<GuestHelperNative['findOrphans']>(async () => []),
        killPid: vi.fn<GuestHelperNative['killPid']>(),
        unavailableReason: vi.fn<GuestHelperNative['unavailableReason']>(async () => opts.unavailable ?? null),
      }
      const lines = () => procs.flatMap((p) => p.stdin.write.mock.calls.map((c) => String(c[0]).trim()))
      // Ready, and a tick later for the devicectl reading that says which panel is lit.
      const ready = async () => {
        await vi.waitFor(() => expect(readied).toBeGreaterThan(0))
        await new Promise((r) => setTimeout(r, 20))
      }
      return { native, procs, lines, ready }
    }
    // devicectl: the Duo is folded, so the cover (display 1) is lit.
    const folded = () => new PanelState({ readDisplays: async () => ({ result: { displays: [
      { name: 'LCD', displayId: 1, active: true, currentOrientation: 'rot0', type: { integrated: {} } },
      { name: 'LCD-1', displayId: 3, active: false, currentOrientation: 'rot90', type: { integrated: {} } },
    ] } }) })
    const unfolded = (rotation: string) => new PanelState({ readDisplays: async () => ({ result: { displays: [
      { name: 'LCD', displayId: 1, active: false, currentOrientation: 'rot0', type: { integrated: {} } },
      { name: 'LCD-1', displayId: 3, active: true, currentOrientation: rotation, type: { integrated: {} } },
    ] } }) })
    function duoSimctl(panels = 2, booted = true): SimctlWrapper {
      const sw = mockSimctl(booted)
      Object.assign(sw, {
        integratedPanelCounts: vi.fn(async () => new Map([['type-iphone-15', panels]])),
        // The Duo's capabilities: the unfolded panel is drawn turned 270.
        typePanels: vi.fn(async () => [
          { deviceName: 'primary', chromeId: 'com.apple.dt.devicekit.chrome.phone15', width: 1398, height: 2034, scale: 3, nativeOrientation: 0 },
          { deviceName: 'primary-1', chromeId: 'com.apple.dt.devicekit.chrome.phone14', width: 2007, height: 2853, scale: 3, nativeOrientation: 270 },
        ]),
        integratedScreens: vi.fn(async () => [
          { screenId: 1, uuid: COVER, deviceName: 'primary', width: 1398, height: 2034, scale: 3, chromeId: 'com.apple.dt.devicekit.chrome.phone15' },
          { screenId: 3, uuid: OPEN, deviceName: 'primary-1', width: 2007, height: 2853, scale: 3, chromeId: 'com.apple.dt.devicekit.chrome.phone14' },
        ]),
      })
      return sw
    }
    // A frame per panel, told apart by the chrome the loader was asked for; the model's frame has none.
    // Each panel's expanded composite, at 2×: the unfolded frame is drawn turned (native 270), so it is wide.
    const COMPOSITES: Record<string, [number, number]> = { phone15: [1000, 1450], phone14: [2000, 1420], model: [1000, 1450] }
    const chromeOf = (name: string) =>
      ({ framePng: name, compositeWidth: COMPOSITES[name]?.[0], compositeHeight: COMPOSITES[name]?.[1] } as unknown as ChromeData)
    function panelChromes() {
      return { load: vi.fn(async (_type: string, panel?: { chromeId: string }) => chromeOf(panel?.chromeId.split('.').pop() ?? 'model')) } as unknown as DeviceChromeLoader
    }
    async function bootedDuo(opts: {
      panels?: number; boot?: boolean; captureHelper?: boolean; chromeLoader?: DeviceChromeLoader
      panelState?: PanelState; physical?: PhysicalOrientation; world?: ReturnType<typeof duoWorld>
      fatal?: string; unavailable?: string; booted?: boolean; pollMs?: number; unanswered?: string[]
      idlePollMs?: number; quietMs?: number; silent?: boolean; helperBootReadyMs?: number
    } = {}) {
      const guest = guestNative({ fatal: opts.fatal, unavailable: opts.unavailable, onCommand: opts.world?.onCommand, unanswered: opts.unanswered, silent: opts.silent })
      const simctl = duoSimctl(opts.panels, opts.booted)
      const browser = new WebSocket(`ws://localhost:${port}`)
      // Everything the viewer receives, from the start: some messages (a re-sent chrome) can land during the boot.
      const received: Array<{ type: string; payload?: unknown }> = []
      browser.on('message', (d, isBinary) => {
        // Binary frames are the stream; a throw here would break the socket for every other listener.
        if (isBinary) return
        try { received.push(JSON.parse(String(d))) } catch { /* not a control message */ }
      })
      await waitForOpen(browser)
      // `intervalMs` selects the MJPEG fallback; leaving it out takes the capture-helper path a real agent uses.
      const agent = new IOSAgent({
        ...(opts.captureHelper ? {} : { intervalMs: 50 }), guestHelperNative: guest.native,
        panelState: opts.panelState ?? opts.world?.panelState ?? folded(), foldSettleMs: 500, panelPollMs: opts.pollMs ?? 50,
        ...(opts.idlePollMs ? { panelIdlePollMs: opts.idlePollMs } : {}), ...(opts.quietMs ? { panelQuietMs: opts.quietMs } : {}),
        ...(opts.helperBootReadyMs ? { helperBootReadyMs: opts.helperBootReadyMs } : {}),
        physicalOrientation: opts.physical ?? opts.world?.physical ?? heldAs(() => 'portrait'),
        ...(opts.chromeLoader ? { chromeLoader: opts.chromeLoader } : {}),
      }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      if (opts.boot !== false && !opts.fatal && !opts.unavailable) {
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
        await waitForType(browser, 'device:ready')
      }
      return { agent, browser, guest, simctl, received }
    }
    const tap = (browser: WebSocket, sessionId: string, requestId: string) => {
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId, sessionId, payload: { x: 0.5, y: 0.5 } }))
    }

    beforeEach(() => { MockTouchHelper.mockClear() })

    it('taps the lit panel through guest-helper and never builds an Indigo channel', async () => {
      const { agent, browser, guest } = await bootedDuo()
      await guest.ready()
      const done = waitForType(browser, 'input:done')
      tap(browser, agent.sessionId!, 'rq-duo-tap')
      expect((await done).requestId).toBe('rq-duo-tap')
      expect(guest.lines()).toEqual(expect.arrayContaining([`touch ${COVER} d 0.5 0.5 0`, `touch ${COVER} u 0.5 0.5 0`]))
      expect(guest.native.spawn.mock.calls[0][1]).toEqual(['--udid', 'dev-1', '--touchscreen', COVER, '--touchscreen', OPEN])
      expect(MockTouchHelper).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('pastes typed text with a guest ⌘V, not an Indigo key the Duo drops', async () => {
      const { agent, browser, guest, simctl } = await bootedDuo()
      await guest.ready()
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-duo-type', sessionId: agent.sessionId, payload: { text: 'hi' } }))
      await done
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', 'hi')
      expect(guest.lines()).toContain('key 7 25 100 7 227')
      expect(MockTouchHelper).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('takes the guest-helper path on a session that was never booted by this agent (an agent restart)', async () => {
      const { agent, browser, guest } = await bootedDuo({ boot: false })
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      await vi.waitFor(() => expect(guest.procs).toHaveLength(1))
      expect(MockTouchHelper).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('stops the helper when the device is shut down, but not when the relay connection is rebuilt', async () => {
      const { agent, browser, guest } = await bootedDuo()
      await vi.waitFor(() => expect(guest.procs).toHaveLength(1))
      const proc = guest.procs[0]
      const internal = agent as unknown as { cleanupDeviceState(s: unknown): void; deviceStates: Map<string, unknown> }
      internal.cleanupDeviceState(internal.deviceStates.get(agent.sessionId!))
      expect(proc.stdin.end).not.toHaveBeenCalled()
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-off', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(proc.stdin.end).toHaveBeenCalled())
      agent.disconnect()
      browser.close()
    })

    it('points the capture at the lit panel once the helper has read the panels', async () => {
      const MockCapture = vi.mocked(ScreenCaptureStreamer)
      MockCapture.mockClear()
      const { agent, browser, guest } = await bootedDuo({ captureHelper: true })
      await guest.ready()
      // Whichever came first — the stream or the panels — the capture must end up on the cover: built with it,
      // or switched to it afterwards. Before this, the largest panel was captured, which is dark while folded.
      await vi.waitFor(() => {
        expect(MockCapture).toHaveBeenCalled()
        const last = MockCapture.mock.results.length - 1
        const switched = (MockCapture.mock.results[last].value as { selectPanel: ReturnType<typeof vi.fn> }).selectPanel.mock.calls
        const panel = switched.length ? switched.at(-1)![0] : MockCapture.mock.calls[last][4]
        expect(panel).toEqual({ width: 1398, height: 2034 })
      })
      agent.disconnect()
      browser.close()
    })

    it('sends the lit panel\'s own frame once the panels are known', async () => {
      const chromeLoader = panelChromes()
      const { agent, browser, guest, received } = await bootedDuo({ chromeLoader })
      const chromes = () => received.filter((m) => m.type === 'session:chrome').map((m) => (m.payload as { framePng: string }).framePng)
      await guest.ready()
      await vi.waitFor(() => expect(chromes().at(-1)).toBe('phone15'))
      // The folded Duo shows its cover upright, and says so; a single-panel device never carries the field.
      const last = received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { streamRotation?: number }
      expect(last.streamRotation).toBe(0)
      expect(vi.mocked(chromeLoader.load)).toHaveBeenCalledWith('type-iphone-15', { chromeId: 'com.apple.dt.devicekit.chrome.phone15', width: 466, height: 678 })
      agent.disconnect()
      browser.close()
    })

    // An order the tests above leave to timing, forced. Mutation: drop the re-send at the end of the boot (a
    // frame the helper settled first is overwritten by the model's). The capture switch has no such order to
    // force any more: the boot waits for the helper, which reads the panels first, so a stream always starts
    // knowing them — a fold is what switches it, and the unfold test below holds that.
    it('ends on the lit panel\'s frame when the panels are known before the boot\'s frame has loaded', async () => {
      let releaseModel: () => void = () => {}
      const modelHeld = new Promise<void>((r) => { releaseModel = r })
      const chromeLoader = { load: vi.fn(async (_t: string, panel?: { chromeId: string }) => {
        if (!panel) await modelHeld
        return chromeOf(panel?.chromeId.split('.').pop() ?? 'model')
      }) } as unknown as DeviceChromeLoader
      const guest = guestNative()
      const simctl = duoSimctl()
      const browser = new WebSocket(`ws://localhost:${port}`)
      const chromes: string[] = []
      browser.on('message', (d, isBinary) => {
        if (isBinary) return
        try { const m = JSON.parse(String(d)); if (m.type === 'session:chrome') chromes.push(m.payload.framePng) } catch { /* not control */ }
      })
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50, guestHelperNative: guest.native, panelState: folded(), chromeLoader }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-race', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await guest.ready()
      await new Promise((r) => setTimeout(r, 50))
      releaseModel()
      await vi.waitFor(() => expect(chromes.at(-1)).toBe('phone15'))
      agent.disconnect()
      browser.close()
    })

    // Mutation: drop the panel's native turn (the unfolded panel would be drawn a quarter off DeviceHub's).
    it('turns the unfolded panel by the way the device is held plus its own native turn, and says nothing while that is unread', async () => {
      for (const [held, expected] of [['portrait', 90], ['landscapeRight', 180], ['portraitUpsideDown', 270], ['landscapeLeft', 0], ['sideways', undefined]] as const) {
        const { agent, browser, guest, received } = await bootedDuo({ chromeLoader: panelChromes(), panelState: unfolded('rot0'), physical: heldAs(() => held) })
        await guest.ready()
        await vi.waitFor(() => expect((received.filter((m) => m.type === 'session:chrome').at(-1)?.payload as { framePng?: string })?.framePng).toBe('phone14'))
        const last = received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { streamRotation?: number }
        expect(last.streamRotation, held).toBe(expected)
        expect('streamRotation' in last, held).toBe(expected !== undefined)
        agent.disconnect()
        browser.close()
      }
    })

    const postures = (received: Array<{ type: string; payload?: unknown }>) =>
      received.filter((m) => m.type === 'device:postures').map((m) => m.payload as { postures: Array<{ id: string }>; currentId: string | null })

    // A viewer draws a foldable's skeleton while it boots, and could only know from this. Mutation: report
    // the product family alone (the Duo is an iPhone).
    it('registers a multi-panel device as foldable', async () => {
      const agent = new IOSAgent({ guestHelperNative: guestNative().native }, duoSimctl())
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')
      const sessions = listed.sessions as Array<{ devices: Array<{ formFactor?: string }> }>
      expect(sessions[0]?.devices[0]?.formFactor).toBe('foldable')
      agent.disconnect()
      browser.close()
    })

    it('offers Folded and Unfolded once the helper is ready, and says it is folded', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world })
      await vi.waitFor(() => expect(postures(received).at(-1)).toEqual({ postures: [{ id: 'closed', label: 'Folded' }, { id: 'open', label: 'Unfolded' }], currentId: 'closed' }))
      agent.disconnect()
      browser.close()
    })

    // DeviceHub draws the cover at half the unfolded device; sized by its own frame, each panel filled the
    // viewer's height. And from the first frame: one that came without it was drawn large and then shrank.
    // Mutations: leave it out; take the lit panel's own size; take the height alone (the unfolded frame is
    // wide); send the first frame before the scale is known.
    it('sizes every panel by the largest panel, on either, from the first frame', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes(), pollMs: 600_000 })
      const sent = () => received.filter((m) => m.type === 'session:chrome').map((m) => m.payload as ChromeData)
      const last = () => sent().at(-1)!
      await vi.waitFor(() => expect(last()).toMatchObject({ framePng: 'phone15', scaleBasis: 2000 }))
      expect(sent().map((c) => c.scaleBasis)).not.toContain(undefined)
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'open' } }))
      await vi.waitFor(() => expect(last()).toMatchObject({ framePng: 'phone14', scaleBasis: 2000 }))
      agent.disconnect()
      browser.close()
    })

    // On a loaded Mac the helper answered a fold after its panel had lit. Mutation: wait for the answer
    // before watching the panel (the fold would be reported failed, the device having folded).
    it('takes a lit panel as the fold done, whether or not the helper has answered', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes(), pollMs: 600_000, unanswered: ['hinge'] })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'open' } }))
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('open'))
      await vi.waitFor(() => expect((received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { framePng: string }).framePng).toBe('phone14'))
      agent.disconnect()
      browser.close()
    })

    it('unfolds: sweeps the hinge, waits for the panel, turns nothing, and follows it', async () => {
      const world = duoWorld()
      const MockCapture = vi.mocked(ScreenCaptureStreamer)
      MockCapture.mockClear()
      // The poll is effectively off: the fold must point the capture and the frame by itself, not leave it to
      // the next read (2 s in production).
      const { agent, browser, guest, received } = await bootedDuo({ world, captureHelper: true, chromeLoader: panelChromes(), pollMs: 600_000 })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'open' } }))
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('open'))
      // Flat, DeviceHub's fully open pose — not its half-open 130°. Mutation: sweep to 130.
      expect(guest.lines()).toContain('hinge 0 180 800')
      expect(guest.lines().filter((l) => l.startsWith('orient'))).toEqual([])
      // Held upright, the unfolded panel shows turned 90 — its native turn, which is how DeviceHub draws it.
      await vi.waitFor(() => expect(received.filter((m) => m.type === 'session:chrome').at(-1)!.payload).toMatchObject({ framePng: 'phone14', streamRotation: 90 }))
      const capture = MockCapture.mock.results.at(-1)!.value as { selectPanel: ReturnType<typeof vi.fn> }
      expect(capture.selectPanel).toHaveBeenLastCalledWith({ width: 2007, height: 2853 })
      // And back.
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'closed' } }))
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      expect(guest.lines()).toContain('hinge 180 0 800')
      agent.disconnect()
      browser.close()
    })

    it('reports where the device really is when a fold does not land', async () => {
      const world = duoWorld()
      // A world whose hinge does nothing: the panel never changes, so the fold times out.
      const stuck = { ...world, onCommand: () => {} }
      const { agent, browser, received } = await bootedDuo({ world: stuck })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      const before = postures(received).length
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'open' } }))
      await vi.waitFor(() => expect(postures(received).length).toBeGreaterThan(before), { timeout: 3000 })
      expect(postures(received).at(-1)?.currentId).toBe('closed')
      agent.disconnect()
      browser.close()
    })

    it('hides the fold control everywhere when the helper is gone for good', async () => {
      const world = duoWorld()
      const { agent, browser, guest, received } = await bootedDuo({ world })
      await vi.waitFor(() => expect(postures(received).at(-1)?.postures).toHaveLength(2))
      // Three deaths in the window exhaust the respawn budget.
      for (let n = 1; n <= 3; n++) {
        await vi.waitFor(() => expect(guest.procs).toHaveLength(n))
        await guest.ready()
        const proc = guest.procs[n - 1]
        proc.stdin.writable = false
        proc.emit('exit', 1)
      }
      await vi.waitFor(() => expect(postures(received).at(-1)).toEqual({ postures: [], currentId: null }))
      agent.disconnect()
      browser.close()
    })

    // The model's frame and a panel's are loaded separately, and a model frame that failed left the session with
    // no frame for good: the lit panel's was never sent. Mutation: gate the re-send on a loaded frame again.
    it('sends the lit panel\'s frame when the model\'s did not load', async () => {
      const loader = { load: vi.fn(async (_type: string, panel?: { chromeId: string }) => (panel ? chromeOf(panel.chromeId.split('.').pop()!) : null)) } as unknown as DeviceChromeLoader
      const { agent, browser, received } = await bootedDuo({ world: duoWorld(), chromeLoader: loader })
      await vi.waitFor(() => expect(received.filter((m) => m.type === 'session:chrome').map((m) => (m.payload as { framePng: string }).framePng)).toContain('phone15'))
      agent.disconnect()
      browser.close()
    })

    // A run replays from the same orientation; the single-panel stand-up skips a multi-panel device, so its own
    // runs it through the helper. Mutation: drop it.
    it('turns a Duo upright for a run, through its helper', async () => {
      const world = duoWorld()
      world.world.held = 'landscapeRight'
      const { agent, browser, guest, received } = await bootedDuo({ world, chromeLoader: panelChromes(), boot: false })
      const ok = vi.fn(async () => {})
      const sim = (agent as unknown as { simctl: Record<string, unknown> }).simctl
      Object.assign(sim, { uninstallAppForReset: ok, clearAppDataIfInstalled: ok, waitForBootStatus: ok, resetKeychain: ok, resetPrivacy: ok, clearLocation: ok })
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-run', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', runReset: { uninstall: [], clear: [] } } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(world.world.held).toBe('portrait'))
      expect(guest.lines()).toContain('orient portrait')
      // And re-described as upright. The re-send after the turn makes it immediate; the panel poll `turnHeld` re-arms
      // would get there within its interval too, so this holds the end state and not the re-send itself.
      await vi.waitFor(() => expect((received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { streamRotation?: number }).streamRotation).toBe(0))
      agent.disconnect()
      browser.close()
    })

    // A newer boot can land while a run's stand-up waits in the rotation queue. The superseded run neither turns nor
    // goes on to open a stream over the newer boot's. Mutation: drop the bootSeq checks around the turn.
    it('drops a run\'s stand-up when a newer boot supersedes it while the turn waits', async () => {
      const world = duoWorld()
      world.world.held = 'landscapeRight'
      const { agent, browser, guest } = await bootedDuo({ world, chromeLoader: panelChromes(), boot: false })
      const ok = vi.fn(async () => {})
      const sim = (agent as unknown as { simctl: Record<string, unknown> }).simctl
      Object.assign(sim, { uninstallAppForReset: ok, clearAppDataIfInstalled: ok, waitForBootStatus: ok, resetKeychain: ok, resetPrivacy: ok, clearLocation: ok })
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      void (agent as unknown as { enqueueRotation(id: string, step: () => Promise<void>): Promise<void> }).enqueueRotation('dev-1', () => gate)
      const superseded = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-run', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', runReset: { uninstall: [], clear: [] } } }))
      await guest.ready()
      await new Promise((r) => setTimeout(r, 50))
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-next', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      const live = [...(agent as unknown as { deviceStates: Map<string, { streamWs: unknown }> }).deviceStates.values()][0]!
      const newer = live.streamWs
      release()
      const e = await superseded
      expect(e['requestId']).toBe('rq-run')
      await new Promise((r) => setTimeout(r, 50))
      // `openStreamWs` assigns the state's socket before it awaits, so a superseded boot reaching it took the newer
      // boot's stream reference — the later bootSeq check answers the request but cannot give the reference back.
      expect(live.streamWs).toBe(newer)
      expect(guest.lines()).not.toContain('orient portrait')
      expect(world.world.held).toBe('landscapeRight')
      agent.disconnect()
      browser.close()
    })

    // The same, one step later: superseded while the turn reads where the device is held, which takes a moment.
    // Mutation: do not ask again after the read.
    it('drops a run\'s stand-up when a newer boot supersedes it during the orientation read', async () => {
      const world = duoWorld()
      world.world.held = 'landscapeRight'
      let hold: Promise<void> | null = null
      let reading = false
      let releaseRead!: () => void
      const physical = new PhysicalOrientation({ readOrientation: async () => {
        if (hold) { const h = hold; hold = null; reading = true; await h }
        return { result: { deviceOrientation: world.world.held } }
      } })
      const { agent, browser, guest } = await bootedDuo({ world, physical, chromeLoader: panelChromes(), boot: false })
      const ok = vi.fn(async () => {})
      const sim = (agent as unknown as { simctl: Record<string, unknown> }).simctl
      Object.assign(sim, { uninstallAppForReset: ok, clearAppDataIfInstalled: ok, waitForBootStatus: ok, resetKeychain: ok, resetPrivacy: ok, clearLocation: ok })
      let releaseQueue!: () => void
      const queued = new Promise<void>((r) => { releaseQueue = r })
      void (agent as unknown as { enqueueRotation(id: string, step: () => Promise<void>): Promise<void> }).enqueueRotation('dev-1', () => queued)
      const superseded = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-run', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', runReset: { uninstall: [], clear: [] } } }))
      await guest.ready()
      await new Promise((r) => setTimeout(r, 50))
      hold = new Promise<void>((r) => { releaseRead = r })
      releaseQueue()
      await vi.waitFor(() => expect(reading).toBe(true))
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-next', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      releaseRead()
      expect((await superseded)['requestId']).toBe('rq-run')
      await new Promise((r) => setTimeout(r, 50))
      expect(guest.lines()).not.toContain('orient portrait')
      agent.disconnect()
      browser.close()
    })

    it('follows a fold made outside tapflow', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes() })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      world.world.open = true // DeviceHub's hinge
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('open'))
      await vi.waitFor(() => expect((received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { framePng: string }).framePng).toBe('phone14'))
      agent.disconnect()
      browser.close()
    })

    // devicectl costs ~0.2 s of CPU a read, so a device left alone is read slowly — and a fold made outside
    // tapflow, seen at the next slow read, brings the fast poll back for the next one.
    // Mutations: never slow down; never come back; not count a change seen by the poll as activity.
    it('reads a device left alone slowly, and quickly again once it moves', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes(), pollMs: 50, idlePollMs: 1_000, quietMs: 300 })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      const readsIn = async (ms: number) => { const from = world.world.reads; await new Promise((r) => setTimeout(r, ms)); return world.world.reads - from }
      await new Promise((r) => setTimeout(r, 500))
      // Fast, that is ~16 reads.
      expect(await readsIn(800)).toBeLessThanOrEqual(3)
      world.world.open = true
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('open'), { timeout: 3_000 })
      // Slow, at most one.
      expect(await readsIn(250)).toBeGreaterThanOrEqual(3)
      agent.disconnect()
      browser.close()
    })

    // A fold or a turn sent from tapflow is someone at the device: the poll is fast again at once, not after
    // the slow wait already scheduled. Mutations: drop either one's activity mark; keep the scheduled wait.
    it.each([
      ['fold', { type: 'input:posture', payload: { postureId: 'open' } }],
      ['turn', { type: 'input:rotate', payload: { direction: 'clockwise' } }],
    ] as const)('reads quickly again after a %s sent from tapflow', async (name, msg) => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes(), pollMs: 50, idlePollMs: 60_000, quietMs: 300 })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      await new Promise((r) => setTimeout(r, 500))
      browser.send(JSON.stringify({ ...msg, sessionId: agent.sessionId }))
      if (name === 'fold') await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('open'))
      else await vi.waitFor(() => expect((received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { streamRotation?: number }).streamRotation).toBe(90))
      const from = world.world.reads
      await new Promise((r) => setTimeout(r, 400))
      // Fast, that is ~8; on the slow wait, none.
      expect(world.world.reads - from).toBeGreaterThanOrEqual(3)
      agent.disconnect()
      browser.close()
    })

    // A Duo coming up from an erase can light its unfolded panel for a few seconds and go back to its cover
    // (measured, PANEL_HOLD_MS); followed, the viewer swapped to a dark panel and back. The test above is the
    // other half: a fold that holds is still followed. Mutation: follow every reading.
    it('does not follow a panel lit only for a moment', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes() })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      const chromes = () => received.filter((m) => m.type === 'session:chrome').map((m) => (m.payload as { framePng: string }).framePng)
      const before = chromes().length
      world.world.open = true
      await new Promise((r) => setTimeout(r, 150))
      world.world.open = false
      await new Promise((r) => setTimeout(r, 600))
      expect(chromes().slice(before)).not.toContain('phone14')
      expect(postures(received).map((p) => p.currentId)).not.toContain('open')
      agent.disconnect()
      browser.close()
    })

    // DeviceHub's rotate-right: a quarter turn from the way the device is read to be held, on either panel.
    // Mutations: turn from a remembered orientation; skip the cover; send the target's landscape when one is met.
    it('turns the device a quarter clockwise from where it is held, on either panel, and waits for it to land', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes() })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      const lastRotation = () => (received.filter((m) => m.type === 'session:chrome').at(-1)!.payload as { streamRotation?: number }).streamRotation
      const clockwise = () => browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { direction: 'clockwise' } }))
      await vi.waitFor(() => expect(lastRotation()).toBe(0))
      clockwise()
      await vi.waitFor(() => expect(lastRotation()).toBe(90))
      expect(world.world.held).toBe('landscapeRight')
      // Turned outside tapflow (DeviceHub) — the next quarter starts from there, not from what was sent.
      world.world.held = 'portraitUpsideDown'
      await vi.waitFor(() => expect(lastRotation()).toBe(180))
      clockwise()
      await vi.waitFor(() => expect(world.world.held).toBe('landscapeLeft'))
      await vi.waitFor(() => expect(lastRotation()).toBe(270))
      // Unfolded, the same hold shows the panel's native turn on top.
      browser.send(JSON.stringify({ type: 'input:posture', sessionId: agent.sessionId, payload: { postureId: 'open' } }))
      await vi.waitFor(() => expect(lastRotation()).toBe(0))
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { direction: 'counterclockwise' } }))
      await vi.waitFor(() => expect(world.world.held).toBe('portraitUpsideDown'))
      await vi.waitFor(() => expect(lastRotation()).toBe(270))
      agent.disconnect()
      browser.close()
    })

    // Mutation: turn from the last reading instead of a fresh one. With the poll off, a turn made in DeviceHub
    // is only learned by reading at the press.
    it('reads the way the device is held at the press, not between polls', async () => {
      const world = duoWorld()
      const { agent, browser, received } = await bootedDuo({ world, chromeLoader: panelChromes(), pollMs: 600_000 })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      world.world.held = 'landscapeLeft'
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { direction: 'clockwise' } }))
      // A quarter clockwise from landscapeLeft is portrait; from the stale portrait it would be landscapeRight.
      await vi.waitFor(() => expect(world.world.held).toBe('portrait'))
      agent.disconnect()
      browser.close()
    })

    it('takes an older viewer\'s target: either landscape meets landscape, portrait means upright', async () => {
      const world = duoWorld()
      world.world.held = 'landscapeLeft'
      const { agent, browser, guest, received } = await bootedDuo({ world, chromeLoader: panelChromes() })
      await vi.waitFor(() => expect(postures(received).at(-1)?.currentId).toBe('closed'))
      const orients = () => guest.lines().filter((l) => l.startsWith('orient'))
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { orientation: 'landscape' } }))
      await new Promise((r) => setTimeout(r, 150))
      expect(orients()).toEqual([])
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { orientation: 'portrait' } }))
      await vi.waitFor(() => expect(world.world.held).toBe('portrait'))
      // Already upright: nothing is sent.
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { orientation: 'portrait' } }))
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { orientation: 'landscape' } }))
      await vi.waitFor(() => expect(world.world.held).toBe('landscapeRight'))
      expect(orients()).toEqual(['orient portrait', 'orient landscape-right'])
      agent.disconnect()
      browser.close()
    })

    it('fails the boot with the reason when the runtime refuses the helper, and shuts down only a device it brought up', async () => {
      for (const booted of [false, true]) {
        const { agent, browser, simctl } = await bootedDuo({ fatal: 'HIDVirtualEventService missing', booted })
        const err = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-fatal', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
        expect(String((await err).message)).toContain('HIDVirtualEventService missing')
        if (booted) expect(simctl.shutdown).not.toHaveBeenCalled()
        else expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
        agent.disconnect()
        browser.close()
      }
    })

    // A helper that never says `fatal` is relaunched for ever, which a boot cannot wait out. Mutation: wait on
    // `whenReady` alone — the boot never answers.
    it('fails a boot whose helper is never ready, and shuts down only a device it brought up', async () => {
      const { agent, browser, simctl } = await bootedDuo({ silent: true, booted: false, boot: false, helperBootReadyMs: 300 })
      const err = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-silent', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      expect(String((await err).message)).toContain('not ready within 0.3s')
      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
      agent.disconnect()
      browser.close()
    })

    // Quitting DeviceHub shuts every simulator down under tapflow, and the helper serving the old boot stayed
    // registered: the next boot found it, waited on it, and started from the panel lit before. Mutation: drop
    // the stop for a cold boot — the second boot spawns nothing.
    it('gives a device shut down outside tapflow a new helper when it boots again', async () => {
      const { agent, browser, guest, simctl } = await bootedDuo()
      await guest.ready()
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 27.1', typeId: 'type-iphone-15' },
      ])
      const ready = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-again', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await ready
      expect(guest.procs[0].stdin.end).toHaveBeenCalled()
      expect(guest.native.spawn).toHaveBeenCalledTimes(2)
      agent.disconnect()
      browser.close()
    })

    // A socket closing under a boot builds no channel, so there is no helper to wait on; that is not the helper
    // refusing, and a cold device it brought up is not shut down for it. Mutation: treat no helper as a refusal.
    it('does not shut a device down when the relay socket closed before the helper started', async () => {
      const { agent, browser, simctl } = await bootedDuo({ booted: false, boot: false })
      const ws = (agent as unknown as { ws: WebSocket }).ws
      // Closing once the boot is under way — past the entry guard, before the chrome is sent.
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        Object.defineProperty(ws, 'readyState', { get: () => WebSocket.CLOSING, configurable: true })
      })
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-duo-closing', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(simctl.boot).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 300))
      expect(simctl.shutdown).not.toHaveBeenCalled()
      delete (ws as unknown as Record<string, unknown>).readyState
      agent.disconnect()
      browser.close()
    })

    it('does not offer a multi-panel device this Mac cannot drive, and still offers the rest', async () => {
      const guest = guestNative({ unavailable: 'devicectl was not found' })
      const simctl = duoSimctl()
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone Duo', platform: 'ios', status: 'booted', osVersion: 'iOS 27.1', typeId: 'type-iphone-15' },
        { id: 'dev-2', name: 'iPhone 17', platform: 'ios', status: 'booted', osVersion: 'iOS 27.0', typeId: 'type-single' },
      ])
      const sent: unknown[] = []
      const agent = new IOSAgent({ intervalMs: 50, guestHelperNative: guest.native, panelState: folded() }, simctl)
      const internal = agent as unknown as { sendOn(ws: unknown, m: unknown): void }
      const orig = internal.sendOn.bind(agent)
      internal.sendOn = (ws, m) => { sent.push(m); orig(ws, m) }
      await agent.connect(`ws://localhost:${port}`)
      const register = sent.find((m) => (m as { type: string }).type === 'agent:register') as { devices: Array<{ id: string }> }
      expect(register.devices.map((d) => d.id)).toEqual(['dev-2'])
      agent.disconnect()
    })

    it('leaves a single-panel device on the Indigo path and starts no helper', async () => {
      const { agent, browser, guest, received } = await bootedDuo({ panels: 1, chromeLoader: panelChromes() })
      await vi.waitFor(() => expect(MockTouchHelper).toHaveBeenCalled())
      expect(guest.native.spawn).not.toHaveBeenCalled()
      const chrome = received.find((m) => m.type === 'session:chrome')?.payload as { framePng: string }
      expect(chrome.framePng).toBe('model')
      // Its turn is the one it is held at — upright, stood up on this first boot (no devicectl under vitest).
      expect((chrome as { streamRotation?: number }).streamRotation).toBe(0)
      agent.disconnect()
      browser.close()
    })
  })

  describe('input acks (followups H-F)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    it('acks input:done after a tap on a booted session', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-1', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const done = waitForType(browser, 'input:done')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in5', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      const ack = await done
      expect(ack.sessionId).toBe(agent.sessionId)
      // L5c. The ack must carry **the terminal frame's** id, and nothing else here would say so: replacing
      // the echo with a literal left all 382 tests passing in the mutation round. `#499` is what an
      // unattributed ack costs — a late one is consumed by the next input's waiter, which then reports the
      // previous input's outcome, including reporting an unanswered input as landed.
      expect(ack.requestId).toBe('rq-in5')

      agent.disconnect()
      browser.close()
    })

    it('acks input:error after the device is shut down (booted then shutdown)', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      // Boot first (per the device:boot guideline → booted flag true, TouchHelper set up).
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-2', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // Power the device off: shutdown clears the booted flag, and simctl now reports it shut down.
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
      ])
      browser.send(JSON.stringify({ type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in6', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      const e = await errored
      expect(e.sessionId).toBe(agent.sessionId)
      expect(e.message).toBe('device not booted')
      // The **error** half of `ackInput`, and it needs its own assertion: the `input:done` line above is
      // pinned one test up, and a literal on this line survived the whole suite in review. Worse than a
      // hang, too — `awaitInputAck` drops an unmatched reply into its catch, and on a session that is not
      // yet strict that path resolves *optimistically*. So a device failure the agent stated plainly would
      // be reported to the caller as success: #457 restored for exactly the frames that carry the failure.
      expect(e.requestId).toBe('rq-in6')

      agent.disconnect()
      browser.close()
    })

    // A terminal input naming a session this agent holds no state for. Nothing used to answer it —
    // `if (!state) break` — so the caller waited out its own timeout, which its fallback then
    // reported as success. Reachability is genuinely disputed (see `ackNoSession`'s comment), which
    // is why the state is manufactured here rather than driven through a relay sequence: the only
    // shape that produces it needs the relay to hold two sessions for one device, and this suite
    // cannot stand that up. What the test pins is the answer, not the route to it.
    // Asserted on what the agent sends rather than on what reaches the browser, for the same reason
    // the Android suite does: the relay answers these types on an agent's behalf when the socket is
    // down, so a round trip would risk testing the relay's fallback instead of this branch.
    describe('terminal inputs for a session whose state is gone (#489)', () => {
      async function connectedAgent() {
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
        await agent.connect(`ws://localhost:${port}`)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      type Internals = {
        ws: WebSocket
        deviceStates: Map<string, unknown>
        handleRelayMessage(msg: { type: string; sessionId?: string; requestId?: string; payload?: unknown }): void
      }
      const internals = (a: IOSAgent): Internals => a as unknown as Internals

      function inputErrors(spy: { mock: { calls: unknown[][] } }) {
        return spy.mock.calls
          .map(([raw]) => JSON.parse(raw as string) as { type: string; sessionId?: string; requestId?: string; message?: string; reason?: string })
          .filter((m) => m.type === 'input:error')
      }

      for (const [type, payload] of [
        ['input:touch:end', { x: 0.5, y: 0.5 }],
        ['input:pinch:end', { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } }],
        ['input:button', { name: 'home' }],
        ['input:key', { code: 'KeyA' }],
      ] as Array<[string, Record<string, unknown>]>) {
        it(`answers input:error with reason channel-unavailable for ${type}`, async () => {
          const { agent, browser } = await connectedAgent()
          // Captured first: `sessionId` is derived from `deviceStates`, so clearing the map would
          // also make the id null and the ack would have nothing to address.
          const sessionId = agent.sessionId
          const sent = vi.spyOn(internals(agent).ws, 'send')
          internals(agent).deviceStates.clear()

          internals(agent).handleRelayMessage({ type, sessionId: sessionId!, requestId: 'rq-gone', payload })

          const acks = inputErrors(sent)
          expect(acks).toHaveLength(1)
          expect(acks[0]!.sessionId).toBe(sessionId)
          expect(acks[0]!.reason).toBe('channel-unavailable')
          // `ackNoSession` is the one reply path with no `state` to hang anything on, so the correlator has
          // to arrive as an argument. A literal there survived the whole suite in the mutation round.
          expect(acks[0]!.requestId).toBe('rq-gone')

          agent.disconnect()
          browser.close()
        })
      }

      it('stays silent for an opening frame — those carry no ack obligation', async () => {
        const { agent, browser } = await connectedAgent()
        const sessionId = agent.sessionId
        const sent = vi.spyOn(internals(agent).ws, 'send')
        internals(agent).deviceStates.clear()

        internals(agent).handleRelayMessage({ type: 'input:touch:start', sessionId: sessionId!, payload: { x: 0.5, y: 0.5 } })

        expect(inputErrors(sent)).toHaveLength(0)

        agent.disconnect()
        browser.close()
      })
    })
  })

  // #482: the helper process dies, the session keeps streaming, and every input is dropped.
  // The agent used to ack on `state.touchHelper !== null` — the wrapper object, which is still
  // there — so the caller was told each dropped input had been delivered.
  describe('input acks when the helper process has died (#482)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function bootedSession(simctl = mockSimctl(true)) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-3', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      // device:ready is not a sync point for the helper — wait on the mock itself.
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      return { browser, agent, simctl, th: MockTouchHelper.mock.results[0].value }
    }

    // A refusal from a *ready* helper is the gesture-ownership guard: the channel is fine and the
    // message is well-formed, but this frame's gesture is gone, so the caller has to open a new one
    // rather than retry or give up.
    it('answers no-gesture when a ready helper refuses a mid-gesture frame', async () => {
      const { browser, agent, th } = await bootedSession()
      th.touchEnd.mockReturnValue(false)
      th.ownsGesture.mockReturnValue(false)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in7', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      expect((await errored)['reason']).toBe('no-gesture')

      agent.disconnect()
      browser.close()
    })

    // The inverted advice both design reviews found: an opening frame refused inside the start-up
    // window owns nothing, so by the time the terminal frame arrives the helper reads `ready` and the
    // ack used to say "never retry" — for the exact sequence `channel-starting` exists to serve.
    // MCP's `swipe` defaults to 300ms, comfortably past the measured 247ms, so it lands here.
    it('answers no-gesture, not malformed, when the gesture opened inside the start-up window', async () => {
      const { browser, agent, th } = await bootedSession()
      startingHelper(th)
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      // the helper finishes starting between the two frames
      th.inputState.mockReturnValue('ready')
      th.ownsGesture.mockReturnValue(false) // nothing was owned: the open was refused

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in8', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      const msg = await errored
      expect(msg['reason']).toBe('no-gesture')
      expect(msg['message']).toContain('start a new one')

      agent.disconnect()
      browser.close()
    })

    // A standalone input never consults ownership — only a continuation does.
    it('answers channel-starting for a key while the helper is coming up', async () => {
      const { browser, agent, th } = await bootedSession()
      startingHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in9', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))

      expect((await errored)['reason']).toBe('channel-starting')

      agent.disconnect()
      browser.close()
    })

    it('carries reason channel-unavailable when the helper is gone', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in10', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      const msg = await errored
      // No channel at all outranks "no gesture": re-opening one could not help.
      expect(msg['reason']).toBe('channel-unavailable')
      expect(msg['message']).toBe('input channel not ready') // wording preserved for consumers

      agent.disconnect()
      browser.close()
    })

    it('carries reason unsupported for an unknown key code, keeping the code in the prose', async () => {
      const { browser, agent } = await bootedSession()

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in11', sessionId: agent.sessionId, payload: { code: 'KeyNope', modifiers: 0 } }))

      const msg = await errored
      expect(msg['reason']).toBe('unsupported')
      expect(msg['message']).toBe('unknown key code: KeyNope')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a tap the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in12', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      // The device is still booted — this is the input channel failing, not the device.
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a pinch the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      const f0 = { x: 0.2, y: 0.2 }, f1 = { x: 0.8, y: 0.8 }
      browser.send(JSON.stringify({ type: 'input:pinch:start', sessionId: agent.sessionId, payload: { f0, f1 } }))
      browser.send(JSON.stringify({ type: 'input:pinch:end', requestId: 'rq-in13', sessionId: agent.sessionId, payload: { f0, f1 } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    it('answers input:done again once the helper has recovered, without a reconnect', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)
      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in14', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      await errored

      // TouchHelper respawns itself, so the session heals in place — the same object starts
      // reporting delivery again. Nothing re-issues the session.
      th.touchEnd.mockReturnValue(true)
      th.isReady.mockReturnValue(true)

      const done = waitForType(browser, 'input:done')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in15', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      expect((await done).sessionId).toBe(agent.sessionId)

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a button the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in16', sessionId: agent.sessionId, payload: { name: 'home' } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    // The two branches that deliberately write nothing answer with the channel's health. Both
    // directions need pinning: a seed of `false` invents a failure on a healthy channel, and a
    // seed of `true` is the silent success this whole issue is about.
    const noWriteBranches: Array<[string, Record<string, unknown>]> = [
      ['a home press-down', { name: 'home', phase: 'down' }],
      // `mockSimctl` reports no typeId, so DeviceChromeLoader finds nothing and `loadedChrome`
      // stays null for this whole suite — this pair covers the "no chrome button matched" branch.
      // The narrower `usagePage > 0 && usage > 0` sub-guard inside it is unreached here and
      // untested; it predates this change.
      ['a button with no chrome entry', { name: 'volume-up' }],
    ]

    for (const [label, payload] of noWriteBranches) {
      it(`does not invent a failure for ${label} on a healthy channel`, async () => {
        const { browser, agent, th } = await bootedSession()

        const done = waitForType(browser, 'input:done')
        browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in17', sessionId: agent.sessionId, payload }))
        expect((await done).sessionId).toBe(agent.sessionId)
        expect(th.pressLegacyButton).not.toHaveBeenCalled()
        expect(th.pressButtonDown).not.toHaveBeenCalled()

        agent.disconnect()
        browser.close()
      })

      it(`does not claim success for ${label} on a dead channel`, async () => {
        const { browser, agent, th } = await bootedSession()
        killHelper(th)

        const errored = waitForType(browser, 'input:error')
        browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in18', sessionId: agent.sessionId, payload }))
        expect((await errored).message).toBe('input channel not ready')

        agent.disconnect()
        browser.close()
      })
    }

    it('answers input:error for a key the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in19', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    // The deferred branch had no test that drove it with a *starting* helper, so the reason there
    // could be replaced with the constant `channel-unavailable` and everything stayed green — losing
    // exactly the distinction this change exists to make, for every key pressed while the software
    // keyboard is up.
    it('reasons about the channel in the deferred key branch, not just in the direct one', async () => {
      const { browser, agent, simctl, th } = await bootedSession()
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      startingHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in20', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))

      const msg = await errored
      expect(msg['reason']).toBe('channel-starting')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a key deferred behind hiding the software keyboard', async () => {
      // The branch the ack used to race: the chord is sent inside the hide's continuation, so
      // acking beside it answered before the key had been written at all.
      const { browser, agent, simctl, th } = await bootedSession()
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in21', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      expect((await errored).message).toBe('input channel not ready')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('stops a helper that input created while a boot was still in flight', async () => {
      // handleDeviceBoot clears the helper up front and then awaits simctl. An input arriving
      // inside that window builds a fresh one through ensureTouchHelper, and sendChromeData
      // later replaces it. That used to leak one child process; now the orphan revives itself
      // for the life of the agent with nothing left holding a reference to stop it.
      const simctl = mockSimctl(false)
      let releaseBoot = (): void => {}
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>((resolve) => { releaseBoot = () => resolve() }),
      )
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const booting = waitForType(browser, 'device:booting')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-4', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await booting
      await vi.waitFor(() => expect(simctl.boot).toHaveBeenCalled(), { timeout: 500 })

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const orphan = MockTouchHelper.mock.results[0].value

      const ready = waitForType(browser, 'device:ready')
      releaseBoot()
      await ready
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(2), { timeout: 1000 })

      expect(orphan.stop).toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })

    it('does not install a helper onto a state that a reconnect has already dropped', async () => {
      // What `cleanupDeviceState`'s bootSeq bump is actually for. A boot awaiting simctl holds its
      // own reference to the state, and `_scheduleReconnect`'s `deviceStates.clear()` does not
      // reach it. `sendChromeData`'s `!this.ws` guard covers the window only until the reconnect
      // completes — after that the socket is live again and the abandoned boot goes on to build a
      // TouchHelper nobody owns, which a self-reviving helper would keep respawning for the life
      // of the agent with nothing left to stop it.
      //
      // Driving the reconnect is the whole point: an `agent.disconnect()` version of this test
      // passes with the bump deleted, because ws stays null forever and the guard above catches it.
      const simctl = mockSimctl(false)
      let releaseBoot = (): void => {}
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>((resolve) => { releaseBoot = () => resolve() }),
      )
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      // A one-second handshake, not the 10s default and not the 200ms a first attempt at this flake
      // used. 10s is longer than the whole budget below, so a single attempt landing in it stops every
      // later one — `_scheduleReconnect` runs only from `connect()`'s `.catch`. 200ms went too far the
      // other way: on a loaded runner the register round trip can miss it, and then *every* attempt
      // fails for a reason the agent could not avoid. Neither reproduces locally.
      const agent = new IOSAgent({ intervalMs: 50, reconnectDelays: [20], handshakeTimeoutMs: 1_000 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const booting = waitForType(browser, 'device:booting')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-5', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await booting
      await vi.waitFor(() => expect(simctl.boot).toHaveBeenCalled(), { timeout: 500 })
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      // Drop the relay and bring it back on the same port so the agent's own reconnect runs.
      browser.close()
      await relay.stop()
      relay = new RelayServer({ port })
      await relay.start()
      const rejoined = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(rejoined)
      // A join only succeeds once the agent has re-registered, so this is the barrier that says
      // the socket is live again — and therefore that `!this.ws` no longer guards anything.
      //
      // 15s of budget, up from 3. Stopping a relay, starting another on the same port and waiting
      // for the agent's own reconnect to re-register is the heaviest sequence in this file, and 3s
      // was a guess that CI disproved twice — the second time with the handshake already shortened,
      // so the deadline was never the whole story. The cost of the larger budget is nothing when the
      // reconnect is prompt, which is every run that was already passing.
      let joined = null
      for (let i = 0; i < 60 && joined === null; i++) {
        rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        joined = await waitForTypeOrNull(rejoined, 'session:joined', 250)
      }
      expect(joined).not.toBeNull()

      // The abandoned boot returns at the seq check that follows `simctl.boot`, before it reaches
      // `waitUntilBooted` — so no further `listDevices` happening is the assertion. No sleep, and it
      // fails if the bump is removed (the boot then runs on and builds the helper). `setImmediate`
      // drains the microtask queue, which is all the guarded path needs to reach its early return.
      //
      // The extra reading it would make is now the double's, not the handler's: `mockSimctl`'s
      // `waitUntilBooted` reads the shared list to answer with the right device. That keeps this
      // assertion working, but the `MockTouchHelper` check below is the one that does not depend on
      // how the double is written. The later seq check — the one on the far side of the wait — is a
      // different guard with its own test in `device:boot handler`.
      const listCallsBeforeRelease = (simctl.listDevices as ReturnType<typeof vi.fn>).mock.calls.length
      releaseBoot()
      await new Promise((r) => setImmediate(r))

      expect(simctl.listDevices).toHaveBeenCalledTimes(listCallsBeforeRelease)
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      agent.disconnect()
      rejoined.close()
      // Above vitest's 5s default, because the wait above is allowed 15: stopping a relay, starting
      // another on the same port and re-registering is the heaviest sequence in this file, and the
      // budget is what CI twice proved too small.
    }, 25_000)

    // #1129: the typed text can be a flow's secret, and the pasteboard is where the next person to open this simulator
    // would find it. What was there goes back once the paste has landed.
    it('puts back what the pasteboard held, after the paste and before the ack', async () => {
      const { browser, agent, simctl, th } = await bootedSession()
      pasteboard = 'hello'
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb1', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      await done
      expect(pasteboard).toBe('hello')
      const sets = (simctl.setPasteboard as ReturnType<typeof vi.fn>).mock
      const typed = sets.calls.findIndex((c) => c[1] === 'hunter2')
      const restored = sets.calls.findIndex((c, i) => i > typed && c[1] === 'hello')
      expect(typed).toBeGreaterThanOrEqual(0)
      expect(restored).toBeGreaterThan(typed)
      const paste = th.sendKey.mock.invocationCallOrder.at(-1)!
      expect(paste).toBeGreaterThan(sets.invocationCallOrder[typed]!)
      expect(paste).toBeLessThan(sets.invocationCallOrder[restored]!)
      agent.disconnect()
      browser.close()
    })

    it('empties the pasteboard when what it held cannot be read, and still answers done when the restore fails', async () => {
      const { browser, agent, simctl } = await bootedSession()
      pasteboard = 'unreadable'
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pbpaste failed'))
      let done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb2', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      await done
      expect(pasteboard).toBe('')

      const set = simctl.setPasteboard as ReturnType<typeof vi.fn>
      set.mockImplementation(async (_d: string, t: string) => { if (t !== 'hunter2') throw new Error('pbcopy failed'); pasteboard = t })
      done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb3', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      await done
      agent.disconnect()
      browser.close()
    })

    it('puts the pasteboard back when writing the text failed after the device took it', async () => {
      const { browser, agent, simctl } = await bootedSession()
      pasteboard = 'hello'
      const set = simctl.setPasteboard as ReturnType<typeof vi.fn>
      set.mockImplementationOnce(async (_d: string, t: string) => { pasteboard = t; throw new Error('pbcopy killed') })
      const errored = waitForType(browser, 'input:type-error')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb4', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      const e = await errored
      expect(pasteboard).toBe('hello')
      expect(JSON.stringify(e)).not.toContain('hunter2')
      agent.disconnect()
      browser.close()
    })

    it('does not put back a sentinel a clipboard read left behind', async () => {
      const { browser, agent } = await bootedSession()
      pasteboard = `${CLIPBOARD_SENTINEL_PREFIX}left-behind`
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb5', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      await done
      expect(pasteboard).toBe('')
      agent.disconnect()
      browser.close()
    })

    // A restore that cannot be confirmed may have left the text there: the pasteboard is emptied rather than trusted.
    it('empties the pasteboard when the restore cannot be read back', async () => {
      // Real time: the restore's deadline is half a second.
      const { browser, agent, simctl } = await bootedSession()
      pasteboard = 'hello'
      let reads = 0
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (++reads > 1) throw new Error('pbpaste failed')
        return pasteboard
      })
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-pb6', sessionId: agent.sessionId, payload: { text: 'hunter2' } }))
      await done
      expect(pasteboard).toBe('')
      agent.disconnect()
      browser.close()
    })

    it('answers input:type-error when the paste chord is dropped', async () => {
      // No pasteboard deadline guards this path, unlike the copy in clipboard:read — the text
      // lands on the device clipboard and nothing reaches the app under test.
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:type-error')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in22', sessionId: agent.sessionId, payload: { text: 'hello' } }))
      const e = await errored
      expect(e.message).toContain('no input channel')
      // All three `input:type-*` producers here took a literal in the mutation round with nothing failing.
      // The client tests that echo it echo it correctly, so a predicate that stopped checking matched either
      // way — which is what makes an assertion at the producer the only real one.
      expect(e.requestId).toBe('rq-in22')
      // Nothing was pasted, and the text does not stay behind either.
      expect(pasteboard).toBe('')

      agent.disconnect()
      browser.close()
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

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-6', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // device:ready is sent as the stream is handed off, which is not the same instant the helper
      // becomes observable — wait for the helper itself. (A vi.fn call log never lags.)
      // The relay used to replay a device:ready for any already-booted session too, which could
      // latch an ack belonging to no boot; that is fixed, but this wait is still the right shape.
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:type sets the pasteboard then pastes with Cmd+V', async () => {
      const simctl = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-7', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value

      // register the ack listener before sending — the done can arrive before
      // the assertions below finish awaiting
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in23', sessionId: agent.sessionId, payload: { text: '안녕 hi' } }))
      // the ack must arrive AFTER the work completed — so once done lands, the
      // pasteboard write and Cmd+V (KeyV 0x19, MetaLeft 0x08) are already done.
      // (a synchronous check here, not waitFor, so moving .then(done) ahead of
      // the paste would fail this test — the ordering is what's under guard)
      const ack = await done
      expect(ack.sessionId).toBe(agent.sessionId)
      expect(ack.requestId).toBe('rq-in23')
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', '안녕 hi')
      expect(thInstance.sendKey).toHaveBeenCalledWith(0x19, 0x08)

      agent.disconnect()
      browser.close()
    })

    it('input:type hides the software keyboard first when it is visible', async () => {
      const simctl = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-8', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })

      // bring the software keyboard up first
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')

      const typed = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in24', sessionId: agent.sessionId, payload: { text: 'hi' } }))
      await typed
      // hidden before the Cmd+V chord (mirrors the input:key guard)
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

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
      browser.send(JSON.stringify({ type: 'input:pinch:end', requestId: 'rq-in25', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(thInstance.pinchEnd).toHaveBeenCalled(), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    // home has no HID down/up split — a down+up pair from the dashboard must not fire it twice.
    it('input:button home (no phase) presses the legacy button once', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in26', sessionId: agent.sessionId, payload: { name: 'home' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })

    it('input:button home fires only on the up phase, not on down', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in27', sessionId: agent.sessionId, payload: { name: 'home', phase: 'down' } }))
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in28', sessionId: agent.sessionId, payload: { name: 'home', phase: 'up' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })
  })

  describe('device:boot handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-9', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))

      await bootingPromise
      const ready = await readyPromise
      expect((ready.payload as { deviceId: string }).deviceId).toBe('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    // The relay's boot gate charges a boot by this (L2 admission plan, S2): a device found already
    // running costs the host nothing, one this boot brings up costs it 30-90 s of memory pressure.
    // `unknown` is a device mid-transition, which is paying that cost now; Full reset shuts the device
    // down itself, so it is cold whatever the list said.
    it.each([
      { status: false, resetMode: undefined, cold: true },
      { status: true, resetMode: undefined, cold: false },
      { status: 'unknown', resetMode: undefined, cold: true },
      { status: true, resetMode: 'full-erase', cold: true },
      { status: true, resetMode: 'app-only', cold: false },
    ] as const)('reports cold=$cold on device:ready for booted=$status, resetMode=$resetMode', async ({ status, resetMode, cold }) => {
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(status))
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
        payload: { deviceId: 'dev-1', ...(resetMode ? { resetMode } : {}) },
      }))
      const ready = await readyPromise
      expect((ready.payload as { cold?: boolean }).cold).toBe(cold)

      agent.disconnect()
      browser.close()
    })

    it('holds device:ready until the simulator has finished booting (#486)', async () => {
      // `simctl boot` returns when the boot has been *initiated* — measured 7.6s short of Booted on an
      // iPhone 17 Pro / iOS 26.5. Announcing readiness there tells `mcp-server` to install and tap a
      // device that is not up, which is the half of #440 ("No devices are booted") that targeting the
      // session udid did not remove. Android has waited since the beginning.
      //
      // The wait is held open and `session:deviceInfo` is what is asserted absent, not `device:ready`.
      // Two earlier drafts of this test passed under the mutation that drops the `await`:
      //   - a 30ms mock + `events.push('ready')` after `await waitForType` stamps the *read* rather
      //     than the arrival, and the stream handoff between the two outlasts 30ms;
      //   - releasing the wait as soon as it had been called still ran ahead of the mutated path,
      //     because `openStreamWs` sits between the mutation site and `device:ready`.
      // `sendChromeData` is the first thing after the wait and it sends `session:deviceInfo`
      // synchronously, so with the await gone it arrives with nothing in front of it to hide behind.
      const simctl = mockSimctl(false)
      let releaseWait = (): void => {}
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => {
          releaseWait = () =>
            resolve({ id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' })
        }),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(simctl.waitUntilBooted).toHaveBeenCalledWith('dev-1', expect.anything()), { timeout: 2000 })

      expect(await waitForTypeOrNull(browser, 'session:deviceInfo', 300)).toBeNull()
      // `device:ready` too, and not only `session:deviceInfo`. The recording is already running, so
      // this reads whatever arrived during the 300ms above rather than waiting again — and without
      // it, moving the `sendMsg({ type: 'device:ready' })` above the wait while leaving
      // `sendChromeData` below it passes this test, which is #486 itself restored.
      expect(await waitForTypeOrNull(browser, 'device:ready', 0)).toBeNull()
      // In-process and hop-free: `sendChromeData` constructs the helper synchronously, before either
      // message goes out, so this holds even if a socket were slower than the deadline above.
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      const ready = waitForType(browser, 'device:ready')
      releaseWait()
      await ready
      expect(await waitForTypeOrNull(browser, 'session:deviceInfo', 0)).not.toBeNull()
      // The wait runs after the boot, not instead of it.
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const waitOrder = (simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(bootOrder).toBeLessThan(waitOrder)

      agent.disconnect()
      browser.close()
    })

    // ── #526: a boot the agent stops running is answered, not abandoned ───────────────────────
    //
    // Every checkpoint in `handleDeviceBoot` used to `return` with nothing sent in either direction, so
    // the caller learned about it by waiting out its own deadline — 30s for `mcp-server`, and a spinner
    // that never resolves for a viewer. The reply exists so that wait ends now, with a cause.

    const BOOTED_DEV1 = { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' }

    /** A `waitUntilBooted` whose first `hold` calls park until released, and which answers at once after. */
    function holdingWait(simctl: SimctlWrapper, hold: number) {
      const releases: (() => void)[] = []
      let calls = 0
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockImplementation(() => {
        calls++
        if (calls <= hold) return new Promise((resolve) => releases.push(() => resolve(BOOTED_DEV1)))
        return Promise.resolve(BOOTED_DEV1)
      })
      return { releases, calls: () => calls }
    }

    it('answers a boot that a newer boot superseded', async () => {
      const simctl = mockSimctl(false)
      const wait = holdingWait(simctl, 1)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-a', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      const superseded = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['requestId'], 'the surviving boot is the newer one').toBe('rq-b')

      wait.releases[0]!()
      const e = await superseded
      // The correlator is the whole point: the abandoned request is answered, not the live one.
      expect(e['requestId']).toBe('rq-a')
      expect(String(e['message'])).toContain('superseded')

      agent.disconnect()
      browser.close()
    })

    it('tells each abandoned boot what actually superseded it', async () => {
      // **The reason cannot be a single slot on the state.** With one slot, boot A → boot B → shutdown
      // leaves it saying `shut-down`, which is what B lost to — A lost to B. Two overlapping boots and one
      // later event is the smallest sequence that tells the two designs apart, and a single-slot version
      // passes the test above unchanged.
      const simctl = mockSimctl(false)
      const wait = holdingWait(simctl, 2)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

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

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-a', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(wait.calls()).toBe(2), { timeout: 2000 })
      // Its reply is the barrier — the shutdown has run before either wait is released.
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-s', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      for (const release of wait.releases) release()
      await both

      expect(seen['rq-a'], 'A lost to B, not to the shutdown').toContain('superseded')
      expect(seen['rq-b'], 'B is the one the shutdown abandoned').toContain('shut down')

      agent.disconnect()
      browser.close()
    })

    it('answers a boot for a session it holds no device state for', async () => {
      // The `!state` half of the entry guard, which used to return in the same breath as `!this.ws` and
      // is answerable where that one is not. Reached by clearing the map rather than through the wire,
      // because the wire cannot produce it — re-seeding from `agent:registered` carries one entry per
      // *device*, and one device can now sit behind two sessions, which is the disputed reachability
      // #489 recorded on the input path rather than claimed.
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const sessionId = agent.sessionId
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')

      // Held above, because `agent.sessionId` reads the first entry of the very map being emptied.
      ;(agent as unknown as { deviceStates: Map<string, unknown> }).deviceStates.clear()

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-nostate', sessionId, payload: { deviceId: 'dev-1' } }))
      const e = await errored
      expect(e['requestId']).toBe('rq-nostate')
      expect(String(e['message'])).toContain('re-join')
      // And nothing was started for it.
      expect(simctl.boot).not.toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })

    it('does not answer a boot whose session the agent has stopped holding', async () => {
      // **Determinism, not tidiness.** `relay-lost` retires a boot by dropping the whole map, and the answer
      // is deferred until the parked `await` resumes — so whether it lands was a race between a poll
      // interval and the reconnect backoff, and when it landed it went to a *new* relay naming a session id
      // that relay had never heard of. Neither outcome is an answer. Asserted in both directions, because a
      // check that refused everything would satisfy the first half on its own.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      const reach = agent as unknown as {
        ws: unknown
        deviceStates: Map<string, unknown>
        abandonBoot(state: unknown, seq: number, sessionId: string, requestId?: string): void
      }
      const sent: string[] = []
      reach.ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(d) }
      const dropped = { bootAbandon: new Map([[1, 'relay-lost']]), bootsInFlight: new Set([1]) }
      const held = { bootAbandon: new Map([[1, 'superseded']]), bootsInFlight: new Set([1]) }

      reach.abandonBoot(dropped, 1, 's-dropped', 'rq-1')
      expect(sent, 'answered a session the agent no longer holds').toEqual([])

      reach.deviceStates.set('s-held', held)
      reach.abandonBoot(held, 1, 's-held', 'rq-2')
      expect(sent, 'and a session it does hold gets its answer').toHaveLength(1)
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'device:boot-error', requestId: 'rq-2' })
    })

    it('sends no chrome to a socket that closed while the boot was waiting', async () => {
      // `sendChromeData` gated on the socket being *present*, so a boot that lost it mid-wait pushed the
      // chrome into a buffer nobody flushes — and its `device:ready` was then dropped by `sendMsg`'s own
      // check, leaving the caller with neither the data nor an answer. Observed through the helper, which
      // that function builds immediately after the guard.
      const simctl = mockSimctl(false)
      const wait = holdingWait(simctl, 1)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-closing', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      // Swapped whole, not mutated: a real `ws`'s `readyState` is a getter, and the send has to be
      // observable anyway — this is what proves nothing was handed to a socket in that state.
      const reach = agent as unknown as { ws: unknown }
      const buffered: string[] = []
      reach.ws = { readyState: WebSocket.CLOSING, send: (d: string) => buffered.push(d), close: () => {} }
      wait.releases[0]!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 50))

      expect(MockTouchHelper.mock.results, 'built a helper for a boot it could not report').toHaveLength(0)
      expect(buffered, 'and handed nothing to the closing socket').toEqual([])

      agent.disconnect()
      browser.close()
    })

    it('keeps no record of a boot that already answered', async () => {
      // **The map is written by every lifecycle event and read only by a boot still running.** Without a
      // guard, the ordinary case — boot completes, then a shutdown or a later boot retires its seq — leaves
      // an entry nobody will ever read or delete. One per boot and one per shutdown, for as long as the
      // agent stays connected, freed only when a reconnect drops the whole state. The comment on the field
      // claimed it emptied itself, which is the kind of invariant worth an assertion rather than a claim.
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      const abandon = () => {
        const state = (agent as unknown as { deviceStates: Map<string, { bootAbandon: Map<number, string> }> })
          .deviceStates.get(agent.sessionId!)!
        return state.bootAbandon
      }

      for (const id of ['rq-1', 'rq-2']) {
        browser.send(JSON.stringify({ type: 'device:boot', requestId: id, sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
        await waitForType(browser, 'device:ready')
      }
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-s', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      expect(abandon().size, 'a reason was kept for a boot that had already answered').toBe(0)

      agent.disconnect()
      browser.close()
    })

    it('says nothing for an abandoned boot that carried no correlator', async () => {
      // A reply nobody waits for is not an answer — and worse than nothing here, because the dashboard
      // reports every *uncorrelated* `device:boot-error` (deliberately: that is how a dead video stream is
      // reported, #426). So answering one would put "Boot failed" on the screen of a tester whose device is
      // booting normally. The relay requires a correlator on `device:boot`, which is why this is driven
      // through the handler rather than the wire — the parameter is optional and an older relay does not
      // enforce it, the same reachability argument #489 recorded rather than claimed.
      const simctl = mockSimctl(false)
      const wait = holdingWait(simctl, 1)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const handler = agent as unknown as { handleDeviceBoot(s: string, d: string): Promise<void> }
      void handler.handleDeviceBoot(agent.sessionId!, 'dev-1')
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-live', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      wait.releases[0]!()
      // The abandoned one is the uncorrelated one, so nothing may come back for it.
      expect(await waitForTypeOrNull(browser, 'device:boot-error', 150)).toBeNull()

      agent.disconnect()
      browser.close()
    })

    it('drops a reply to a socket that is closing, rather than buffering it in silence', async () => {
      // `ws.send` on anything but OPEN takes the `sendAfterClose` path: it adds the payload to a buffer
      // nobody will flush, and neither throws nor emits. So a boot answer sent there is indistinguishable
      // from a delivered one at the call site — the exact silence these replies exist to end. Asserted in
      // both directions, because a guard that dropped everything would pass the first half alone.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      const reach = agent as unknown as {
        ws: unknown
        sendMsg(msg: { type: string; sessionId: string; requestId: string; message: string }): void
      }
      const sent: string[] = []
      const socket: { readyState: number; send: (d: string) => void } = { readyState: WebSocket.CLOSING, send: (d) => sent.push(d) }
      reach.ws = socket
      const reply = { type: 'device:boot-error' as const, sessionId: 's1', requestId: 'rq-x', message: 'superseded' }

      reach.sendMsg(reply)
      expect(sent, 'a closing socket takes it and says nothing').toEqual([])

      socket.readyState = WebSocket.OPEN
      reach.sendMsg(reply)
      expect(sent, 'and an open one still gets it').toHaveLength(1)
    })

    it('reports a boot that never finishes as device:boot-error (#486)', async () => {
      // What the deadline answers with. `device:ready` is the alternative — ready-anyway with a
      // warning — and it would put the caller back where it started, acting on a device that is not up.
      const simctl = mockSimctl(false)
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PlatformError('Device dev-1 did not finish booting within 90000ms (last seen: unknown)'),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486b', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const e = await errored
      expect(e.message).toContain('did not finish booting')
      expect(e.requestId).toBe('rq-486b')

      agent.disconnect()
      browser.close()
    })

    it('keeps the argv line out of a boot failure toast', async () => {
      // `Shutting Down` is the state a device caught mid-quit is in, and `simctl boot` refuses it.
      // Refusing is right — swallowing it would put the wait back to polling a device nobody is
      // bringing up — so this refusal is what the tester reads, and node's own first line is
      // `Command failed: xcrun simctl boot <UDID>`, which says nothing and echoes the udid.
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Command failed: xcrun simctl boot 1A2B-3C4D\nUnable to boot device in current state: Shutting Down'),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486f', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const e = await errored
      expect(e.message).toBe('Unable to boot device in current state: Shutting Down')

      agent.disconnect()
      browser.close()
    })

    it('installs no helper when a shutdown lands while the boot is waiting (#486)', async () => {
      // The `bootSeq` re-check on the far side of the wait, which nothing reached before. The
      // existing reconnect test bumps the seq while `simctl.boot` is in flight, so it returns at the
      // check *before* this one — its own comment says so — and deleting the check after the wait
      // left all 388 tests green. The gap it guards used to be sub-second and is now the boot itself
      // (measured 7.6s), so it is the wider of the two.
      //
      // `isStale` covers the same window from inside the poll, but only while the poll is running.
      // This is the microtask-thin case it cannot see: the wait has already resolved and the seq
      // moves before the handler resumes.
      const simctl = mockSimctl(false)
      let releaseWait = (): void => {}
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => {
          releaseWait = () =>
            resolve({ id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' })
        }),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486c', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(simctl.waitUntilBooted).toHaveBeenCalled(), { timeout: 2000 })
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      // `device:shutdown` bumps `bootSeq` on its first line. Its reply is the barrier: the agent has
      // finished with the shutdown before the wait is released, so this is an answer rather than a
      // guess about timing.
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-486d', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      releaseWait()
      await new Promise((r) => setImmediate(r))

      expect(MockTouchHelper.mock.results).toHaveLength(0)
      expect(await waitForTypeOrNull(browser, 'device:ready', 0)).toBeNull()

      agent.disconnect()
      browser.close()
    })

    it('shuts a running device down before erasing it (#439)', async () => {
      // `simctl erase` refuses a Booted device. A device is often already up — it survives agent
      // restarts and sessions that ended without a clean shutdown — so without the shutdown the
      // whole boot fails with `Boot failed: Command failed: xcrun simctl erase`.
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-10',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      const shutdownOrder = (simctl.shutdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(shutdownOrder).toBeLessThan(eraseOrder)
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    // ── L5b′: the lifecycle pair correlates, and the correlator is optional ────────────────────
    //
    // Optional means `<Pair>ReplyBody` cannot exist for it — `Omit<T,'sessionId'|'requestId'>` is
    // satisfied by an object with no correlator at all, so the excess-property trick that catches a
    // freshly minted id has nothing to bite on. Nor does `correlatedRequestsGated` derive this pair.
    // These tests are the entire enforcement of the echo on this agent.
    describe('lifecycle replies echo the boot/shutdown correlator', () => {
      async function joined(simctl: SimctlWrapper) {
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      it('device:ready carries the requestId of the boot it answers', async () => {
        const { agent, browser } = await joined(mockSimctl(false))

        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-1',
          payload: { deviceId: 'dev-1' },
        }))
        expect((await ready)['requestId']).toBe('boot-1')

        agent.disconnect(); browser.close()
      })

      it('device:boot-error carries the requestId of the boot it answers', async () => {
        // The failure exit is the one that matters most and the one a happy-path test cannot reach:
        // a caller that gets an uncorrelatable diagnosis waits out its deadline instead of failing,
        // so the error arrives and is discarded. That is the defect this file's `open-url` block
        // already records as having shipped twice.
        const simctl = mockSimctl(false)
        ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boot exploded'))
        const { agent, browser } = await joined(simctl)

        const err = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-2',
          payload: { deviceId: 'dev-1' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('boot-2')
        expect(msg['message']).toContain('boot exploded')

        agent.disconnect(); browser.close()
      })

      it('device:shutdown-done carries the requestId of the shutdown it answers', async () => {
        const { agent, browser } = await joined(mockSimctl(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, requestId: 'down-1',
          payload: { deviceId: 'dev-1' },
        }))
        expect((await done)['requestId']).toBe('down-1')

        agent.disconnect(); browser.close()
      })

      it('answers a correlator-less request without inventing one', async () => {
        // The relay originates `device:shutdown` from its idle timer with no id, so this is a live
        // wire shape rather than a legacy one. A minted id here would be worse than none: the
        // consumer's fallback accepts an absent correlator and rejects one that does not match, so an
        // invented id turns a reply that lands today into one that is silently dropped.
        const { agent, browser } = await joined(mockSimctl(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' },
        }))
        expect((await done)['requestId']).toBeUndefined()

        agent.disconnect(); browser.close()
      })

      // #455: the catch used to log and send nothing, so a caller waited out its deadline on a device
      // that was still running — with its stream already torn down, since the teardown comes first.
      it('answers a failed shutdown with device:shutdown-error, not silence', async () => {
        const simctl = mockSimctl(true)
        ;(simctl.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('simctl exploded'))
        const { agent, browser } = await joined(simctl)
        // Owned by the boot this suite's sessions come from, so the assertion below has something to keep.
        ;(agent as unknown as { ownedDevices: Set<string> }).ownedDevices.add('dev-1')

        const done = waitForTypeOrNull(browser, 'device:shutdown-done', 300)
        const err = waitForType(browser, 'device:shutdown-error')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, requestId: 'down-fail',
          payload: { deviceId: 'dev-1' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('down-fail')
        expect(msg['message']).toContain('simctl exploded')
        expect(await done, 'a failed shutdown must not also claim success').toBeNull()
        // The device is still running, so it is still ours — see the comment on the success path.
        expect((agent as unknown as { ownedDevices: Set<string> }).ownedDevices.has('dev-1')).toBe(true)

        agent.disconnect(); browser.close()
      })

      it('answers a correlated shutdown it has no session state for', async () => {
        const simctl = mockSimctl(true)
        const { agent, browser } = await joined(simctl)
        // Read first: `sessionId` is derived from the device states this clears.
        const sessionId = agent.sessionId
        internals(agent).deviceStates.clear()

        const err = waitForType(browser, 'device:shutdown-error')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId, requestId: 'down-nostate',
          payload: { deviceId: 'dev-1' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('down-nostate')
        expect(msg['message']).toBe(SHUTDOWN_NO_SESSION_STATE)
        expect(simctl.shutdown).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      it('stays silent on an uncorrelated shutdown it has no session state for', async () => {
        // The relay's idle timer sends this one, and nobody is waiting on it. An answer would reach the
        // holder's viewer as an error about a shutdown it never asked for.
        const { agent, browser } = await joined(mockSimctl(true))
        const sessionId = agent.sessionId
        internals(agent).deviceStates.clear()

        const err = waitForTypeOrNull(browser, 'device:shutdown-error', 300)
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' },
        }))
        expect(await err).toBeNull()

        agent.disconnect(); browser.close()
      })

      // A helper that ends without a frame used to be restarted at once, forever: a simulator shut down
      // from outside makes it exit immediately, and every round reloads CoreSimulator at full speed.
      it('backs off restarting a screen stream that keeps ending without a frame', async () => {
        const simctl = mockSimctl(false)
        vi.mocked(simctl.screenshot).mockRejectedValue(new Error('device io not ready'))
        const { agent, browser } = await joined(simctl)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'b', payload: { deviceId: 'dev-1' } }))
        await ready
        const before = vi.mocked(simctl.screenshot).mock.calls.length
        await new Promise((r) => setTimeout(r, 800))
        // Delays 0, 250, 500ms: a handful of tries in 800ms, against hundreds without the backoff — and at
        // least two, so a restart that never happens does not pass as a perfect backoff.
        const tries = vi.mocked(simctl.screenshot).mock.calls.length - before
        expect(tries).toBeLessThanOrEqual(6)
        expect(tries).toBeGreaterThanOrEqual(2)
        agent.disconnect(); browser.close()
      })

      // The delayed restart re-checks before it runs: a disconnect (or shutdown, or new boot) while it waits
      // must not bring a stream back for a session that is gone.
      it('drops a pending stream restart when the agent disconnects meanwhile', async () => {
        const simctl = mockSimctl(false)
        vi.mocked(simctl.screenshot).mockRejectedValue(new Error('device io not ready'))
        const { agent, browser } = await joined(simctl)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'b', payload: { deviceId: 'dev-1' } }))
        await ready
        await new Promise((r) => setTimeout(r, 150)) // past the immediate restart; a 250ms delay is pending
        agent.disconnect(); browser.close()
        const atDisconnect = vi.mocked(simctl.screenshot).mock.calls.length
        await new Promise((r) => setTimeout(r, 700))
        expect(vi.mocked(simctl.screenshot).mock.calls.length).toBe(atDisconnect)
      })

      // The chrome load is awaited now, and a newer boot can land during it. The stale load must neither be
      // sent nor stored: the button path reads `loadedChrome`, and a slow old load finishing after a fast new
      // one would put the wrong device's buttons under the tester's clicks.
      it('drops a chrome load that a newer boot overtook', async () => {
        const chromeOf = (tag: string) => ({ framePng: tag } as unknown as ChromeData)
        let releaseFirst: (c: ChromeData) => void = () => {}
        const load = vi.fn()
          .mockImplementationOnce(() => new Promise<ChromeData>((r) => { releaseFirst = r }))
          .mockImplementation(async () => chromeOf('NEW'))
        const agent = new IOSAgent({ intervalMs: 50, chromeLoader: { load } as unknown as DeviceChromeLoader }, mockSimctl(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        const chromes: string[] = []
        browser.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'session:chrome') chromes.push(m.payload.framePng) } catch { /* binary */ } })

        browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'old', payload: { deviceId: 'dev-1' } }))
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'new', payload: { deviceId: 'dev-1' } }))
        expect((await ready)['requestId']).toBe('new')
        releaseFirst(chromeOf('OLD'))
        await new Promise((r) => setTimeout(r, 100))
        expect(chromes).toEqual(['NEW'])
        const states = [...(agent as unknown as { deviceStates: Map<string, { loadedChrome: ChromeData | null }> }).deviceStates.values()]
        expect(states[0].loadedChrome).toEqual(chromeOf('NEW'))
        agent.disconnect(); browser.close()
      })

      it('does not answer a boot that a newer boot superseded', async () => {
        // `bootSeq` makes a superseded boot return silently, and the correlator is what lets a caller
        // see that: exactly one `device:ready` arrives and it carries the newer id. A correlator read
        // from shared device state would pass every test above and fail this one — which is why the
        // agents take it as a parameter.
        const { agent, browser } = await joined(mockSimctl(false))

        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-old',
          payload: { deviceId: 'dev-1' },
        }))
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-new',
          payload: { deviceId: 'dev-1' },
        }))

        const ready = await waitForType(browser, 'device:ready')
        expect(ready['requestId']).toBe('boot-new')
        // And nothing answers the superseded one afterwards.
        expect(await waitForTypeOrNull(browser, 'device:ready', 300)).toBeNull()

        agent.disconnect(); browser.close()
      })
    })

    // #440: simctl's `booted` alias means "whichever device is up", so with two simulators running
    // these commands could land on the wrong one — silently, since the wrong device accepts them
    // just fine. The guard is that every app command carries the session's udid, and the place it
    // can regress is the call site, not the wrapper: a default parameter on the wrapper would keep
    // every one of these compiling while the alias came back.
    //
    // Driven through the agent's own message handler rather than a browser socket. Going through
    // the relay would drag in its build lookup (`app:install` carries a buildId, not a filePath),
    // which is a different contract from the one under test here.
    describe('app commands target the session device (#440)', () => {
      type WithHandler = { handleRelayMessage(msg: Record<string, unknown>): void }
      const deliver = (agent: IOSAgent, msg: Record<string, unknown>) =>
        (agent as unknown as WithHandler).handleRelayMessage(msg)

      async function bootedAgent() {
        const simctl = mockSimctl(false)
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot', requestId: 'rq-fix-11', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' },
        }))
        await ready
        return { simctl, agent, browser }
      }

      // The DeviceAgent entry points have no device argument, so they resolve one themselves. With
      // several simulators registered — the normal case — "the first entry" is whichever simctl
      // listed first, usually shut down. That would be worse than the alias this PR removed: the
      // alias at least hit the device that was actually running.
      it('the DeviceAgent path picks the booted device, not the first registered one', async () => {
        const simctl = mockSimctlTwoDevices()
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const sessions = [...(agent as unknown as { deviceStates: Map<string, { deviceId: string }> }).deviceStates.entries()]
        const second = sessions.find(([, v]) => v.deviceId === 'dev-2')!

        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'session:start', sessionId: second[0] }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot', requestId: 'rq-fix-12', sessionId: second[0], payload: { deviceId: 'dev-2' },
        }))
        await ready

        // `installApp`, not `screenshot`: the MJPEG stream calls screenshot on a timer with the same
        // udid, so asserting on it would pass whatever this line did.
        await agent.installApp('/tmp/iface.app')
        expect(simctl.installApp).toHaveBeenCalledWith('dev-2', '/tmp/iface.app')

        agent.disconnect(); browser.close()
      })

      it('a session drives its own device, not the first registered one', async () => {
        const simctl = mockSimctlTwoDevices()
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const sessions = [...(agent as unknown as { deviceStates: Map<string, { deviceId: string }> }).deviceStates.entries()]
        const second = sessions.find(([, v]) => v.deviceId === 'dev-2')!

        deliver(agent, {
          type: 'app:install',
          requestId: 'rq-1',
          sessionId: second[0],
          payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.installApp).toHaveBeenCalled())

        expect(simctl.installApp).toHaveBeenCalledWith('dev-2', '/tmp/x.app')

        agent.disconnect()
      })

      // The launch failure reaches a dashboard toast. Node's first line is the argv, which echoes the
      // simulator UDID and says nothing a tester can act on — the same reason device:boot-error goes
      // through `firstLine`.
      it('app:launch-error carries simctl\'s reason, not the argv', async () => {
        const { simctl, agent, browser } = await bootedAgent()
        // Captured from `simctl launch` of an unknown bundle on an iOS 26.5 simulator. The lines ending in
        // a colon are headers; the reason a tester can act on is the first line that is not one.
        vi.mocked(simctl.launchApp).mockRejectedValueOnce(new Error(
          'Command failed: xcrun simctl launch 7273D5D7-3646-4042-BEBF-4CCDFF896AB0 com.example.app\n' +
          'An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\n' +
          'Simulator device failed to launch com.example.app.\n' +
          'Underlying error (domain=FBSOpenApplicationServiceErrorDomain, code=4):\n' +
          '\tThe request to open "com.example.app" failed.\n',
        ))
        const err = waitForType(browser, 'app:launch-error')
        deliver(agent, { type: 'app:launch', sessionId: agent.sessionId, requestId: 'why-1', payload: { bundleId: 'com.example.app' } })
        const msg = await err
        expect(msg['message']).toBe('Simulator device failed to launch com.example.app.')
        agent.disconnect(); browser.close()
      })

      // The reply direction, for all three app commands. Nothing asserted it before: review made all six
      // `respond` helpers emit a fabricated correlator and every suite held its baseline exactly, which is
      // the only guarantee this layer has — the compiler sees the field is present, never that it is the
      // request's.
      //
      // A wrong echo is now a *loss*, not a misattribution: the dashboard gate discards it and nothing
      // clears `installing`, and the MCP caller burns its full deadline.
      const PAIRS = [
        { req: 'app:install', payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' }, call: 'installApp' },
        { req: 'app:launch', payload: { bundleId: 'com.example.app' }, call: 'launchApp' },
        { req: 'app:clear-state', payload: { bundleId: 'com.example.app' }, call: 'clearAppData' },
      ] as const

      for (const { req, payload, call } of PAIRS) {
        it(`${req} echoes the requestId on both outcomes`, async () => {
          const { simctl, agent, browser } = await bootedAgent()

          const done = waitForType(browser, `${req}-done`)
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'echo-1', payload })
          expect((await done)['requestId']).toBe('echo-1')

          vi.mocked(simctl[call]).mockRejectedValueOnce(new Error('nope'))
          const err = waitForType(browser, `${req}-error`)
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'echo-2', payload })
          const msg = await err
          expect(msg['requestId']).toBe('echo-2')
          expect(msg['message']).toBe('nope')

          agent.disconnect(); browser.close()
        })

        it(`${req} answers two concurrent requests with their own ids`, async () => {
          // TC5. Hoisting the correlator out of per-request scope — a plausible "share `respond`" refactor
          // — compiles clean and passes every other test in this file. This is the only thing that sees it,
          // and concurrency is the reason the correlator exists at all.
          const { simctl, agent, browser } = await bootedAgent()

          let release: (() => void) | undefined
          // `call` is a union of keys, so `simctl[call]` is a union of methods and its
          // `mockImplementationOnce` parameter becomes their intersection — a signature no single
          // implementation satisfies. The cast names the one shape this table's entries share.
          vi.mocked(simctl[call] as () => Promise<void>)
            .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
            .mockImplementationOnce(() => Promise.resolve())

          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'con-A', payload })
          await vi.waitFor(() => expect(release).toBeDefined())

          // Sequential waits: `waitForType` does not correlate either, so two concurrent ones would hand
          // the first waiter whichever reply lands first — passing under the very mutation this catches.
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'con-B', payload })
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-B')

          release!()
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-A')

          agent.disconnect(); browser.close()
        })
      }

      it('install carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:install',
          requestId: 'rq-2',
          sessionId: agent.sessionId,
          payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.installApp).toHaveBeenCalled())

        expect(simctl.installApp).toHaveBeenCalledWith('dev-1', '/tmp/x.app')
        expect(simctl.uninstallApp).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      it('launch carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:launch',
          requestId: 'rq-3',
          sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.launchApp).toHaveBeenCalled())

        expect(simctl.launchApp).toHaveBeenCalledWith('dev-1', 'com.example.app', undefined)

        agent.disconnect(); browser.close()
      })

      // #1047. The wire handler calls simctl itself rather than `DeviceAgent.launchApp`, so the frame is what is tested.
      it('launch passes arguments and env through and reports their names, never their values', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        const done = waitForType(browser, 'app:launch-done')
        deliver(agent, {
          type: 'app:launch', requestId: 'rq-opt', sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app', arguments: { FIRDebugEnabled: true }, env: { API_TOKEN: 'secret' } },
        })
        const msg = await done
        expect(simctl.launchApp).toHaveBeenCalledWith('dev-1', 'com.example.app', { arguments: { FIRDebugEnabled: true }, env: { API_TOKEN: 'secret' } })
        expect(msg['applied']).toEqual({ arguments: ['FIRDebugEnabled'], env: ['API_TOKEN'] })
        expect(JSON.stringify(msg)).not.toContain('secret')

        agent.disconnect(); browser.close()
      })

      it('launch with empty option maps is a plain launch, with no applied keys', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        const done = waitForType(browser, 'app:launch-done')
        deliver(agent, { type: 'app:launch', requestId: 'rq-empty', sessionId: agent.sessionId, payload: { bundleId: 'com.example.app', arguments: {}, env: {} } })
        expect((await done)['applied']).toBeUndefined()
        expect(simctl.launchApp).toHaveBeenCalledWith('dev-1', 'com.example.app', undefined)

        agent.disconnect(); browser.close()
      })

      // The relay checks with the same function, but a relay of another version may check less, and this is the last
      // door before a command line.
      it('launch refuses options the shared check refuses, without launching', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        const err = waitForType(browser, 'app:launch-error')
        deliver(agent, { type: 'app:launch', requestId: 'rq-bad', sessionId: agent.sessionId, payload: { bundleId: 'com.example.app', env: { TAPFLOW_TARGET_BUNDLE: '' } } })
        const msg = await err
        expect(msg['requestId']).toBe('rq-bad')
        expect(msg['message']).toMatch(/reserved/)
        expect(simctl.launchApp).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // `open-url` had no test at all until the correlation work (L5) touched its handler — the iOS
      // suite passed the whole change because nothing exercised it. These two cover the echo and the
      // guard; Android's equivalents sit in its own suite.
      it('open-url echoes the requestId on both outcomes', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        const done = waitForType(browser, 'open-url:done')
        deliver(agent, {
          type: 'open-url',
          sessionId: agent.sessionId,
          requestId: 'req-1',
          payload: { url: 'https://example.com' },
        })
        expect((await done)['requestId']).toBe('req-1')
        expect(simctl.openUrl).toHaveBeenCalledWith('dev-1', 'https://example.com')

        vi.mocked(simctl.openUrl).mockRejectedValueOnce(new Error('no handler'))
        const err = waitForType(browser, 'open-url:error')
        deliver(agent, {
          type: 'open-url',
          sessionId: agent.sessionId,
          requestId: 'req-2',
          payload: { url: 'https://example.com' },
        })
        const msg = await err
        expect(msg['requestId']).toBe('req-2')
        expect(msg['message']).toBe('no handler')

        agent.disconnect(); browser.close()
      })

      it('answers two concurrent open-urls with their own ids', async () => {
        // The only reason this pair needs a correlator, and the case the echo tests above cannot see:
        // hoisting `requestId` out of per-request scope — a plausible "share `respond` across handlers"
        // refactor — compiles clean and passes every other test in this file, while both replies come
        // back carrying the *second* request's id. That is exactly the #499 class the layer removes.
        const { simctl, agent, browser } = await bootedAgent()

        let release: (() => void) | undefined
        vi.mocked(simctl.openUrl)
          .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
          .mockImplementationOnce(() => Promise.resolve())

        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, requestId: 'req-A', payload: { url: 'a://x' } })
        await vi.waitFor(() => expect(release).toBeDefined())

        // B is issued while A is still in flight, and completes first. The waits are sequential rather
        // than two concurrent `waitForType`s because that helper does not correlate either — the first
        // registered waiter takes the first arriving message, which would pass under the very mutation
        // this test exists to catch.
        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, requestId: 'req-B', payload: { url: 'b://y' } })
        expect((await waitForType(browser, 'open-url:done'))['requestId']).toBe('req-B')

        release!()
        expect((await waitForType(browser, 'open-url:done'))['requestId']).toBe('req-A')

        agent.disconnect(); browser.close()
      })

      it('open-url with no requestId is dropped rather than answered uncorrelatably', async () => {
        // Required on the wire with no fallback, so a reply here could not be matched by anyone, and
        // minting an id would make it look like an answer to a request nobody made. Third-party frames
        // are validated at the relay's door by #444; until then nothing is the honest outcome.
        const { simctl, agent, browser } = await bootedAgent()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, payload: { url: 'https://example.com' } })
        // Barrier then read, not a timeout: a round-trip proves the agent is done with the frame, so a
        // reply it was going to send is already recorded. A bare deadline passes whether the drop
        // happened or the reply merely arrived slowly.
        await barrier(browser)

        expect(await waitForTypeOrNull(browser, 'open-url:done', 0)).toBeNull()
        expect(simctl.openUrl).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('open-url without a requestId'))

        agent.disconnect(); browser.close()
      })

      it('clear-state carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:clear-state',
          requestId: 'rq-4',
          sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.clearAppData).toHaveBeenCalled())

        expect(simctl.clearAppData).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      // The compiler could not have caught this one: the old call was `screenshot(format)`, and
      // adding a leading `udid: string` left it type-correct — the format string simply became the
      // device id. Only an assertion on the arguments finds it.
      it('screenshot carries the udid, not the format string', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'screenshot:request',
          sessionId: agent.sessionId,
          requestId: 'req-1',
          format: 'png',
        })
        await vi.waitFor(() => expect(simctl.screenshot).toHaveBeenCalled())

        expect(simctl.screenshot).toHaveBeenCalledWith('dev-1', 'png')

        agent.disconnect(); browser.close()
      })
    })

    it('shuts a device down from a transient state too, not just Booted (#439)', async () => {
      // toDeviceStatus collapses Booting / Shutting Down / Creating into 'unknown', and erase
      // refuses every one of them. Re-picking a device while its device:shutdown is still draining
      // lands here, so a guard that only recognises 'booted' would fail the boot outright.
      const simctl = mockSimctl('unknown')
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-13',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('does not shut down a device that is already off', async () => {
      // The other direction of the same guard: without this, widening it to "always shut down"
      // would go unnoticed.
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-14',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).not.toHaveBeenCalled()
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('powers a device back up when the erase itself fails', async () => {
      // The shutdown is ours, not the tester's. Failing the erase after it would otherwise hand
      // back a dead device along with the error.
      const simctl = mockSimctl(true)
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('erase exploded'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-15',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      const err = await waitForType(browser, 'device:boot-error')

      expect(err.message).toContain('erase exploded')
      // Exactly one boot, and it comes after the failed erase — not the normal post-erase boot,
      // which never runs, and not a second attempt.
      expect(simctl.boot).toHaveBeenCalledTimes(1)
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    it('does not power up a device it never took down when the erase fails', async () => {
      // 'unknown' is Shutting Down / Creating: the device was on its way off, or had never run.
      // The recovery exists to undo *our* shutdown, so here there is nothing to undo — booting
      // would override what someone else asked for.
      const simctl = mockSimctl('unknown')
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('erase exploded'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-16',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      const err = await waitForType(browser, 'device:boot-error')

      expect(err.message).toContain('erase exploded')
      expect(simctl.boot).not.toHaveBeenCalled()

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
        requestId: 'rq-fix-17',
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

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-18', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).not.toHaveBeenCalled()
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('re-issues the boot even for a device the list reported as booted (#486)', async () => {
      // This used to assert the opposite — the boot was skipped when the list said `booted`. That
      // skip arrived with the original on-demand boot feature (`42a5ea6`) as an obvious economy,
      // with no recorded reason, and it became load-bearing in the wrong direction once
      // `waitUntilBooted` existed: it was the only path reaching the wait with **nothing bringing
      // the device up**, so a tester who ⌘Q'd the simulator in the width of one `xcrun` round trip
      // got a 90s deadline instead of a boot.
      //
      // A short grace on `shutdown` inside the poll was tried first and rejected in review: that
      // reading is not distinguishable from a slow machine's healthy boot, so the clock would fail
      // real boots to shorten a case that can simply be removed. `SimctlWrapper.boot` swallows
      // `Unable to boot device in current state: Booted`, so the cost for a device that really is
      // up is one no-op subprocess.
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-19', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
      // Not the erase path — that one has its own boot call and a very different meaning.
      expect(simctl.erase).not.toHaveBeenCalled()

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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-20', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-21', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-22', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await errPromise

      // exactly one erase + one retry — bounded, no infinite loop
      expect(simctl.erase).toHaveBeenCalledTimes(1)
      expect(simctl.boot).toHaveBeenCalledTimes(2)

      agent.disconnect()
      browser.close()
    })
  })

  describe('network control (#607)', () => {
    /** Boot dev-1 and return the browser socket the replies land on. */
    async function bootedSession(agent: IOSAgent): Promise<WebSocket> {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-net-boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      // The unsolicited report that follows `device:ready` — drained here so the tests below read the
      // reply to the request they sent rather than this one. That it is uncorrelated is the point of
      // it: nobody asked, so nothing is waiting, and it is what moves the dashboard's control out of
      // `waiting` for a device whose tester never touches the button.
      const opening = await waitForType(browser, 'network:state')
      expect(opening.requestId, 'the opening report answers a request nobody made').toBeUndefined()
      return browser
    }

    /**
     * A `SimulatorNetwork` that can actually take a device offline, unlike the agent's own — which is
     * deliberately pointed at a host binary that does not exist so no suite ever rewrites the
     * developer's live filter. Everything it needs lives in a temp directory: a script standing in for
     * the container app *and* the provider, and the state file it publishes.
     */
    function workingNetwork(dir: string): SimulatorNetwork {
      const host = path.join(dir, 'fake-host')
      fs.writeFileSync(
        host,
        `#!/bin/sh\n`
        + `if [ "$1" = "--confirm" ]; then\n`
        + `  R=$(cat "${dir}/rule" 2>/dev/null || echo "")\n`
        + `  [ -n "$R" ] && printf '{"enforcing":true,"rule":["%s"],"pid":1}\\n' "$R" || printf '{"enforcing":true,"rule":[],"pid":1}\\n'\n`
        + `  exit 0\n`
        + `fi\n`
        + `printf '%s' "\${2-}" > "${dir}/rule"\n`
        + `printf '{"at":%s,"pulseSeconds":1,"rule":["%s"]}\\n' "$(date +%s)" "\${2-}" > "${dir}/state.json"\n`,
        { mode: 0o755 },
      )
      // A real path: `state()` reports `hooks-not-installed` when the library is not on disk, and
      // this fixture used to name one that never existed.
      const hookDylib = path.join(dir, 'libtapflow-nethook.dylib')
      fs.writeFileSync(hookDylib, '')
      return new SimulatorNetwork(
        { setStatusBarOffline: async () => {}, setSimulatorEnv: async () => {} },
        {
          filterHostBinary: host,
          conditionDir: dir,
          verdictDir: dir,
          nethookDylib: hookDylib,
          filterStateFiles: [path.join(dir, 'state.json')],
          livenessIntervalMs: 20,
        },
      )
    }

    it('sends an uncorrelated report when enforcement stops under a device', async () => {
      // **The channel that had no test, and could not have had one.** The handler used to be attached
      // only inside the `??` that builds a `SimulatorNetwork` when none was injected — and every test
      // injects one — so deleting the wiring left the whole suite green. It is the only thing that
      // tells a tester a check they already signed off was invalidated; the refusal path beside it had
      // five tests and this had none.
      //
      // Driven through the real detection rather than by calling the handler: the frame a viewer gets
      // is the point, and a stub firing the callback would assert the wiring without the state behind
      // it.
      //
      // **One viewer, and the loop over sessions is still uncovered.** `reportEnforcementLost` walks
      // every session holding the device, and turning its `continue` into a `break` would go unnoticed
      // here. A second socket joining the same session gets no `session:joined` from this harness, and
      // two sessions on one device needs a rebind this describe does not set up — so the gap is
      // recorded rather than papered over.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-agent-net-'))
      const network = workingNetwork(dir)
      const agent = new IOSAgent({ intervalMs: 50, network }, mockSimctl(false))
      await agent.connect(`ws://localhost:${port}`)
      const browser = await bootedSession(agent)

      fs.writeFileSync(path.join(dir, 'tapflow-nethook-dev-1.json'), JSON.stringify({ installed: true }))
      browser.send(JSON.stringify({ type: 'network:set', requestId: 'rq-off', sessionId: agent.sessionId, payload: { offline: true } }))
      const confirmed = await waitForType(browser, 'network:state')
      expect(confirmed.payload, 'the device never got offline, so nothing could be lost').toEqual({ offline: true, available: true })

      // The provider stops publishing: the file freezes with the device still named in it.
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 30, pulseSeconds: 1, rule: ['dev-1'],
      }))

      const lost = await waitForType(browser, 'network:state')
      expect(lost.payload).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
      expect(lost.requestId, 'nobody asked for this — it must not correlate to a request').toBeUndefined()

      // **And it goes to every session holding the device, not the first one.** A device can sit
      // behind more than one, and the session that made the last request is not necessarily the one
      // whose tester is looking at it. Observed on the agent's own socket because a second viewer
      // cannot be stood up against one session in this harness — `session:start` for a session that is
      // already joined gets no `session:joined` back — so the assertion is on what the agent sends
      // rather than on what a second browser receives.
      const states = internals(agent).deviceStates
      // A session on a *different* device, inserted between the two that match — otherwise the loop's
      // skip is never taken and turning it into a `break` changes nothing observable.
      states.set('other-device-session', { booted: true, deviceId: 'dev-2' })
      states.set('other-session', { booted: true, deviceId: 'dev-1' })
      const sent: string[] = []
      const ws = internals(agent).ws!
      const realSend = ws.send.bind(ws)
      ws.send = ((data: string) => { sent.push(data); realSend(data) }) as typeof ws.send

      internals2(agent).reportEnforcementLost('dev-1')

      const addressed = sent
        .map((raw) => JSON.parse(raw) as { type: string; sessionId?: string; payload?: { reason?: string } })
        .filter((m) => m.type === 'network:state' && m.payload?.reason === 'enforcement-lost')
        .map((m) => m.sessionId)
      expect(new Set(addressed), 'the report reached one session and stopped')
        .toEqual(new Set([agent.sessionId, 'other-session']))
      states.delete('other-session')
      states.delete('other-device-session')

      network.dispose()
      agent.disconnect()
      browser.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('answers a toggle for a booted device with a state', async () => {
      // The control for the test below, and it is not a formality: `network:error` is also what an
      // agent that never wired the handler at all produces, so an assertion that a dead device gets
      // an error passes just as well on an agent where nothing works. This is what says the path
      // exists. The state itself is `filter-unavailable` here because the container app is not
      // installed on a test machine, which the class reports rather than pretends about.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      await agent.connect(`ws://localhost:${port}`)
      const browser = await bootedSession(agent)

      browser.send(JSON.stringify({ type: 'network:set', requestId: 'rq-net-1', sessionId: agent.sessionId, payload: { offline: true } }))
      const reply = await waitForType(browser, 'network:state')
      expect(reply.requestId).toBe('rq-net-1')
      // **And it reached no filter.** Layer 1 is a system extension on the developer's Mac; without
      // the guard in the constructor this line ran the notarized container app and rewrote the host's
      // live configuration, once per boot test. `filter-unavailable` is what a machine without that
      // app reports, so this pins the two to the same answer.
      //
      // Worth knowing what this does *not* catch: on a machine where the app is not installed both
      // answers are `filter-unavailable` anyway, so removing the guard fails here only on the machines
      // the guard is for. That is the population that matters and it is not everyone.
      expect(reply.payload).toEqual({ offline: false, available: false, reason: 'filter-unavailable' })

      agent.disconnect()
      browser.close()
    })

    it('still answers for a device that stayed up across a reconnect', async () => {
      // **`booted` is a cache, not the truth.** `initDeviceStates` runs on `agent:registered`, which
      // is every reconnect and not only the first connection, so the flag is `false` for a simulator
      // that has been running the whole time — the field's own comment says so, and `ackInput` carries
      // a simctl fallback for exactly this.
      //
      // Gated on the flag alone, a relay restart made the toggle answer `No booted device` for a
      // running device, and left `network:request-state` — the message a viewer's re-join sends,
      // which exists for precisely this moment — unanswered, so the control never left `waiting`.
      // That shipped once in this branch's own liveness fix.
      //
      // Driven by clearing the flag directly rather than by dropping the socket, because that is the
      // state a reconnect leaves and the socket's own recovery is covered under `reconnect`.
      //
      // Mutation: dropping the `isBooted` fallback from `deviceFor` fails here.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      const browser = await bootedSession(agent)

      for (const state of internals(agent).deviceStates.values()) state.booted = false

      browser.send(JSON.stringify({ type: 'network:set', requestId: 'rq-net-3', sessionId: agent.sessionId, payload: { offline: true } }))
      const reply = await waitForType(browser, 'network:state')
      expect(reply.requestId).toBe('rq-net-3')

      agent.disconnect()
      browser.close()
    })

    it('resolves the capability entry points against simctl when the cache says nothing is up', async () => {
      // `setNetworkOffline`/`networkState` are the in-process path — no session id, so they *find*
      // the device. They read `booted`, which `initDeviceStates` clears on every reconnect, so after
      // a relay restart they refused a simulator that was still running. The wire path is rescued by
      // `deviceFor`; these two have no equivalent and stayed broken until something else happened to
      // refresh the flag.
      //
      // Mutation: dropping the `listDevices` fallback from `soleLiveDeviceId` fails here.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      const browser = await bootedSession(agent)

      for (const state of internals(agent).deviceStates.values()) state.booted = false

      await expect(agent.networkState()).resolves.toMatchObject({ offline: false })

      agent.disconnect()
      browser.close()
    })

    it('still refuses when simctl agrees nothing is booted', async () => {
      // The other half, and it is what keeps the fallback from becoming "pick something". A cache
      // that says nothing and a simctl that says nothing is genuinely nothing.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      await agent.connect(`ws://localhost:${port}`)

      await expect(agent.networkState()).rejects.toThrow(/no booted device/i)

      agent.disconnect()
    })

    it('refuses a toggle for a device that has been shut down', async () => {
      // `deviceStates` holds one entry per *registered* simulator, so the session survives the
      // shutdown and its `deviceId` with it. Answering from that entry wrote the kernel rule for a
      // dead udid — and `arm()` is the only thing that clears it, on the next boot of that device.
      // Until then the host drops flows for a simulator that is not running, and one that reuses the
      // udid comes up offline with nothing on screen saying why.
      //
      // Mutation: dropping the `booted` check in `deviceFor` fails here.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      await agent.connect(`ws://localhost:${port}`)
      const browser = await bootedSession(agent)

      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-net-s', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      browser.send(JSON.stringify({ type: 'network:set', requestId: 'rq-net-2', sessionId: agent.sessionId, payload: { offline: true } }))
      const reply = await waitForType(browser, 'network:error')
      expect(reply.requestId).toBe('rq-net-2')
      expect(String(reply['message'])).toContain('No booted device')

      agent.disconnect()
      browser.close()
    })
  })

  describe('capability entry points after a reconnect (#646)', () => {
    // `initDeviceStates` runs on `agent:registered`, which fires on every reconnect — so `booted` is
    // false for simulators that never stopped running. Every entry point that resolved a device from
    // that flag alone refused a live device until an input or a boot happened to correct it.

    it('resolves a device for a non-network entry point when the cache says nothing is up', async () => {
      // `screenshot` stands for the five that can await. Before the fix it threw
      // `no booted device — call connect() first` against a running simulator.
      //
      // Mutation: reverting `screenshot` to the synchronous resolver fails here.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      for (const state of internals(agent).deviceStates.values()) state.booted = false

      await expect(agent.screenshot()).resolves.toBeInstanceOf(Buffer)

      agent.disconnect()
    })

    it('still refuses when simctl agrees the device is down', async () => {
      // The control. Without it the test above passes on a resolver that stopped checking anything.
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(false))
      await agent.connect(`ws://localhost:${port}`)

      await expect(agent.screenshot()).rejects.toThrow(/no booted device/i)

      agent.disconnect()
    })

    it('still resolves after a reconnect when a second simulator is also live', async () => {
      // **The case the simctl fallback alone could not answer.** After a reconnect every `booted`
      // flag is false, so the fallback asks simctl — and on a desk with the developer's own
      // simulator open it gets two live devices and refuses both. The five entry points stayed
      // broken in exactly the situation the fallback was added for.
      //
      // `ownedDevices` survives the map rebuild because the agent process does, so the boot this
      // agent performed still names its device.
      //
      // Mutation: dropping the `ownedDevices` filter from `soleLiveDeviceState` fails here with
      // "2 booted devices".
      const simctl = mockSimctl(true)
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
        { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
      ])
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-own', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // What a reconnect does: the map is rebuilt and every liveness flag goes with it.
      for (const state of internals(agent).deviceStates.values()) state.booted = false

      await expect(agent.screenshot()).resolves.toBeInstanceOf(Buffer)
      expect(simctl.screenshot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('keeps ownership when the shutdown itself fails', async () => {
      // Ownership is about the device, and a shutdown that throws leaves it running. Clearing it with
      // the session teardown — which is right to drop the moment a shutdown is asked for — handed an
      // ambiguous choice back to the resolvers for a simulator tapflow was still driving.
      //
      // Mutation: moving the `ownedDevices.delete` back above the `await` fails here.
      const simctl = mockSimctl(true)
      ;(simctl.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('device busy'))
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
        { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
      ])
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-sf', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-sf2', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(simctl.shutdown).toHaveBeenCalledWith('dev-1'), { timeout: 2000 })

      // The device is still up, so it is still the one tapflow means.
      for (const state of internals(agent).deviceStates.values()) state.booted = false
      await expect(agent.screenshot()).resolves.toBeInstanceOf(Buffer)
      expect(simctl.screenshot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('prefers the device this agent booted when another simulator is also up', async () => {
      // **The case both of the author's mutations were blind to: two simulators.** A developer with
      // Simulator.app open has a second device booted that tapflow did not boot, and `deviceStates`
      // holds an entry for it because the agent registers every device it can see.
      //
      // `booted` is what tells those apart — it means *this agent booted it* — so the cached branch
      // finds exactly one and answers. A "refresh" that marked everything simctl calls booted was
      // written, and removed: it erased that distinction and made all five refuse with
      // "2 booted devices" on an ordinary desk, permanently, with no path back.
      //
      // Mutation: marking both states booted before the call fails here, which is what re-adding
      // such a refresh would do.
      const simctl = mockSimctl(true)
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
        { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' },
      ])
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const states = [...internals(agent).deviceStates.values()]
      expect(states.length, 'both devices should be registered').toBe(2)
      // Only the one this agent booted carries the flag, which is the contract `device:boot` sets.
      states.forEach((st, i) => { st.booted = i === 0 })
      const mine = (states[0] as unknown as { deviceId: string }).deviceId

      await expect(agent.screenshot()).resolves.toBeInstanceOf(Buffer)
      expect(simctl.screenshot).toHaveBeenCalledWith(mine)

      agent.disconnect()
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

    // The viewer tells an iPad from an iPhone by this (#785 follow-up), and it can only read what the
    // register carried. Mutation: leave it out of the register literal — the explicit field list there
    // is what dropped `typeId` from the wire.
    it('includes the form factor its device type maps to', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')
      const sessions = listed.sessions as Array<{ devices: Array<{ formFactor?: string }> }>
      expect(sessions[0]?.devices[0]?.formFactor).toBe('phone')
      agent.disconnect()
      browser.close()
    })

    // A Mac whose simulator service cannot answer the lookup still registers every device — without
    // the field, which a viewer draws as a phone. Mutation: let the rejection propagate out of
    // `connect()`, and the whole Mac drops out of the list over a tooltip.
    it('registers without a form factor when the first lookup fails', async () => {
      const simctl = mockSimctl()
      ;(simctl.formFactorsByType as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('service wedged'))
      const agent = new IOSAgent({}, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')
      const sessions = listed.sessions as Array<{ devices: Array<{ name: string; formFactor?: string }> }>
      expect(sessions[0]?.devices[0]?.name).toBe('iPhone 15')
      expect(sessions[0]?.devices[0]?.formFactor).toBeUndefined()
      agent.disconnect()
      browser.close()
    })

    // A relay overwrites a session's device fields on every register, so a lookup that fails on a
    // reconnect — a simulator service slow after sleep — would blank a form factor the relay already
    // had, until the next reconnect. A udid's device type never changes, so the last good answer is
    // still the answer. Found by review of the formFactor PR.
    //
    // Mutation: fall back to an empty map rather than the last one.
    it('keeps the last form factors when a reconnect\'s lookup fails', async () => {
      const simctl = mockSimctl()
      ;(simctl.formFactorsByType as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(new Map([['type-iphone-15', 'phone']]))
        .mockRejectedValueOnce(new Error('service slow after sleep'))
      const agent = new IOSAgent({}, simctl)
      await agent.connect(`ws://localhost:${port}`)
      agent.disconnect()
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')
      const sessions = listed.sessions as Array<{ devices: Array<{ formFactor?: string }> }>
      expect(sessions.flatMap((s) => s.devices)[0]?.formFactor).toBe('phone')
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

    it('registers only the device matching deviceFilter (exposure filter, never boots)', async () => {
      const simctl = {
        ...mockSimctl(false),
        listDevices: vi.fn().mockResolvedValue([
          { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
          { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
        ]),
      } as unknown as SimctlWrapper
      const agent = new IOSAgent({ deviceFilter: 'iPhone 16' }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')

      const sessions = listed.sessions as Array<{ devices: Array<{ name: string }> }>
      const registered = sessions.flatMap((s) => s.devices)
      expect(registered).toHaveLength(1)
      expect(registered[0].name).toBe('iPhone 16')
      // connect registers only — booting is the dashboard/MCP's job (device:boot)
      expect(simctl.boot).not.toHaveBeenCalled()

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

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-23', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-24', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:key Backspace calls touchHelper.sendKey with HID usage 0x2A', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in29', sessionId: agent.sessionId, payload: { code: 'Backspace', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_BACKSPACE, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    // #1135: a flow's `imeAction` step. iOS's keyboard sends a field's action as Return.
    it('input:key ImeAction presses Return', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-ime', sessionId: agent.sessionId, payload: { code: 'ImeAction', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(0x28, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key KeyA calls touchHelper.sendKey with HID usage 0x04', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in30', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key with Shift modifier forwards modifier bits', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in31', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0x02 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0x02), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key unknown code is silently dropped', async () => {
      const { browser, agent, thInstance } = await setupSession()
      // Send unknown key first, then a known key as a sentinel.
      // WebSocket messages are ordered — when KeyA is processed, UnknownKey was already processed.
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in32', sessionId: agent.sessionId, payload: { code: 'UnknownKey', modifiers: 0 } }))
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in33', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-25', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in34', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
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
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in35', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => {
        const thInstance = MockTouchHelper.mock.results[0].value
        return expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      }, { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })
  })

  // #910: rotation was a toggle with a memory on each side, and the agent's reset on every
  // re-register while the simulator stayed put. These go through the relay, so they also hold that
  // the schema lets the target through — the relay forwards the parsed message, not the raw one.
  describe('input:rotate handler (#910)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    // A frame to re-send: under vitest the real loader finds no chrome, and a session with no frame gets no turn.
    const frameLoader = () => ({ load: vi.fn(async () => ({ framePng: 'f', compositeWidth: 100, compositeHeight: 200, buttons: [] })) }) as unknown as DeviceChromeLoader
    async function setupSession(sim = mockSimctl(true)) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50, chromeLoader: frameLoader() }, sim)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { browser, agent, sim }
    }
    const rotate = (browser: WebSocket, agent: IOSAgent, orientation?: 'portrait' | 'landscape') =>
      browser.send(JSON.stringify({
        type: 'input:rotate', sessionId: agent.sessionId, ...(orientation ? { payload: { orientation } } : {}),
      }))
    const targets = (sim: SimctlWrapper) => vi.mocked(sim.rotate).mock.calls.map((c) => c[1])

    // A fresh viewer starts portrait, so the simulator has to as well — before the chrome goes out,
    // which constructs the touch helper synchronously.
    //
    // Mutation: drop the boot reset, or move it after `sendChromeData`.
    it('stands the simulator up on boot, before describing it', async () => {
      const { browser, agent, sim } = await setupSession()
      expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'portrait')
      expect(vi.mocked(sim.rotate).mock.invocationCallOrder[0])
        .toBeLessThan(MockTouchHelper.mock.invocationCallOrder[0])
      agent.disconnect(); browser.close()
    })

    // Mutation: let the reset's failure escape. The boot then fails over a rotation.
    it('boots anyway when the reset fails', async () => {
      const sim = mockSimctl(true)
      vi.mocked(sim.rotate).mockRejectedValueOnce(new Error('helper timed out'))
      const { browser, agent } = await setupSession(sim)
      agent.disconnect(); browser.close()
    })

    // An older dashboard draws landscape as 270, which is the helper's `landscapeRight` (UIInterface names). A
    // second `landscape` is met already and sends nothing. Mutation: ignore the payload — the second toggles back.
    it('goes to the target it is given, however often', async () => {
      const { browser, agent, sim } = await setupSession()
      vi.mocked(sim.rotate).mockClear()
      rotate(browser, agent, 'landscape'); rotate(browser, agent, 'landscape'); rotate(browser, agent, 'portrait')
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledTimes(2), { timeout: 1000 })
      await new Promise((r) => setTimeout(r, 30))
      expect(targets(sim)).toEqual(['landscapeRight', 'portrait'])
      agent.disconnect(); browser.close()
    })

    it('toggles for a dashboard that sends no target', async () => {
      const { browser, agent, sim } = await setupSession()
      vi.mocked(sim.rotate).mockClear()
      rotate(browser, agent); rotate(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledTimes(2), { timeout: 1000 })
      expect(targets(sim)).toEqual(['landscapeRight', 'portrait'])
      agent.disconnect(); browser.close()
    })

    // Each rotation is its own helper process. Without the queue the second starts before the first
    // lands, and the simulator ends on whichever finishes last.
    //
    // Mutation: run the step directly instead of chaining it.
    it('sends one rotation at a time, in the order they came', async () => {
      const { browser, agent, sim } = await setupSession()
      vi.mocked(sim.rotate).mockClear()
      let release!: () => void
      vi.mocked(sim.rotate).mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
      rotate(browser, agent, 'landscape'); rotate(browser, agent, 'portrait')
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledTimes(1), { timeout: 1000 })
      await new Promise((r) => setTimeout(r, 30))
      expect(sim.rotate).toHaveBeenCalledTimes(1)
      release()
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledTimes(2), { timeout: 1000 })
      expect(targets(sim)).toEqual(['landscapeRight', 'portrait'])
      agent.disconnect(); browser.close()
    })

    // ── The physical model (four-way rotation) ──
    const chromeTurns = (browser: WebSocket) => {
      const turns: Array<number | undefined> = []
      browser.on('message', (d, isBinary) => {
        if (isBinary) return
        try { const m = JSON.parse(String(d)); if (m.type === 'session:chrome') turns.push(m.payload.streamRotation) } catch { /* not ours */ }
      })
      return turns
    }
    const turn = (browser: WebSocket, agent: IOSAgent, direction: 'clockwise' | 'counterclockwise' = 'clockwise') =>
      browser.send(JSON.stringify({ type: 'input:rotate', sessionId: agent.sessionId, payload: { direction } }))

    // A quarter clockwise from where it is held, four times round; Purple takes UIInterface names, so the
    // device's landscapeRight (90) is the helper's `landscapeLeft`. Mutation: send the device's own names.
    it('turns a quarter clockwise each time, and reports the turn it is held at', async () => {
      const { browser, agent, sim } = await setupSession()
      const turns = chromeTurns(browser)
      vi.mocked(sim.rotate).mockClear()
      for (let i = 0; i < 4; i++) turn(browser, agent)
      await vi.waitFor(() => expect(turns).toEqual([90, 180, 270, 0]), { timeout: 2000 })
      expect(targets(sim)).toEqual(['landscapeLeft', 'portraitUpsideDown', 'landscapeRight', 'portrait'])
      agent.disconnect(); browser.close()
    })

    // An older dashboard draws landscape as 270: from the other landscape it must turn, or it shows upside down.
    // Mutation: meet `landscape` with either landscape.
    it('takes an older viewer\'s landscape to the one it draws', async () => {
      const { browser, agent, sim } = await setupSession()
      turn(browser, agent) // held at 90
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'landscapeLeft'))
      vi.mocked(sim.rotate).mockClear()
      rotate(browser, agent, 'landscape')
      await vi.waitFor(() => expect(targets(sim)).toEqual(['landscapeRight']))
      agent.disconnect(); browser.close()
    })

    // The orientation is the device's: a reload or a second viewer joins it where it is rather than standing it
    // up under the first. A relay re-register builds every session's state afresh (`initDeviceStates`), which is
    // what a second session would have — this suite cannot hold two sessions on one device. Mutations: keep the
    // memory per session (`DeviceState`); stand it up on every boot.
    it('keeps a device where it is held when a session joins it afresh', async () => {
      const { browser, agent, sim } = await setupSession()
      turn(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'landscapeLeft'))
      vi.mocked(sim.rotate).mockClear()
      // As a relay loss does: the old state is cleaned up first (its audio poll would otherwise outlive the test),
      // then the re-register builds a fresh one.
      const inner = agent as unknown as {
        deviceStates: Map<string, unknown>
        cleanupDeviceState(state: unknown): void
        initDeviceStates(s: Array<{ deviceId: string; sessionId: string }>): void
      }
      for (const state of inner.deviceStates.values()) inner.cleanupDeviceState(state)
      inner.initDeviceStates([{ deviceId: 'dev-1', sessionId: agent.sessionId! }])
      const turns = chromeTurns(browser)
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-again', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(turns.at(-1)).toBe(90))
      expect(sim.rotate).not.toHaveBeenCalled()
      agent.disconnect(); browser.close()
    })

    // A device this boot brings up starts from nothing — what was remembered described the boot before.
    // Mutation: keep the memory across a cold boot.
    it('stands up a device it boots, whatever it remembered', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      turn(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'landscapeLeft'))
      vi.mocked(sim.rotate).mockClear()
      vi.mocked(sim.listDevices).mockResolvedValue([{ id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3', typeId: 'type-iphone-15' }])
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-cold', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      expect(targets(sim)).toEqual(['portrait'])
      agent.disconnect(); browser.close()
    })

    // A flow replays from the same orientation whatever a person left the device in. Mutation: drop `runReset`
    // from the stand-up condition.
    it('stands the device up for a run, wherever it was left', async () => {
      const sim = mockSimctl(true)
      // A run's reset steps; their outcome is not what this test is about.
      const ok = vi.fn(async () => {})
      Object.assign(sim, { uninstallAppForReset: ok, clearAppDataIfInstalled: ok, waitForBootStatus: ok, resetKeychain: ok, resetPrivacy: ok, clearLocation: ok })
      const { browser, agent } = await setupSession(sim)
      turn(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'landscapeLeft'))
      vi.mocked(sim.rotate).mockClear()
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-run', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', runReset: { uninstall: [], clear: [] } } }))
      await waitForType(browser, 'device:ready')
      expect(targets(sim)).toEqual(['portrait'])
      agent.disconnect(); browser.close()
    })

    // A session whose frame did not load is sent no turn, and its viewer draws the device upright — so the
    // device is stood up for it. Mutation: drop the frameless stand-up.
    it('stands the device up for a session that has no frame to carry the turn', async () => {
      const sim = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      // No chrome loader injected: under vitest the real one finds no frame.
      const agent = new IOSAgent({ intervalMs: 50 }, sim)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-nf1', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      turn(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledWith('dev-1', 'landscapeLeft'))
      vi.mocked(sim.rotate).mockClear()
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-nf2', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(targets(sim)).toEqual(['portrait']))
      agent.disconnect(); browser.close()
    })

    // On an Xcode 27 host the device says where it is held: it is reported as it is, never stood up, and a
    // turn starts from a fresh reading. Mutation: stand it up anyway; turn from the memory.
    it('reports and turns from what devicectl reads, where it can', async () => {
      let held = 'landscapeRight'
      const sim = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const turns = chromeTurns(browser)
      const agent = new IOSAgent({ intervalMs: 50, chromeLoader: frameLoader(), physicalOrientation: new PhysicalOrientation({ readOrientation: async () => ({ result: { deviceOrientation: held } }) }) }, sim)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-910-read', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(turns.at(-1)).toBe(90))
      expect(sim.rotate).not.toHaveBeenCalled()
      held = 'portraitUpsideDown' // turned in DeviceHub
      vi.mocked(sim.rotate).mockImplementation(async (_u, arg) => { held = arg === 'landscapeRight' ? 'landscapeLeft' : arg })
      turn(browser, agent)
      await vi.waitFor(() => expect(turns.at(-1)).toBe(270))
      expect(targets(sim)).toEqual(['landscapeRight'])
      agent.disconnect(); browser.close()
    })

    // The memory is what an older dashboard's next toggle reads. A rotation that failed left the
    // simulator where it was.
    //
    // Mutation: write the memory before the helper answers. The next toggle then goes to portrait,
    // which the simulator already is.
    it('keeps the memory where the simulator is when a rotation fails', async () => {
      const { browser, agent, sim } = await setupSession()
      vi.mocked(sim.rotate).mockClear()
      vi.mocked(sim.rotate).mockRejectedValueOnce(new Error('helper timed out'))
      rotate(browser, agent); rotate(browser, agent)
      await vi.waitFor(() => expect(sim.rotate).toHaveBeenCalledTimes(2), { timeout: 1000 })
      expect(targets(sim)).toEqual(['landscapeRight', 'landscapeRight'])
      agent.disconnect(); browser.close()
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

    // The close code alone cannot say who ended the connection; the line carries it with the time since the
    // relay's last ping so a stalled agent and a lost network read differently afterwards.
    it('logs the close code and ping age when the relay connection drops', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const agent = new IOSAgent({ reconnectDelays: [60_000] }, mockSimctl())
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
      const agent = new IOSAgent({ reconnectDelays: [0] }, mockSimctl())
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

    // An unbounded `simctl list` on a reconnect could hang the attempt for good — never settling, never
    // retrying. First connect stays unbounded, as `SimctlWrapper.listDevices` documents.
    it('bounds simctl list only on a reconnect attempt', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({ reconnectDelays: [0] }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      expect(vi.mocked(simctl.listDevices).mock.calls[0]).toEqual([undefined])
      const first = internals(agent).ws!
      first.terminate()
      await vi.waitFor(() => {
        const ws = internals(agent).ws
        expect(ws && ws !== first && ws.readyState === WebSocket.OPEN).toBe(true)
      }, { timeout: 2000 })
      expect(vi.mocked(simctl.listDevices).mock.calls.some((c) => c[0] === 10_000)).toBe(true)
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
        requestId: 'rq-fix-26',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', ...bootPayload },
      }))
      await waitForType(browser, 'device:ready')
      // mockSimctl(true) registers the device as already booted, so the relay replays a
      // device:ready on session:start — waitForType can latch that stale ack instead of this
      // boot's, and the mock read then saw zero calls (`undefined` vs the expected codec).
      // Sync on the streamer itself, which is what this test actually asserts.
      await vi.waitFor(() => expect(MockCapture.mock.calls.length).toBeGreaterThan(0), { timeout: 2000 })
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

  // #271 — 원격 릴레이 인증: token 옵션이 control/stream WS 업그레이드에 Bearer 헤더로 실린다.
  describe('relay auth token (#271)', () => {
    // 업그레이드 요청 헤더를 그대로 검증하기 위해 raw WebSocketServer 사용
    async function captureAuthHeader(token?: string): Promise<string | undefined> {
      const wss = new WebSocketServer({ port: 0 })
      const wssPort = (wss.address() as { port: number }).port
      const header = new Promise<string | undefined>((resolve) => {
        wss.on('connection', (sock, req) => {
          resolve(req.headers.authorization)
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        })
      })
      const agent = new IOSAgent(token ? { token } : {}, mockSimctl())
      await agent.connect(`ws://127.0.0.1:${wssPort}`)
      const result = await header
      agent.disconnect()
      await new Promise<void>((r) => wss.close(() => r()))
      return result
    }

    it('token 옵션이 있으면 control WS에 Authorization: Bearer 헤더가 실린다', async () => {
      expect(await captureAuthHeader('tflw_pat_test123')).toBe('Bearer tflw_pat_test123')
    })

    it('token이 없으면 Authorization 헤더를 보내지 않는다 (localhost 무인증 유지)', async () => {
      expect(await captureAuthHeader()).toBeUndefined()
    })

    it('원격 릴레이 + agent 스코프 PAT: control/stream WS 모두 인증되어 device:ready까지 도달한다', async () => {
      // 모든 연결을 비-루프백 출발지로 가장 → 무인증이면 stream WS도 1008로 거절된다
      const remoteSpy = vi
        .spyOn(relay as unknown as { remoteAddressOf: () => string }, 'remoteAddressOf')
        .mockReturnValue('192.168.0.77')
      const db = getDb()
      db.prepare(
        "INSERT OR IGNORE INTO users (id, email, display_name, role, password_hash) VALUES (9101, 'agent-e2e@test.local', 'E2E', 'Admin', 'x')",
      ).run()
      const insertPat = (scope: string): string => {
        const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
        db.prepare(
          'INSERT INTO personal_access_tokens (user_id, name, token_hash, scope, expires_at) VALUES (9101, ?, ?, ?, NULL)',
        ).run(`e2e-${raw.slice(-8)}`, crypto.createHash('sha256').update(raw).digest('hex'), scope)
        return raw
      }
      // agent 소켓은 agent 스코프, browser 소켓은 view 스코프 — 실제 역할에 맞는 자격을 쓴다
      const token = insertPat('agent')
      const browserToken = insertPat('view')

      const agent = new IOSAgent({ token }, mockSimctl(true))
      await agent.connect(`ws://127.0.0.1:${port}`)

      const browser = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${browserToken}` } })
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-27', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      agent.disconnect()
      browser.close()
      remoteSpy.mockRestore()
    })
  })

  // #271 — 핸드셰이크 견고성: 등록 전 close/무응답이 침묵 속에 영원히 멈추지 않는다.
  describe('handshake robustness (#271)', () => {
    async function withRawServer<T>(
      onConnection: (sock: import('ws').WebSocket) => void,
      run: (url: string) => Promise<T>,
    ): Promise<T> {
      const wss = new WebSocketServer({ port: 0 })
      // 느린 러너에서 address()가 null일 수 있으므로 listening 이후 포트를 읽는다
      await new Promise<void>((r) => wss.once('listening', r))
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', onConnection)
      try {
        return await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('등록 전 1008 close → code/reason을 담아 reject한다 (무한 대기 없음)', async () => {
      await withRawServer(
        (sock) => sock.close(1008, 'Unauthorized: agents need a PAT'),
        async (url) => {
          const agent = new IOSAgent({}, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/code=1008.*Unauthorized: agents need a PAT/)
        },
      )
    })

    it('agent:registered 응답이 없으면 handshakeTimeoutMs 후 reject한다', async () => {
      await withRawServer(
        () => { /* 업그레이드만 수락하고 무응답 */ },
        async (url) => {
          const agent = new IOSAgent({ handshakeTimeoutMs: 150 }, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/timed out after 150ms/)
        },
      )
    })

    // CodeRabbit #272 ② — malformed 첫 프레임이 핸들러에서 throw되어 connect()가 행되지 않는다
    it('등록 전 malformed(비-JSON) 프레임 → 행 없이 reject한다', async () => {
      await withRawServer(
        (sock) => sock.on('message', () => sock.send('not-json{{{')),
        async (url) => {
          const agent = new IOSAgent({ handshakeTimeoutMs: 1000 }, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/malformed|handshake/i)
        },
      )
    })
  })

  describe('audio output (whole-sim tap, default-on)', () => {
    beforeEach(() => {
      MockAudioStreamer.mockClear()
      mockLaunchAudioHelper.mockClear()
      delete process.env.TAPFLOW_AUDIO
    })
    afterEach(() => { delete process.env.TAPFLOW_AUDIO })

    async function bootSession(): Promise<{ agent: IOSAgent; browser: WebSocket }> {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-28', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { agent, browser }
    }

    it('TAPFLOW_AUDIO=off: no helper launched at boot', async () => {
      process.env.TAPFLOW_AUDIO = 'off'
      const { agent, browser } = await bootSession()
      await new Promise((r) => setTimeout(r, 30)) // give any async audio path a tick to (not) fire
      expect(MockAudioStreamer).not.toHaveBeenCalled()
      expect(mockLaunchAudioHelper).not.toHaveBeenCalled()
      agent.disconnect(); browser.close()
    })

    it('default-on (unset): boot launches the whole-sim tap with the enumerated sim pids', async () => {
      const { agent, browser } = await bootSession()
      await vi.waitFor(() => expect(mockLaunchAudioHelper).toHaveBeenCalledTimes(1))
      const [appPath, helperPort, pids] = mockLaunchAudioHelper.mock.calls[0]
      expect(appPath).toBe('/fake/audiotap-helper.app')
      expect(helperPort).toBe(54321) // AudioCaptureStreamer.listen() mock
      expect(pids).toEqual([101, 102, 103]) // enumerateSimPids mock — whole-sim, not a single app
      agent.disconnect(); browser.close()
    })

    it('cleanup on disconnect stops the audio streamer', async () => {
      const { agent, browser } = await bootSession()
      await vi.waitFor(() => expect(MockAudioStreamer).toHaveBeenCalledTimes(1))
      const instance = MockAudioStreamer.mock.results[0].value as { stop: ReturnType<typeof vi.fn> }
      agent.disconnect()
      expect(instance.stop).toHaveBeenCalled()
      browser.close()
    })

    // `tapflow flow run` and the MCP server send `device:boot` for a device that is already running, on
    // every run. Each boot used to stand up a new capture over the old one: an orphaned audiotap-helper
    // and one more 1.5s poll per run.
    it('re-booting a running device stops the previous capture and leaves one audio poll', async () => {
      const setSpy = vi.spyOn(globalThis, 'setInterval')
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      let session: { agent: IOSAgent; browser: WebSocket } | undefined
      try {
        session = await bootSession()
        const { agent, browser } = session
        await vi.waitFor(() => expect(mockLaunchAudioHelper).toHaveBeenCalledTimes(1))
        const first = MockAudioStreamer.mock.results[0].value as { stop: ReturnType<typeof vi.fn> }
        const audioPolls = () => setSpy.mock.results
          .filter((_, i) => setSpy.mock.calls[i][1] === 1500)
          .map((r) => r.value as ReturnType<typeof setInterval>)
        expect(audioPolls()).toHaveLength(1)
        const firstPoll = audioPolls()[0]
        expect(first.stop).not.toHaveBeenCalled()

        browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-reboot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
        await waitForType(browser, 'device:ready')
        await vi.waitFor(() => expect(mockLaunchAudioHelper).toHaveBeenCalledTimes(2))

        expect(first.stop).toHaveBeenCalled()
        expect(clearSpy).toHaveBeenCalledWith(firstPoll)
        const live = audioPolls().filter((h) => !clearSpy.mock.calls.some(([c]) => c === h))
        expect(live).toHaveLength(1)
        const second = MockAudioStreamer.mock.results[1].value as { stop: ReturnType<typeof vi.fn> }
        expect(second.stop).not.toHaveBeenCalled()
      } finally {
        session?.agent.disconnect()
        session?.browser.close()
        setSpy.mockRestore()
        clearSpy.mockRestore()
      }
    })

    // The sim's process tree and volume are read asynchronously now (`ps` held the event loop ~40 ms every
    // 1.5 s, which a drag showed as a hitch), so a read can land after the capture it was for has stopped.
    describe('reads that land after the capture stopped', () => {
      const mockEnumerate = vi.mocked(enumerateSimPids)
      const held = () => {
        let release!: (pids: number[]) => void
        const promise = new Promise<number[]>((r) => { release = r })
        return { promise, release }
      }
      beforeEach(() => mockEnumerate.mockClear())
      afterEach(() => { mockEnumerate.mockReset(); mockEnumerate.mockImplementation(() => Promise.resolve([101, 102, 103])) })

      it('launches no helper for a capture stopped while its first read was in flight', async () => {
        const first = held()
        mockEnumerate.mockImplementationOnce(() => first.promise)
        const { agent, browser } = await bootSession()
        await vi.waitFor(() => expect(mockEnumerate).toHaveBeenCalledTimes(1))
        agent.disconnect()
        first.release([101, 102, 103])
        await new Promise((r) => setTimeout(r, 30))
        expect(mockLaunchAudioHelper).not.toHaveBeenCalled()
        browser.close()
      })

      it('polls one read at a time, and hands a live capture the new pids when the read lands', async () => {
        const poll = held()
        mockEnumerate
          .mockImplementationOnce(() => Promise.resolve([101, 102, 103]))
          .mockImplementationOnce(() => poll.promise)
        const { agent, browser } = await bootSession()
        await vi.waitFor(() => expect(mockLaunchAudioHelper).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(mockEnumerate).toHaveBeenCalledTimes(2), { timeout: 3_000 })
        // A whole poll interval passes with that read still out: no second read is stacked on it.
        await new Promise((r) => setTimeout(r, 1_700))
        expect(mockEnumerate).toHaveBeenCalledTimes(2)
        const capture = MockAudioStreamer.mock.results[0].value as { updatePids: ReturnType<typeof vi.fn> }
        poll.release([101, 102, 103, 104])
        await vi.waitFor(() => expect(capture.updatePids).toHaveBeenCalledWith([101, 102, 103, 104]))
        // And the poll after it runs again.
        await vi.waitFor(() => expect(mockEnumerate).toHaveBeenCalledTimes(3), { timeout: 3_000 })
        agent.disconnect(); browser.close()
      }, 10_000)

      it('does not hand a stopped capture the pids of a poll that was in flight', async () => {
        const poll = held()
        mockEnumerate
          .mockImplementationOnce(() => Promise.resolve([101, 102, 103]))
          .mockImplementationOnce(() => poll.promise)
        const { agent, browser } = await bootSession()
        await vi.waitFor(() => expect(mockEnumerate).toHaveBeenCalledTimes(2), { timeout: 3_000 })
        const capture = MockAudioStreamer.mock.results[0].value as { updatePids: ReturnType<typeof vi.fn> }
        agent.disconnect()
        poll.release([101, 102, 103, 104])
        await new Promise((r) => setTimeout(r, 30))
        expect(capture.updatePids).not.toHaveBeenCalled()
        browser.close()
      }, 10_000)
    })
  })

  // The two memory reads run off the event loop now (they held it 4 ms in a built agent and ~200 ms under tsx,
  // every 5 s), so a sample can land after its socket closed, or while the next tick is due.
  describe('resource reports (agent:resources)', () => {
    type Sampler = { getMemoryUsage: () => Promise<{ memUsedMB: number; memTotalMB: number }>; getMemoryPressure: () => Promise<undefined> }
    type Internals = { resources: Sampler; reportResources: () => Promise<void>; sendOn: (ws: unknown, msg: { type: string }) => void }
    function holdSamples(agent: IOSAgent) {
      const internals = agent as unknown as Internals
      const releases: Array<() => void> = []
      internals.resources.getMemoryUsage = () => new Promise((r) => { releases.push(() => r({ memUsedMB: 1, memTotalMB: 2 })) })
      internals.resources.getMemoryPressure = () => Promise.resolve(undefined)
      const sendOn = vi.spyOn(internals, 'sendOn')
      const reports = () => sendOn.mock.calls.filter(([, msg]) => msg.type === 'agent:resources').length
      return { internals, releases, reports }
    }

    it('sends nothing for a sample that lands after its socket closed', async () => {
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl())
      const { releases, reports } = holdSamples(agent)
      await agent.connect(`ws://localhost:${port}`)
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      agent.disconnect()
      releases[0]()
      await new Promise((r) => setTimeout(r, 30))
      expect(reports()).toBe(0)
    })

    it('sends a sample that lands while its socket is open', async () => {
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl())
      const { releases, reports } = holdSamples(agent)
      await agent.connect(`ws://localhost:${port}`)
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      releases[0]()
      await vi.waitFor(() => expect(reports()).toBe(1))
      agent.disconnect()
    })

    it('takes one sample at a time, and the next once it lands', async () => {
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl())
      const { internals, releases, reports } = holdSamples(agent)
      await agent.connect(`ws://localhost:${port}`) // its own report is the one in flight
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      await internals.reportResources()
      expect(releases).toHaveLength(1)
      releases[0]()
      await vi.waitFor(() => expect(reports()).toBe(1))
      void internals.reportResources()
      expect(releases).toHaveLength(2)
      releases[1]()
      await vi.waitFor(() => expect(reports()).toBe(2))
      agent.disconnect()
    })

    it('reports on a new socket while the old socket\'s sample is still out, and leaves the new one in charge', async () => {
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl())
      const { internals, releases, reports } = holdSamples(agent)
      await agent.connect(`ws://localhost:${port}`)
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      agent.disconnect()
      await agent.connect(`ws://localhost:${port}`)
      // The reconnect's own report starts at once: the old socket's sample is not the new socket's.
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      // The old sample landing must not clear the flag the new one holds.
      releases[0]()
      await new Promise((r) => setTimeout(r, 10))
      void internals.reportResources()
      expect(releases).toHaveLength(2)
      releases[1]()
      await vi.waitFor(() => expect(reports()).toBe(1))
      agent.disconnect()
    })
  })

  describe('clipboard bridge', () => {
    // Every other describe resets this; without it a stale helper from an earlier test
    // satisfies the `results.length > 0` guards below and they assert nothing.
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function bootWith(simctl: SimctlWrapper): Promise<{ agent: IOSAgent; browser: WebSocket }> {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-29', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { agent, browser }
    }

    // The viewer gates the whole bridge on this. If the agent stops advertising it, copy and
    // paste silently degrade to device-only and nothing else in the suite would notice.
    // Asserted end to end (agent → relay → browser), which is the path the dashboard reads.
    it('advertises the clipboard capability all the way to the viewer', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      const joined = await waitForType<SessionJoined>(browser, 'session:joined')
      expect(joined.capabilities).toContain('clipboard')

      agent.disconnect(); browser.close()
    })

    // The same argument the clipboard case above makes, for the capability that replaced the
    // viewer's `os !== 'android'` check (#447): the agent's array is now the *only* switch behind
    // Full reset, so dropping `'full-reset'` from it removes the control with nothing else in any
    // suite to notice — the relay and dashboard tests all use hand-written capability fixtures.
    it('advertises the full-reset capability all the way to the viewer', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      const joined = await waitForType<SessionJoined>(browser, 'session:joined')
      expect(joined.capabilities).toContain('full-reset')

      agent.disconnect(); browser.close()
    })

    it('clipboard:read returns the simulator pasteboard as clipboard:data', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('한글 テスト 🎉\nline2')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r1' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect(data.requestId).toBe('r1')
      expect((data.payload as { text: string }).text).toBe('한글 テスト 🎉\nline2')
      expect(simctl.getPasteboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect(); browser.close()
    })

    // The core guarantee: the agent must not answer until the device clipboard actually
    // changed. A fixed delay cannot tell "copied" from "not copied yet"; the sentinel can.
    it('keeps watching until the pasteboard actually changes', async () => {
      const simctl = mockSimctl(true)
      let sentinel = ''
      let reads = 0
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { sentinel = t })
      // The app has not processed the chord yet on the first two reads.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () =>
        ++reads <= 3 ? sentinel : 'what the app copied')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p1', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('what the app copied')
      expect(reads).toBeGreaterThan(2)   // a fixed delay would have answered on the first read

      agent.disconnect(); browser.close()
    })

    // Re-copying the same text produces no value change at all, which is why a plain
    // value-change watch cannot work and the sentinel has to be written first.
    it('handles re-copying the identical text', async () => {
      const simctl = mockSimctl(true)
      let current = 'same text'
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { current = t })
      let reads = 0
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // after the chord, the app writes the very same text back over the sentinel
        if (++reads > 2) current = 'same text'
        return current
      })
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p2', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('same text')

      agent.disconnect(); browser.close()
    })

    it('fails and restores the original when the device never copies', async () => {
      const simctl = mockSimctl(true)
      let current = 'untouched original'
      const original = current
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { current = t })
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => current)
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p3', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/did not copy/i)
      // the sentinel must not be left behind on the device
      expect(simctl.setPasteboard).toHaveBeenLastCalledWith('dev-1', original)
      expect(current).toBe(original)

      agent.disconnect(); browser.close()
    }, 10_000)

    // Both of these are only reachable if the per-device queue fails, but the queue is the sole
    // thing standing between them and a corrupted clipboard, so the discrimination itself is
    // pinned rather than trusted.
    it('never hands a foreign sentinel back as copied text', async () => {
      const simctl = mockSimctl(true)
      const foreign = `\u200Btapflow-clipboard-someone-else`
      pasteboard = 'ORIGINAL'
      // Let our own sentinel land and be confirmed, then swap in another operation's marker —
      // which is what the chord-wait loop would see if the queue ever let two reads overlap.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const v = pasteboard
        if (v.startsWith('\u200Btapflow-clipboard-')) pasteboard = foreign
        return v
      })
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f1', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/did not copy/i)   // not clipboard:data carrying the marker

      agent.disconnect(); browser.close()
    }, 10_000)

    it('does not restore a foreign sentinel as if it were the user text', async () => {
      const simctl = mockSimctl(true)
      pasteboard = `\u200Btapflow-clipboard-someone-else`   // already parked when we arrive
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')        // the guest never copies
      // Restoring the marker would leave it for the NEXT read to mistake for the original.
      await vi.waitFor(() => expect(pasteboard).toBe(''), { timeout: 2000 })

      agent.disconnect(); browser.close()
    }, 10_000)

    // Mirrors the Android test of the same name. The queue has to stay held through the
    // restore, not just through the answer: the guest applies a write late, so releasing early
    // lets the next read mistake the still-parked sentinel for "the original" and then wipe it.
    it('serialises overlapping reads so they cannot trade sentinels', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      pasteboardApplyDelayMs = 120                    // the guest never copies; writes land late
      const { agent, browser } = await bootWith(simctl)

      const seen: string[] = []
      browser.on('message', (d: Buffer) => {
        try {
          const m = JSON.parse(d.toString()) as { type: string; requestId?: string; payload?: unknown }
          if (m.type === 'clipboard:data') seen.push(`${m.requestId}:${(m.payload as { text: string }).text}`)
          if (m.type === 'clipboard:error') seen.push(`${m.requestId}:ERR`)
        } catch { /* binary frame — ignore */ }
      })

      for (const requestId of ['P1', 'P2']) {
        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId, payload: { press: 'copy' },
        }))
      }
      await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 9000 })

      // Neither may report a sentinel as copied text, and the original must survive both.
      expect(seen).toEqual(['P1:ERR', 'P2:ERR'])
      await vi.waitFor(() => expect(pasteboard).toBe('ORIGINAL'), { timeout: 2000 })

      agent.disconnect(); browser.close()
    }, 20_000)

    it('press:copy sends Cmd+C and only then reads the pasteboard', async () => {
      const simctl = mockSimctl(true)
      const order: string[] = []
      // Track ordering without breaking the sentinel handshake — the read must keep reflecting
      // the real pasteboard, or the confirm loop can never be satisfied.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('read'); return pasteboard
      })
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockImplementation(() => { order.push('chord'); pasteboard = 'copied' })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(th.sendKey).toHaveBeenCalledWith(0x06, 0x08)   // KeyC + MetaLeft
      // reads the current value, writes the sentinel, presses, then polls
      expect(order.indexOf('chord')).toBeLessThan(order.lastIndexOf('read'))

      agent.disconnect(); browser.close()
    }, 15_000)
    // B1: pbcopy exiting does not mean the pasteboard shows the sentinel. Pressing the chord
    // early lets the first poll read the pre-sentinel value and return it as the copy result.
    it('waits for the sentinel to be visible before pressing the chord', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      pasteboard = 'THE USER ORIGINAL'
      pasteboardApplyDelayMs = 60              // the sim lags behind the accepted write
      copyOnChord(th, 'WHAT THE APP COPIED', 80)   // and the app copies later still

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b1', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('WHAT THE APP COPIED')

      agent.disconnect(); browser.close()
    }, 10_000)

    it('restores the original before releasing the device, even when the write lags', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      pasteboard = 'UNTOUCHED ORIGINAL'
      pasteboardApplyDelayMs = 40              // both the sentinel and the restore lag

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')
      // The reply now goes out BEFORE the restore (the restore is a `finally`, which runs after
      // the `catch` that answers), so the device may still hold the sentinel at this instant.
      // What must hold is that the restore completes while the queue is still held.
      await vi.waitFor(() => expect(pasteboard).toBe('UNTOUCHED ORIGINAL'), { timeout: 3000 })

      agent.disconnect(); browser.close()
    }, 15_000)

    // Restoring is cleanup, not part of answering. Making the viewer wait for it put a whole
    // deadline window inside the round trip, which is how the browser ended up giving up before
    // the agent's specific message arrived.
    it('answers before it restores, and still restores before releasing the device', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      pasteboard = 'ORIGINAL'
      // Make the restore slow enough that "reply first" cannot be an artefact of scheduling:
      // the answer has to arrive while the restore is demonstrably still running.
      let restoreDone = false
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => {
        if (t === 'ORIGINAL') {
          await new Promise((r) => setTimeout(r, 400))
          restoreDone = true
        }
        pasteboard = t
      })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'ord', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')
      expect(restoreDone).toBe(false)   // answered while the restore was still in flight
      await vi.waitFor(() => expect(restoreDone).toBe(true), { timeout: 3000 })

      agent.disconnect(); browser.close()
    }, 15_000)

    // The flag is what the viewer uses to decide whether pressing the plain chord is safe.
    // Emitting it correctly was untested on the agent side in both polarities.
    it('reports a parked sentinel when the copy failed after the marker went down', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp1', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

      agent.disconnect(); browser.close()
    }, 10_000)

    it('reports no parked sentinel when it failed before writing one', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      // Reading the original is the last step before the marker goes down.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PlatformError('Could not read the device clipboard: simctl pbpaste timed out'))

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp2', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(false)

      agent.disconnect(); browser.close()
    }, 10_000)

    // The flag describes the DEVICE, not the operation that answers. A caller that never touched
    // the clipboard must still report a marker another operation has down — the chord the viewer
    // would press in response travels as `input:key`, outside the queue that keeps them apart.
    it('reports a sentinel parked by a different in-flight operation', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'hold', payload: { press: 'copy' },
      }))
      await vi.waitFor(() => expect(isSentinelish(pasteboard)).toBe(true), { timeout: 2000 })

      // Rejected up front, before the queue — so it answers while the read above still holds.
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'big',
        payload: { text: 'x'.repeat(MAX_CLIPBOARD_BYTES + 1) },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.requestId).toBe('big')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

      // Let the read finish before leaving: it still holds the device queue.
      await vi.waitFor(() => expect(pasteboard).toBe('ORIGINAL'), { timeout: 5000 })

      agent.disconnect(); browser.close()
    }, 20_000)

    it('press:cut sends Cmd+X instead', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      copyOnChord(th)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r3', payload: { press: 'cut' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(th.sendKey).toHaveBeenCalledWith(0x1b, 0x08)   // KeyX + MetaLeft

      agent.disconnect(); browser.close()
    }, 15_000)
    it('hides a visible software keyboard before pressing copy', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      ;(simctl.hideSoftwareKeyboard as ReturnType<typeof vi.fn>).mockClear()
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      copyOnChord(MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r4', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect(); browser.close()
    }, 15_000)
    it('clipboard:write sets the pasteboard and acks only after it landed', async () => {
      const simctl = mockSimctl(true)
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockReturnValue(gate)
      const { agent, browser } = await bootWith(simctl)

      let acked = false
      void waitForType(browser, 'clipboard:write-done').then(() => { acked = true })
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r5', payload: { text: 'pasted text' },
      }))
      await vi.waitFor(() => expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', 'pasted text'))
      await new Promise((r) => setTimeout(r, 50))
      expect(acked).toBe(false)     // the write has not settled yet
      release()
      await vi.waitFor(() => expect(acked).toBe(true))

      agent.disconnect(); browser.close()
    })

    it('pasteAfter presses Cmd+V after the write, before the ack', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()

      const done = waitForType(browser, 'clipboard:write-done')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r6', payload: { text: 'x', pasteAfter: true },
      }))
      await done
      expect(th.sendKey).toHaveBeenCalledWith(0x19, 0x08)   // KeyV + MetaLeft
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', 'x')

      agent.disconnect(); browser.close()
    })

    it('answers clipboard:error when the paste chord is dropped (#482)', async () => {
      // The pasteboard deadline above proves the device took the text, not that the chord
      // reached it — so a dead input channel here used to answer clipboard:write-done having
      // pasted nothing into the app.
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      killHelper(th)

      const errored = waitForType(browser, 'clipboard:error')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r6b', payload: { text: 'x', pasteAfter: true },
      }))
      expect((await errored).message).toContain('no input channel')

      agent.disconnect(); browser.close()
    })

    it('does not press paste when pasteAfter is not asked for', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()   // shared mock across tests in this file

      const done = waitForType(browser, 'clipboard:write-done')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r7', payload: { text: 'x' },
      }))
      await done
      expect(th.sendKey).not.toHaveBeenCalled()

      agent.disconnect(); browser.close()
    })

    it('rejects an oversized clipboard instead of forwarding it', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r8',
        payload: { text: 'x'.repeat(1024 * 1024 + 1) },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/too large/i)
      expect(simctl.setPasteboard).not.toHaveBeenCalled()

      agent.disconnect(); browser.close()
    })

    // The size ceiling is enforced inside getPasteboard (maxBuffer). Hitting it means the app
    // DID copy, so restoring the original here would overwrite the user's fresh copy.
    // The counterpart of the test below. A timed-out pbpaste says nothing about whether the app
    // copied, so treating it like the size ceiling stranded the sentinel on the device for good:
    // the user's clipboard destroyed, and an invisible marker pasted into the app under test.
    it('restores the original when a read fails for any reason other than size', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      pasteboard = 'THE USER ORIGINAL'
      let chordPressed = false
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (chordPressed) throw new PlatformError('Could not read the device clipboard: simctl pbpaste timed out')
        return pasteboard
      })
      th.sendKey.mockImplementation(() => { chordPressed = true })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'slow', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/timed out/i)
      await vi.waitFor(() => expect(pasteboard).toBe('THE USER ORIGINAL'), { timeout: 2000 })
      expect(isSentinelish(pasteboard)).toBe(false)

      agent.disconnect(); browser.close()
    }, 10_000)

    it('keeps the device copy when the pasteboard is too large to read', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      pasteboard = 'THE USER ORIGINAL'
      let sentinelSeen = ''
      let chordPressed = false
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (isSentinelish(pasteboard)) sentinelSeen = pasteboard
        // Only the post-chord read blows the buffer — the app has copied something huge by then.
        // The specific type is the point: SimctlWrapper classifies the size ceiling apart from
        // every other read failure, and only this one may skip the restore.
        if (chordPressed && !isSentinelish(pasteboard)) {
          throw new ClipboardTooLargeError('Could not read the device clipboard: stdout maxBuffer length exceeded')
        }
        return pasteboard
      })
      th.sendKey.mockImplementation(() => { chordPressed = true; pasteboard = 'HUGE COPIED TEXT' })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'big', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/maxBuffer|too large/i)
      expect(sentinelSeen).not.toBe('')                       // the handshake did run
      // and the restore must NOT have fired over the fresh copy
      expect(simctl.setPasteboard).not.toHaveBeenCalledWith('dev-1', 'THE USER ORIGINAL')

      agent.disconnect(); browser.close()
    }, 15_000)

    it('surfaces a pasteboard read failure as clipboard:error, not an empty string', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Unable to connect to device pasteboard.'))
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r9' }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.requestId).toBe('r9')
      expect(err.message).toContain('pasteboard')

      agent.disconnect(); browser.close()
    })

    // Reading needs no TouchHelper, so unlike tap/swipe a plain read works on a session that
    // attached without going through device:boot (the H-E failure mode).
    it('a plain read works on a boot-less session', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('attached without boot')
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r10' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('attached without boot')

      agent.disconnect(); browser.close()
    })

    it('an empty pasteboard is data, not an error', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r11' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('')

      agent.disconnect(); browser.close()
    })
  })


  // ── Lean mode: applied while tapflow runs a device, put back when tapflow shuts it down ──────────
  describe('Lean mode', () => {
    let leanRoot: string
    let store: LeanStore
    let order: string[]
    beforeEach(() => {
      leanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-lean-agent-'))
      store = new LeanStore(leanRoot)
      order = []
      lastReady = { promise: Promise.resolve({}), resolve: () => {} }
      // `setTier` reverts before it applies; only the top-level calls are the agent's decisions, so a revert made
      // inside one is not recorded on its own.
      let inSetTier = false
      const setTier = store.setTier.bind(store)
      const revert = store.revert.bind(store)
      vi.spyOn(store, 'setTier').mockImplementation((udid, tier, labels) => {
        order.push(`tier:${tier.name}`)
        inSetTier = true
        try { setTier(udid, tier, labels) } finally { inSetTier = false }
      })
      vi.spyOn(store, 'revert').mockImplementation((udid) => { if (!inSetTier) order.push('revert'); return revert(udid) })
    })
    afterEach(() => fs.rmSync(leanRoot, { recursive: true, force: true }))

    /** A device on a runtime Lean mode supports; `mockSimctl`'s default iOS 18.3 is below the cut. */
    function simctlOn(status: 'shutdown' | 'booted', osVersion = 'iOS 26.5') {
      const simctl = mockSimctl(status === 'booted')
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status, osVersion },
      ])
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('boot') })
      ;(simctl.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('shutdown') })
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('erase') })
      return simctl
    }

    async function boot(simctl: SimctlWrapper, lean: boolean, payload: Record<string, unknown> = {}, afterConnect = () => {}) {
      const agent = new IOSAgent({ intervalMs: 50, lean, leanStore: store }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      afterConnect()
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-lean', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', ...payload } }))
      const ready = await waitForType(browser, 'device:ready')
      lastReady.resolve(ready['payload'] as Record<string, unknown>)
      return { agent, browser }
    }
    /** The payload of the next boot's ready, read by `boot` from the frame it already waits for. */
    let lastReady: { promise: Promise<Record<string, unknown>>; resolve: (p: Record<string, unknown>) => void }
    function waitForReadyPayload(): Promise<Record<string, unknown>> {
      let resolve!: (p: Record<string, unknown>) => void
      const promise = new Promise<Record<string, unknown>>((r) => { resolve = r })
      lastReady = { promise, resolve }
      return promise
    }

    it('disables the labels before booting a device that is shut down', async () => {
      const { agent, browser } = await boot(simctlOn('shutdown'), true)
      expect(order).toEqual(['tier:lean', 'boot'])
      expect(store.setTier).toHaveBeenCalledWith('dev-1', { name: 'lean', keep: [] }, LEAN_LABELS)
      expect(store.isApplied('dev-1')).toBe(true)
      agent.disconnect(); browser.close()
    })

    it('leaves a device that is already running alone, and still boots it', async () => {
      // The twin of the case above: the store is only written while launchd_sim is not reading it.
      const { agent, browser } = await boot(simctlOn('booted'), true)
      expect(order).toEqual(['boot'])
      expect(store.isApplied('dev-1')).toBe(false)
      agent.disconnect(); browser.close()
    })

    it('sets the tier after a full erase has succeeded, before the device boots again', async () => {
      const { agent, browser } = await boot(simctlOn('booted'), true, { resetMode: 'full-erase' })
      expect(order).toEqual(['shutdown', 'erase', 'tier:lean', 'boot'])
      agent.disconnect(); browser.close()
    })

    it('leaves the tier alone when the erase fails, so the device comes back as it was found', async () => {
      const simctl = simctlOn('booted')
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('erase'); throw new Error('disk full') })
      const agent = new IOSAgent({ intervalMs: 50, lean: true, leanStore: store }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-erase', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', resetMode: 'full-erase', serviceTier: { name: 'slim', keep: [] } } }))
      await waitForType(browser, 'device:boot-error')
      expect(order).toEqual(['shutdown', 'erase', 'boot'])
      expect(store.isApplied('dev-1')).toBe(false)
      agent.disconnect(); browser.close()
    })

    it('applies from iOS 18.5 on, the first runtime it supports', () => {
      expect(leanSupported('iOS 18.5')).toBe(true)
      expect(leanSupported('iOS 27.0')).toBe(true)
      expect(leanSupported('iOS 18.4')).toBe(false)
    })

    it('does nothing to a device on a runtime it does not support', async () => {
      for (const osVersion of ['iOS 18.4', 'tvOS 26.0', 'watchOS 26.0', 'iOS']) {
        order = []
        const { agent, browser } = await boot(simctlOn('shutdown', osVersion), true)
        expect(order, osVersion).toEqual(['boot'])
        agent.disconnect(); browser.close()
      }
    })

    it('boots anyway when the store cannot be written', async () => {
      vi.mocked(store.setTier).mockImplementation(() => { order.push('tier:lean'); throw new Error('EACCES') })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { agent, browser } = await boot(simctlOn('shutdown'), true)
      expect(order).toEqual(['tier:lean', 'boot'])
      agent.disconnect(); browser.close()
    })

    it('puts the labels back once it has shut the device down', async () => {
      const simctl = simctlOn('shutdown')
      const { agent, browser } = await boot(simctl, true)
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-off', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')
      expect(order).toEqual(['tier:lean', 'boot', 'shutdown', 'revert'])
      expect(store.isApplied('dev-1')).toBe(false)
      agent.disconnect(); browser.close()
    })

    it('still answers the shutdown when the labels cannot be put back', async () => {
      const simctl = simctlOn('shutdown')
      const { agent, browser } = await boot(simctl, true)
      vi.mocked(store.revert).mockImplementation(() => { order.push('revert'); throw new Error('unreadable') })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-off', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')
      expect(order).toEqual(['tier:lean', 'boot', 'shutdown', 'revert'])
      agent.disconnect(); browser.close()
    })

    it('with Lean mode off, puts back a device it left lean before booting it', async () => {
      // Marked after connect, so it is the boot path doing this and not the sweep below.
      const { agent, browser } = await boot(simctlOn('shutdown'), false, {}, () => {
        store.setTier('dev-1', { name: 'lean', keep: [] }, LEAN_LABELS)
        order = []
      })
      expect(order).toEqual(['tier:stock', 'boot'])
      expect(store.isApplied('dev-1')).toBe(false)
      agent.disconnect(); browser.close()
    })

    describe('service tiers', () => {
      const SLIM: ServiceTier = { name: 'slim', keep: ['push'] }
      const LEAN: ServiceTier = { name: 'lean', keep: [] }

      it('boots a shut-down device onto the tier a run asked for, and says so on ready', async () => {
        const ready = waitForReadyPayload()
        const { agent, browser } = await boot(simctlOn('shutdown'), true, { serviceTier: SLIM })
        expect(order).toEqual(['tier:slim', 'boot'])
        expect(store.setTier).toHaveBeenCalledWith('dev-1', SLIM, labelsFor(SLIM))
        expect(labelsFor(SLIM)).not.toContain('com.apple.apsd') // push kept on
        // Wallet's passd crashes at start-up without financed, so keeping Wallet keeps both.
        const wallet = labelsFor({ name: 'slim', keep: ['wallet'] })
        expect(wallet).not.toContain('com.apple.passd')
        expect(wallet).not.toContain('com.apple.financed')
        expect(await ready).toMatchObject({ cold: true, serviceTier: SLIM })
        agent.disconnect(); browser.close()
      })

      it('restarts a running device that is on another tier', async () => {
        const ready = waitForReadyPayload()
        const { agent, browser } = await boot(simctlOn('booted'), true, { serviceTier: SLIM }, () => {
          store.setTier('dev-1', LEAN, labelsFor(LEAN))
          order = []
        })
        expect(order).toEqual(['shutdown', 'tier:slim', 'boot'])
        expect(await ready).toMatchObject({ cold: true, serviceTier: SLIM })
        agent.disconnect(); browser.close()
      })

      it('leaves a running device that is already on the tier', async () => {
        const ready = waitForReadyPayload()
        const { agent, browser } = await boot(simctlOn('booted'), true, { serviceTier: SLIM }, () => {
          store.setTier('dev-1', SLIM, labelsFor(SLIM))
          order = []
        })
        expect(order).toEqual(['boot'])
        expect(await ready).toMatchObject({ cold: false, serviceTier: SLIM })
        agent.disconnect(); browser.close()
      })

      it('puts a device a run left slim back on exactly the default tier for a boot that asks for none', async () => {
        // R4-S1: adding Lean mode's labels to slim's would leave slim's on, and hand a person a device without push.
        const { agent, browser } = await boot(simctlOn('shutdown'), true, {}, () => {
          store.setTier('dev-1', SLIM, labelsFor(SLIM))
          order = []
        })
        expect(order).toEqual(['tier:lean', 'boot'])
        expect(store.currentTier('dev-1')).toEqual(LEAN)
        const disabled = parseDisabledStore(fs.readFileSync(path.join(leanRoot, 'com.apple.CoreSimulator.SimDevice.dev-1', 'disabled.plist'), 'utf8'))
        expect(Object.keys(disabled).sort()).toEqual([...LEAN_LABELS].sort())
        agent.disconnect(); browser.close()
      })

      it('reports each device\'s tier when it registers', async () => {
        store.setTier('dev-1', SLIM, labelsFor(SLIM))
        const agent = new IOSAgent({ intervalMs: 50, lean: true, leanStore: store }, simctlOn('booted'))
        const listed = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(listed)
        await agent.connect(`ws://localhost:${port}`)
        listed.send(JSON.stringify({ type: 'agents:list' }))
        const msg = await waitForType(listed, 'agents:listed')
        const devices = (msg['sessions'] as Array<{ devices: Array<{ serviceTier?: unknown }> }>)[0]!.devices
        expect(devices[0]!.serviceTier).toEqual(SLIM)
        agent.disconnect(); listed.close()
      })
    })

    describe('on connect', () => {
      it('puts back a shut-down device an earlier run left lean', async () => {
        store.setTier('dev-1', { name: 'lean', keep: [] }, LEAN_LABELS)
        const agent = new IOSAgent({ intervalMs: 50, lean: true, leanStore: store }, simctlOn('shutdown'))
        await agent.connect(`ws://localhost:${port}`)
        expect(store.isApplied('dev-1')).toBe(false)
        agent.disconnect()
      })

      it('leaves one that is still running, and one that no longer exists', async () => {
        // The twin of the case above.
        store.setTier('dev-1', { name: 'lean', keep: [] }, LEAN_LABELS)
        store.setTier('gone-1', { name: 'lean', keep: [] }, LEAN_LABELS)
        const agent = new IOSAgent({ intervalMs: 50, lean: true, leanStore: store }, simctlOn('booted'))
        await agent.connect(`ws://localhost:${port}`)
        expect(store.isApplied('dev-1')).toBe(true)
        expect(store.isApplied('gone-1')).toBe(true)
        agent.disconnect()
      })
    })
  })

  describe('run reset (flow run)', () => {
    const RESET = { uninstall: ['com.example.app'], clear: ['com.example.helper'] }
    let calls: string[]

    function resetSimctl(booted: boolean) {
      calls = []
      const simctl = mockSimctl(booted)
      const record = (name: string) => vi.fn(async (_udid: string, id?: string) => { calls.push(id ? `${name}:${id}` : name) })
      Object.assign(simctl, {
        uninstallAppForReset: record('uninstall'),
        clearAppDataIfInstalled: record('clear'),
        waitForBootStatus: record('bootstatus'),
        resetKeychain: record('keychain'),
        resetPrivacy: record('privacy'),
        clearLocation: record('location'),
        resetKeyboardLanguage: vi.fn(async () => { calls.push('keyboard') }),
      })
      return simctl
    }

    async function bootWith(simctl: SimctlWrapper, payload: Record<string, unknown>) {
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-reset', sessionId: agent.sessionId, payload: { deviceId: 'dev-1', ...payload } }))
      return { agent, browser }
    }

    it('resets the apps and the device before ready, and reports each item', async () => {
      const simctl = resetSimctl(true)
      const { agent, browser } = await bootWith(simctl, { runReset: RESET })
      const ready = await waitForType(browser, 'device:ready')
      // The keyboard last and unreported (#1135): its first language, where a Flow Capture replay starts too.
      expect(calls).toEqual(['bootstatus', 'uninstall:com.example.app', 'clear:com.example.helper', 'keychain', 'privacy', 'location', 'keyboard'])
      // Bounded by what is left of the reset's budget, never unbounded.
      const [, timeoutMs] = vi.mocked(simctl.resetKeyboardLanguage).mock.calls[0]!
      expect(timeoutMs).toBeGreaterThan(0)
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', '')
      expect((ready['payload'] as Record<string, unknown>)['runReset']).toEqual({
        done: ['app-uninstall', 'app-files', 'keychain', 'privacy-services', 'pasteboard', 'location'], failed: [],
      })
      agent.disconnect(); browser.close()
    })

    // Also when the device was already listed `Booted`: it may have been booted moments ago by someone else.
    it('waits for the system services before resetting a device it just booted', async () => {
      const simctl = resetSimctl(false)
      const { agent, browser } = await bootWith(simctl, { runReset: { uninstall: [], clear: [] } })
      await waitForType(browser, 'device:ready')
      expect(calls).toEqual(['bootstatus', 'keychain', 'privacy', 'location', 'keyboard'])
      agent.disconnect(); browser.close()
    })

    it('goes on past an item that fails, and the boot still succeeds', async () => {
      const simctl = resetSimctl(true)
      vi.mocked(simctl.resetKeychain).mockRejectedValue(new Error('keychain busy'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { agent, browser } = await bootWith(simctl, { runReset: { uninstall: [], clear: [] } })
      const ready = await waitForType(browser, 'device:ready')
      expect((ready['payload'] as Record<string, unknown>)['runReset']).toEqual({
        done: ['privacy-services', 'pasteboard', 'location'], failed: ['keychain'],
      })
      agent.disconnect(); browser.close()
    })

    // On Android the same id reaches the device's shell, so neither platform passes one that is not an app id.
    it('fails the app item for an id that is not an app id, and never passes it on', async () => {
      const simctl = resetSimctl(true)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { agent, browser } = await bootWith(simctl, { runReset: { uninstall: [], clear: ['x;reboot', 'com.example.ok'] } })
      const ready = await waitForType(browser, 'device:ready')
      expect(calls).toContain('clear:com.example.ok')
      expect(calls.some((c) => c.includes('reboot'))).toBe(false)
      expect((ready['payload'] as { runReset: { failed: string[] } }).runReset.failed).toEqual(['app-files'])
      agent.disconnect(); browser.close()
    })

    it('resets nothing for a boot that did not ask', async () => {
      const simctl = resetSimctl(true)
      const { agent, browser } = await bootWith(simctl, {})
      const ready = await waitForType(browser, 'device:ready')
      expect(calls).toEqual([])
      expect(ready['payload']).not.toHaveProperty('runReset')
      agent.disconnect(); browser.close()
    })

    it('answers the boot as abandoned when a shutdown arrives mid-reset', async () => {
      const simctl = resetSimctl(true)
      let release!: () => void
      vi.mocked(simctl.resetKeychain).mockImplementation(() => new Promise<void>((r) => { release = r }))
      const { agent, browser } = await bootWith(simctl, { runReset: { uninstall: [], clear: [] } })
      await vi.waitFor(() => expect(simctl.resetKeychain).toHaveBeenCalled(), { timeout: 2000 })
      const abandoned = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-off', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await vi.waitFor(() => expect(simctl.shutdown).toHaveBeenCalled(), { timeout: 2000 })
      release()
      const e = await abandoned
      expect(e['requestId']).toBe('rq-reset')
      // The steps after the shutdown did not run, and nothing past the reset touched the device being shut down.
      expect(simctl.resetPrivacy).not.toHaveBeenCalled()
      expect(simctl.rotate).not.toHaveBeenCalled()
      agent.disconnect(); browser.close()
    })
  })
})

describe('streamRestartPlan', () => {
  // Reset only on a delivered frame, not on how long a run lasted: the helper retries device.io and its
  // ports for up to ~10s before giving up, so a duration rule would read every first-boot failure as a
  // healthy run and never back off.
  it('restarts the first frameless end at once, then backs off 250ms doubling to 5s', () => {
    expect(streamRestartPlan(0, false)).toEqual({ failures: 1, delayMs: 0 })
    expect(streamRestartPlan(1, false)).toEqual({ failures: 2, delayMs: 250 })
    expect(streamRestartPlan(2, false)).toEqual({ failures: 3, delayMs: 500 })
    expect(streamRestartPlan(20, false)).toEqual({ failures: 21, delayMs: 5000 })
  })

  it('resets after a run that delivered a frame, so a mid-session crash restarts at once', () => {
    expect(streamRestartPlan(7, true)).toEqual({ failures: 0, delayMs: 0 })
  })
})
