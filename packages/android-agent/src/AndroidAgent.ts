import os from 'os'
import { WebSocket } from 'ws'
import type { AndroidButton, Device, DeviceAgent } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'
import {
  createResourceSampler,
  registerStreamWs,
  sendBinaryWithBackpressure,
  createRateLimitedDropWarn,
  createThroughputSampler,
  createSleepBlocker,
  type SleepBlocker,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
  CODEC_H264,
} from '@tapflowio/agent-core/utils'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher } from './EmulatorLauncher.js'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'
import type { ScrcpyFrame } from './scrcpy/ScrcpyVideo.js'
import { EmulatorGrpcClient } from './emulator/EmulatorGrpcClient.js'
import { EmulatorVideo } from './emulator/EmulatorVideo.js'

const logger = createLogger('android-agent')

// Parse H.264 SPS NAL unit to extract frame dimensions.
// scrcpy sends a new SPS (inside an IDR keyframe) whenever the capture size changes —
// e.g. portrait→landscape for landscape-aware apps. This lets the agent track the
// actual video dimensions and keep ScrcpyControl.screenSize in sync without guessing.
function parseSpsFromNal(nal: Buffer): { width: number; height: number } | null {
  // Locate NAL header byte after Annex B start code
  let offset = 0
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) offset = 4
  else if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) offset = 3
  else return null
  if (offset >= nal.length || (nal[offset]! & 0x1f) !== 7) return null  // not SPS

  // Collect RBSP bytes (remove emulation-prevention 0x03 bytes)
  const bytes: number[] = []
  for (let i = offset + 1; i < nal.length; i++) {
    const b = nal[i]!
    const len = bytes.length
    if (len >= 2 && b === 3 && bytes[len - 1] === 0 && bytes[len - 2] === 0) continue
    bytes.push(b)
  }

  let bit = 0
  const readU = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) {
      if ((bit >> 3) >= bytes.length) throw new Error('truncated')
      v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1)
      bit++
    }
    return v
  }
  const readUE = (): number => {
    let lz = 0
    while (readU(1) === 0) { if (++lz > 31) throw new Error('overflow') }
    return lz === 0 ? 0 : (1 << lz) - 1 + readU(lz)
  }
  const readSE = (): number => { const v = readUE(); return v % 2 === 0 ? -(v >> 1) : (v + 1) >> 1 }

  try {
    const profile = readU(8)
    readU(8); readU(8)           // constraint_flags, level_idc
    readUE()                     // seq_parameter_set_id

    let subWC = 2, subHC = 2    // 4:2:0 defaults
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cfmt = readUE()
      subWC = cfmt === 0 ? 1 : cfmt === 2 ? 2 : cfmt === 3 ? 1 : 2
      subHC = cfmt === 0 ? 1 : cfmt === 1 ? 2 : 1
      if (cfmt === 3) readU(1)   // separate_colour_plane_flag
      readUE(); readUE()         // bit_depth_luma/chroma_minus8
      readU(1)                   // qpprime_y_zero_transform_bypass_flag
      if (readU(1)) return null  // seq_scaling_matrix_present_flag — skip
    }

    readUE()                     // log2_max_frame_num_minus4
    const pocType = readUE()
    if (pocType === 0) readUE()
    else if (pocType === 1) {
      readU(1); readSE(); readSE()
      const n = readUE(); for (let i = 0; i < n; i++) readSE()
    }
    readUE(); readU(1)           // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
    const codedW = (readUE() + 1) * 16
    const mapH = readUE()
    const frameMbsOnly = readU(1)
    const codedH = (mapH + 1) * 16 * (frameMbsOnly ? 1 : 2)
    if (!frameMbsOnly) readU(1) // mb_adaptive_frame_field_flag
    readU(1)                    // direct_8x8_inference_flag
    let w = codedW, h = codedH
    if (readU(1)) {             // frame_cropping_flag
      const cl = readUE(), cr = readUE(), ct = readUE(), cb = readUE()
      w = codedW - (cl + cr) * subWC
      h = codedH - (ct + cb) * subHC * (frameMbsOnly ? 1 : 2)
    }
    return { width: w, height: h }
  } catch { return null }
}

const ANDROID_BUTTONS: AndroidButton[] = [
  { name: 'home',        accessibilityTitle: 'Home',        keyCode: 3 },
  { name: 'back',        accessibilityTitle: 'Back',        keyCode: 4 },
  { name: 'recent_apps', accessibilityTitle: 'Recent Apps', keyCode: 187 },
  { name: 'volume_up',   accessibilityTitle: 'Volume Up',   keyCode: 24 },
  { name: 'volume_down', accessibilityTitle: 'Volume Down', keyCode: 25 },
  { name: 'power',       accessibilityTitle: 'Power',       keyCode: 26 },
]

interface DeviceState {
  sessionId: string
  deviceId: string
  touchHelper: AndroidTouchHelper | null
  streamWs: WebSocket | null
  scrcpySession: ScrcpySession | null
  emulatorVideo: EmulatorVideo | null
  grpcClient: EmulatorGrpcClient | null
  displayWidth: number
  displayHeight: number
  videoWidth: number   // actual scrcpy video frame dimensions — used for touch coordinates
  videoHeight: number
  landscape: boolean   // rotation intent toggle — only to request device rotation on input:rotate
  lastTouchPx: { x: number; y: number }
  bootSeq: number
  restarting: boolean
}

// Low-latency pointer injection, satisfied structurally by both ScrcpyControl (scrcpy backend)
// and EmulatorGrpcClient (gRPC backend) — identical method shapes, so the input handlers stay
// backend-agnostic. Methods may be sync (scrcpy) or async (gRPC); callers fire-and-forget.
interface PointerControl {
  touchDown(pointerId: number, x: number, y: number): void | Promise<void>
  touchMove(pointerId: number, x: number, y: number): void | Promise<void>
  touchUp(pointerId: number, x?: number, y?: number): void | Promise<void>
  pinchStart(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchMove(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchEnd(): void | Promise<void>
}

// Video backend per device: emulators (serial `emulator-*`) default to the gRPC host-encode path
// (bypasses the guest SW H.264 encoder); real devices use scrcpy (their SoC has a HW encoder).
// `TAPFLOW_ANDROID_BACKEND=scrcpy|grpc` overrides either way.
export function pickAndroidBackend(serial: string, env: NodeJS.ProcessEnv = process.env): 'grpc' | 'scrcpy' {
  if (env.TAPFLOW_ANDROID_BACKEND === 'scrcpy') return 'scrcpy'
  if (env.TAPFLOW_ANDROID_BACKEND === 'grpc') return 'grpc'
  return serial.startsWith('emulator-') ? 'grpc' : 'scrcpy'
}

export interface AndroidAgentOptions {
  fps?: number
  /** AVD name or emulator serial to expose. Omit to expose all detected devices. */
  deviceFilter?: string
  reconnectDelays?: number[]
  /** Injectable for tests; defaults to a real macOS power assertion (no-op under vitest). */
  sleepBlocker?: SleepBlocker
}

export class AndroidAgent implements DeviceAgent {
  private readonly adb: AdbWrapper
  private readonly launcher: EmulatorLauncher
  private ws: WebSocket | null = null
  private deviceStates = new Map<string, DeviceState>()
  // Holds a macOS power assertion while connected so the host doesn't idle-throttle the
  // emulator (its software H.264 encoder starves badly when the Mac idles). No-op off macOS.
  private readonly sleepBlocker: SleepBlocker
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0

  private readonly deviceFilter?: string
  private readonly reconnectDelays: number[]

  constructor(options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
    this.deviceFilter = options.deviceFilter
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 16000, 30000]
    // No-op under vitest so the suite never spawns real `caffeinate` processes.
    this.sleepBlocker = options.sleepBlocker ?? (process.env.VITEST ? { acquire() {}, release() {} } : createSleepBlocker())
  }

  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    this._stopping = false
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.relayUrl = relayUrl
    const allDevices = await this.adb.listDevices()
    const devices = this.deviceFilter
      ? allDevices.filter((d) => d.name === this.deviceFilter || d.id === this.deviceFilter)
      : allDevices

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'agent:register',
          platform: 'android',
          agentName: os.hostname(),
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            status: d.status,
            osVersion: d.osVersion,
          })),
        }))
      })

      ws.once('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent:registered') {
          this.ws = ws
          this.sleepBlocker.acquire() // idempotent across reconnects
          this.initDeviceStates(
            msg.registeredSessions as Array<{ deviceId: string; sessionId: string }>,
          )
          ws.on('message', (d) => {
            try { this.handleRelayMessage(JSON.parse(d.toString())) } catch { /* ignore malformed */ }
          })
          this.reportResources()
          this.resourcesTimer = setInterval(() => this.reportResources(), 5000)
          ws.on('close', () => this._scheduleReconnect())
          resolve()
        } else {
          reject(new PlatformError(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      ws.once('error', reject)
    })
  }

  private initDeviceStates(
    registeredSessions: Array<{ deviceId: string; sessionId: string }>,
  ): void {
    registeredSessions.forEach(({ deviceId, sessionId }) => {
      this.deviceStates.set(sessionId, {
        sessionId,
        deviceId,
        touchHelper: null,
        streamWs: null,
        scrcpySession: null,
        emulatorVideo: null,
        grpcClient: null,
        displayWidth: 0,
        displayHeight: 0,
        videoWidth: 0,
        videoHeight: 0,
        landscape: false,
        lastTouchPx: { x: 0, y: 0 },
        bootSeq: 0,
        restarting: false,
      })
    })
  }

  disconnect(): void {
    this._stopping = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    for (const state of this.deviceStates.values()) {
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.sleepBlocker.release()
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
  }

  private _scheduleReconnect(): void {
    if (this._stopping) return
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    for (const state of this.deviceStates.values()) {
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.ws = null

    const delays = this.reconnectDelays
    const delay = delays[Math.min(this._reconnectAttempt, delays.length - 1)]
    this._reconnectAttempt++
    logger.warn(`relay disconnected — reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`)

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._stopping || !this.relayUrl) return
      this.connect(this.relayUrl).then(() => {
        this._reconnectAttempt = 0
        logger.info('reconnected to relay')
      }).catch(() => {
        this._scheduleReconnect()
      })
    }, delay)
  }

  private reportResources(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.scrcpySession !== null || s.emulatorVideo !== null).length
    const slotsTotal = this.deviceStates.size
    const { memUsedMB, memTotalMB } = this.resources.getMemoryUsage()
    this.ws.send(JSON.stringify({
      type: 'agent:resources',
      resources: {
        cpuPercent: this.resources.getCpuPercent(),
        memUsedMB,
        memTotalMB,
        slotsAvailable: Math.max(0, slotsTotal - bootedCount),
        slotsTotal,
        reportedAt: Date.now(),
      },
    }))
  }

  private cleanupDeviceState(state: DeviceState): void {
    const serial = this.adb.getSerial(state.deviceId)
    if (serial && state.scrcpySession) state.scrcpySession.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.grpcClient?.close()
    state.grpcClient = null
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null
  }

  private sendDeviceInfo(state: DeviceState, device: Device): void {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    }))
  }

  private forceScrcpy(): boolean {
    return process.env.TAPFLOW_ANDROID_BACKEND === 'scrcpy'
  }

  private useGrpc(serial: string): boolean {
    return pickAndroidBackend(serial) === 'grpc'
  }

  // The active low-latency pointer backend (gRPC preferred), or null when only the ADB fallback
  // (AndroidTouchHelper) is available. Coordinates go in state.videoWidth/Height px.
  private pointerControl(state: DeviceState): PointerControl | null {
    if (state.grpcClient) return state.grpcClient
    if (state.scrcpySession) return state.scrcpySession.control
    return null
  }

  // Fire-and-forget a pointer call: gRPC methods are async (swallow rejection), scrcpy sync (no-op).
  private fire(r: void | Promise<void>): void {
    if (r) r.catch(() => {})
  }

  // Port to launch the emulator with (`-grpc <port>`, unsecured localhost). A plain `-grpc` endpoint
  // is unsecured; without it the emulator opens its DEFAULT gRPC port with token auth, which our
  // unauthenticated client can't use. Launches are always AVDs (emulators), so default to gRPC
  // unless explicitly forced to scrcpy. undefined = don't open gRPC.
  private grpcPort(): number | undefined {
    return this.forceScrcpy() ? undefined : (Number(process.env.TAPFLOW_ANDROID_GRPC_PORT) || 8554)
  }

  private async startVideoStream(state: DeviceState, streamWs: WebSocket): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) return

    // Emulator: capture via gRPC streamScreenshot + Mac VideoToolbox (bypasses the guest SW H.264
    // encoder). On any failure (e.g. an externally-booted emulator without `-grpc`), fall back to
    // scrcpy so streaming still works.
    if (this.useGrpc(serial)) {
      try {
        await this.startGrpcVideoStream(state, streamWs, serial)
        return
      } catch (e) {
        logger.warn(`gRPC backend failed (${(e as Error).message}) — falling back to scrcpy`)
        state.emulatorVideo?.stop(); state.emulatorVideo = null
        state.grpcClient?.close(); state.grpcClient = null
        state.touchHelper?.stop(); state.touchHelper = null
      }
    }

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const session = new ScrcpySession()
    const info = await session.start(serial)
    state.scrcpySession = session
    state.landscape = false

    state.displayWidth = info.width
    state.displayHeight = info.height
    state.videoWidth = info.width
    state.videoHeight = info.height

    const reader = session.video.start().getReader()

    // Detect video size changes via H.264 SPS so ScrcpyControl.screenSize always matches what
    // scrcpy is encoding (landscape-aware vs portrait-locked). The SPS leads the keyframe AU.
    const onFrame = (value: ScrcpyFrame) => {
      const parsed = parseSpsFromNal(value.payload)
      if (parsed && (parsed.width !== state.videoWidth || parsed.height !== state.videoHeight)) {
        state.videoWidth = parsed.width
        state.videoHeight = parsed.height
        state.scrcpySession?.control.updateScreenSize(parsed.width, parsed.height)
        logger.info(`video size → ${parsed.width}×${parsed.height}`)
      }
    }

    void this.pumpVideo(state, streamWs, reader, onFrame).then(() => {
      if (state.scrcpySession === session && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    })
  }

  // Shared frame pump for both video backends: reads H.264 access units, wraps each in the TFFE
  // envelope (codec + per-AU keyframe flag, so the relay's keyframe-aware backpressure preserves the
  // reference chain), and sends with backpressure + optional throughput metrics. `onFrame` lets a
  // backend inspect each frame (scrcpy parses SPS for size). Resolves when the source stream ends.
  private async pumpVideo(
    state: DeviceState,
    streamWs: WebSocket,
    reader: ReadableStreamDefaultReader<ScrcpyFrame>,
    onFrame?: (frame: ScrcpyFrame) => void,
  ): Promise<void> {
    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)
    // Opt-in throughput baseline (TAPFLOW_STREAM_METRICS=1): logs fps/KB·s/drop every 5s, so the
    // Android source rate can be compared against the relay→browser drop logs and the iOS agent.
    const metrics = process.env.TAPFLOW_STREAM_METRICS === '1' ? createThroughputSampler() : null
    const metricsTimer = metrics
      ? setInterval(() => {
          const s = metrics.sample()
          logger.info(
            `stream metrics [${state.deviceId}] ${s.fpsSent}fps ${s.kbPerSec}KB/s avg=${s.avgFrameKB}KB drop=${(s.dropRate * 100).toFixed(1)}% (${s.droppedFrames}/${s.producedFrames})`,
          )
        }, 5000)
      : undefined
    metricsTimer?.unref()
    const onDrop = metrics ? () => { metrics.recordDropped(); warnDrop() } : warnDrop

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        onFrame?.(value)
        const frame = writeEnvelopeHeader(value.payload, Date.now(), { codec: CODEC_H264, keyframe: value.keyframe })
        const sent = sendBinaryWithBackpressure(streamWs, frame, threshold, onDrop)
        if (sent) metrics?.recordSent(value.payload.length)
      }
    } catch {
      // stream cancelled or ws closed — expected on disconnect
    }
    if (metricsTimer) clearInterval(metricsTimer)
  }

  // gRPC emulator backend: capture via EmulatorVideo (gRPC streamScreenshot + Mac VT encode) through
  // the shared pump. Input is routed to the gRPC client in handleRelayMessage. No auto-restart —
  // the backend is torn down with the device state.
  private async startGrpcVideoStream(state: DeviceState, streamWs: WebSocket, serial: string): Promise<void> {
    const port = this.grpcPort() ?? 8554
    // Downscale box (longest side), server-side resize: also lifts encoded fps since native is
    // pixel-volume bound. Aspect is preserved within the box. 0 = native.
    const maxSize = Number(process.env.TAPFLOW_ANDROID_MAX_SIZE) || 0
    // Default 30fps (iOS parity) — caps source 60fps to halve decode/transport for LAN-HTTP.
    const fps = Number(process.env.TAPFLOW_ANDROID_FPS) || 30

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const client = new EmulatorGrpcClient(`127.0.0.1:${port}`)
    const video = new EmulatorVideo(client, { fps, ...(maxSize ? { maxWidth: maxSize, maxHeight: maxSize } : {}) })
    // Assign before start() so the caller's fallback cleanup can tear these down on failure.
    state.grpcClient = client
    state.emulatorVideo = video
    const info = await video.start()
    // gRPC sendTouch coordinates are in the device's native display resolution — not the (possibly
    // downscaled) video size — so query it for correct normalized→px touch mapping. The aspect
    // ratio matches the downscaled video, so native dims also drive the dashboard chrome.
    const native = await this.adb.getScreenSize(serial).catch(() => ({ width: info.width, height: info.height }))
    state.landscape = false
    state.displayWidth = native.width
    state.displayHeight = native.height
    state.videoWidth = native.width
    state.videoHeight = native.height

    const reader = video.frames().getReader()
    void this.pumpVideo(state, streamWs, reader)
  }

  private async restartVideoStream(state: DeviceState): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) { state.restarting = false; return }

    state.scrcpySession?.stop(serial)
    state.scrcpySession = null
    state.touchHelper?.stop()
    state.touchHelper = null

    const { streamWs } = state
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
      state.restarting = false
      return
    }

    // kill any lingering scrcpy server process on the device before restarting
    await this.adb.pkill(serial, 'scrcpy-server').catch(() => {})
    await new Promise<void>((r) => setTimeout(r, 1500))

    if (!this.deviceStates.has(state.sessionId)) return

    try {
      await this.startVideoStream(state, streamWs)
    } catch (err) {
      logger.error(`scrcpy restart failed: ${err}`)
      this.ws?.send(JSON.stringify({
        type: 'device:boot-error',
        sessionId: state.sessionId,
        message: 'scrcpy failed to restart',
      }))
    } finally {
      state.restarting = false
    }
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    const streamWs = new WebSocket(this.relayUrl!)
    state.streamWs = streamWs
    await registerStreamWs(streamWs, state.sessionId)
    return streamWs
  }

  private async handleDeviceBoot(sessionId: string, avdId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state || !this.ws) return

    const seq = ++state.bootSeq

    this.cleanupDeviceState(state)
    this.ws.send(JSON.stringify({ type: 'device:booting', sessionId }))

    try {
      const avdName = avdId.replace(/^avd:/, '')
      const devices = await this.adb.listDevices()
      if (seq !== state.bootSeq) return

      const target = devices.find((d) => d.id === avdId)
      if (!target) throw new PlatformError(`Device not found: ${avdId}`)

      if (target.status !== 'booted') {
        this.launcher.launch(avdName, this.grpcPort())
        const serial = await this.launcher.findSerial(avdName)
        if (seq !== state.bootSeq) return
        await this.launcher.waitForBoot(serial)
        if (seq !== state.bootSeq) return
        this.adb.setSerial(avdId, serial)
      }

      const refreshed = await this.adb.listDevices()
      if (seq !== state.bootSeq) return
      const refreshedDevice = refreshed.find((d) => d.id === avdId) ?? target

      this.sendDeviceInfo(state, { ...refreshedDevice, status: 'booted' } as Device)

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        return
      }

      await this.startVideoStream(state, streamWs)
      if (seq !== state.bootSeq) return
      this.ws?.send(JSON.stringify({
        type: 'session:chrome',
        sessionId: state.sessionId,
        payload: {
          buttons: ANDROID_BUTTONS,
          streamType: 'h264',
          screenWidth: state.displayWidth,
          screenHeight: state.displayHeight,
        },
      }))
      this.ws?.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: avdId } }))
    } catch (e) {
      if (seq !== state.bootSeq) return
      const message = e instanceof Error ? e.message : String(e)
      logger.error('boot failed:', message)
      this.ws?.send(JSON.stringify({ type: 'device:boot-error', sessionId, message }))
    }
  }

  private async handleDeviceShutdown(sessionId: string, avdId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return

    state.bootSeq++
    this.cleanupDeviceState(state)

    const serial = this.adb.getSerial(avdId)
    if (serial) {
      // best-effort — emulator may already be gone
      await this.adb.shutdown(serial).catch((e: unknown) => {
        logger.warn('emu kill failed (already gone?):', (e as Error).message)
      })
      this.adb.clearSerial(avdId)
    }
    this.ws?.send(JSON.stringify({
      type: 'device:shutdown-done',
      sessionId,
      payload: { deviceId: avdId },
    }))
  }

  private handleRelayMessage(msg: { type: string; sessionId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceBoot(msg.sessionId!, deviceId)
          .catch((e) => logger.error('handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceShutdown(msg.sessionId!, deviceId)
          .catch((e) => logger.error('handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath, bundleId } = msg.payload as { filePath: string; bundleId?: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'app:install-error', sessionId, message: 'No booted device' }))
          break
        }
        if (filePath.endsWith('.app.zip') || filePath.endsWith('.app')) {
          this.ws?.send(JSON.stringify({
            type: 'app:install-error',
            sessionId,
            message: '.app.zip is an iOS simulator build — upload a .apk file for Android.',
          }))
          break
        }
        const doInstall = async () => {
          if (bundleId) await this.adb.clearAppData(serial, bundleId).catch(() => {})
          await this.adb.installApp(serial, filePath)
        }
        doInstall()
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:install-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:install-error', sessionId, message }))
          })
        break
      }
      case 'app:launch': {
        const { bundleId } = msg.payload as { bundleId: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'app:launch-error', sessionId, message: 'No booted device' }))
          break
        }
        this.adb.launchApp(serial, bundleId)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:launch-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:launch-error', sessionId, message }))
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          this.fire(pc.touchDown(0, px, py))
        } else {
          state.touchHelper?.touchStart(x, y)
        }
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          this.fire(pc.touchMove(0, px, py))
        } else {
          state.touchHelper?.touchMove(x, y)
        }
        break
      }
      case 'input:touch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const pc = this.pointerControl(state)
        if (pc) {
          this.fire(pc.touchUp(0, state.lastTouchPx.x, state.lastTouchPx.y))
        } else {
          state.touchHelper?.touchEnd()
        }
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          this.fire(pc.pinchStart(px1, py1, px2, py2))
        } else {
          state.touchHelper?.pinchStart(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          this.fire(pc.pinchMove(px1, py1, px2, py2))
        } else {
          state.touchHelper?.pinchMove(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const pc = this.pointerControl(state)
        if (pc) {
          this.fire(pc.pinchEnd())
        } else {
          state.touchHelper?.pinchEnd()
        }
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const serial = this.adb.getSerial(state.deviceId)
        if (!serial) break
        // The viewer owns rotation intent locally (CSS); here we only ask the device to
        // rotate so rotation-capable apps re-layout. user_rotation=3 = canonical landscape
        // (home-left/punch-right). Portrait-locked apps ignore it — the viewer's CSS handles
        // their cosmetic rotation, so we don't track or sync device rotation back.
        const next = !state.landscape
        state.landscape = next
        this.adb.setRotation(serial, next ? 3 : 0).catch(() => { state.landscape = !next })
        break
      }
      case 'input:button': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { name } = msg.payload as { name: string }
        state.touchHelper.pressButton(name)
        break
      }
      case 'stream:request-idr': {
        // Relay drop-to-keyframe / join recovery: reset the encoder so it re-emits SPS/PPS + IDR,
        // resyncing fast instead of waiting for the periodic IDR. Throttled by the relay.
        const st = this.deviceStates.get(msg.sessionId!)
        st?.scrcpySession?.control.resetVideo()
        st?.emulatorVideo?.requestIdr()
        break
      }
      case 'open-url': {
        const { url } = msg.payload as { url: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'open-url:error', sessionId, message: 'No booted device' }))
          break
        }
        this.adb.openUrl(serial, url)
          .then(() => this.ws?.send(JSON.stringify({ type: 'open-url:done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'open-url:error', sessionId, message }))
          })
        break
      }
      case 'input:keyboard:toggle': {
        // client-side key forwarding toggle only — no ADB side effect needed
        break
      }
      case 'input:key': {
        const state = this.deviceStates.get(msg.sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) break
        const { code, modifiers } = msg.payload as { code: string; modifiers: number }
        this.handleKeyInput(serial, code, modifiers).catch(() => {})
        break
      }
      case 'screenshot:request': {
        const raw = msg as unknown as { requestId: string; format?: 'png' | 'jpeg'; sessionId?: string }
        const { requestId, format } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'screenshot:error', sessionId, requestId, message: 'No booted device' }))
          break
        }
        this.adb.screenshot(serial)
          .then((buf) => this.ws?.send(JSON.stringify({
            type: 'screenshot:done',
            sessionId,
            requestId,
            format: format ?? 'png',
            data: buf.toString('base64'),
          })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'screenshot:error', sessionId, requestId, message }))
          })
        break
      }
    }
  }

  private async handleKeyInput(serial: string, code: string, modifiers: number): Promise<void> {
    const SPECIAL: Record<string, string> = {
      Backspace: '67', Enter: '66', Tab: '61', Space: '62', Escape: '111',
      ArrowLeft: '21', ArrowRight: '22', ArrowUp: '19', ArrowDown: '20',
      Delete: '112', Home: '122', End: '123', PageUp: '92', PageDown: '93',
      F1: '131', F2: '132', F3: '133', F4: '134', F5: '135',
      F6: '136', F7: '137', F8: '138', F9: '139', F10: '140', F11: '141', F12: '142',
    }
    if (SPECIAL[code]) {
      await this.adb.sendKeyEvent(serial, SPECIAL[code])
      return
    }
    const shift = Boolean(modifiers & 0x02)
    let char: string | null = null
    if (code.startsWith('Key')) {
      const letter = code.slice(3)
      char = shift ? letter.toUpperCase() : letter.toLowerCase()
    } else if (code.startsWith('Digit')) {
      const digit = code.slice(5)
      const shiftDigits: Record<string, string> = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
      }
      char = shift ? (shiftDigits[digit] ?? digit) : digit
    } else {
      const PUNCT: Record<string, [string, string]> = {
        Minus: ['-', '_'], Equal: ['=', '+'],
        BracketLeft: ['[', '{'], BracketRight: [']', '}'],
        Backslash: ['\\', '|'], Semicolon: [';', ':'],
        Quote: ["'", '"'], Comma: [',', '<'],
        Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
      }
      if (PUNCT[code]) char = shift ? PUNCT[code][1] : PUNCT[code][0]
    }
    if (char) await this.adb.sendInput(serial, 'text', char)
  }

  listDevices(): Promise<Device[]> { return this.adb.listDevices() }

  async boot(avdId: string): Promise<void> {
    const avdName = avdId.replace(/^avd:/, '')
    this.launcher.launch(avdName)
    const serial = await this.launcher.findSerial(avdName)
    await this.launcher.waitForBoot(serial)
    this.adb.setSerial(avdId, serial)
  }

  async shutdown(avdId: string): Promise<void> {
    const serial = this.adb.getSerial(avdId)
    if (serial) {
      await this.adb.shutdown(serial)
      this.adb.clearSerial(avdId)
    }
  }

  async installApp(apkPath: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new ValidationError('no booted device — call connect() first')
    await this.adb.installApp(serial, apkPath)
  }

  async launchApp(packageName: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new ValidationError('no booted device — call connect() first')
    await this.adb.launchApp(serial, packageName)
  }

  async screenshot(): Promise<Buffer> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new ValidationError('no booted device — call connect() first')
    return this.adb.screenshot(serial)
  }

  stream(): ReadableStream<Buffer> {
    const state = this.deviceStates.values().next().value
    if (!state?.scrcpySession) throw new ValidationError('no active scrcpy session — call connect() first')
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap ScrcpyFrame payloads.
    return state.scrcpySession.video.start()
      .pipeThrough(new TransformStream<ScrcpyFrame, Buffer>({
        transform(frame, controller) { controller.enqueue(frame.payload) },
      }))
  }

  touchStart(x: number, y: number): void {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchStart(x, y)
  }

  touchMove(x: number, y: number): Promise<void> {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchMove(x, y)
    return Promise.resolve()
  }

  touchEnd(): Promise<void> {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchEnd()
    return Promise.resolve()
  }

  async openUrl(url: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new ValidationError('no booted device — call connect() first')
    await this.adb.openUrl(serial, url)
  }
}
