import os from 'os'
import { WebSocket } from 'ws'
import type { AndroidButton, Device, DeviceAgent, UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'
import {
  createResourceSampler,
  registerStreamWs,
  disableNagle,
  createKeyframeAwareSender,
  pickMaxSize,
  createRateLimitedDropWarn,
  createThroughputSampler,
  createSleepBlocker,
  type SleepBlocker,
  getMachineId,
  isLocalhostWss,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
  rewriteLowLatencySpsInFrame,
  CODEC_H264,
  CODEC_AUDIO,
  sendAudioYieldingToVideo,
} from '@tapflowio/agent-core/utils'
import { execFileSync } from 'child_process'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher, findEmulatorPid } from './EmulatorLauncher.js'
import { ensureHelperApp, launchMuteOnlyTap, isAudioSupported } from '@tapflowio/audiotap-helper'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { parseUiAutomatorDump } from './uiTree.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'
import type { ScrcpyFrame } from './scrcpy/ScrcpyVideo.js'
import { EmulatorGrpcClient, type AudioStream } from './emulator/EmulatorGrpcClient.js'
import { discoverGrpcPort, isTcpPortFree } from './emulator/discovery.js'
import { EmulatorVideo } from './emulator/EmulatorVideo.js'

const logger = createLogger('android-agent')

// Parse H.264 SPS NAL unit to extract frame dimensions.
// scrcpy sends a new SPS (inside an IDR keyframe) whenever the capture size changes —
// e.g. portrait→landscape for landscape-aware apps. This lets the agent track the
// actual video dimensions and keep ScrcpyControl.screenSize in sync without guessing.
export function parseSpsFromNal(nal: Buffer): { width: number; height: number } | null {
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
  emulatorAudio: AudioStream | null   // gRPC audio stream (on by default; null when TAPFLOW_AUDIO=off)
  audioMuteQemuPid: number | null     // qemu pid silenced by the macOS mute-only tap (#341); null if not muting
  grpcPort: number | null             // gRPC port this device's emulator was launched with; null if we didn't launch it
  grpcClient: EmulatorGrpcClient | null
  cornerRadius: number   // baked rounded-corner radius as a fraction of width (0 = square)
  secureContext: boolean // viewer context → downscale tier (native / 1280 / 1000)
  external: boolean
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
  /** Credential for remote relays — sent as `Authorization: Bearer` on every relay WS (#271). */
  token?: string
  /** Handshake(연결~agent:registered) 타임아웃 ms. 기본 10초, 테스트용 주입 가능. */
  handshakeTimeoutMs?: number
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
  private readonly token?: string
  private readonly handshakeTimeoutMs: number

  constructor(options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
    this.deviceFilter = options.deviceFilter
    this.token = options.token
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
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
      const ws = new WebSocket(relayUrl, this.wsClientOptions())
      let registered = false

      // 등록 응답이 영영 오지 않는 행 방지 — 시간 내 미등록이면 끊고 reject (#271)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new PlatformError(`relay handshake timed out after ${this.handshakeTimeoutMs}ms (${relayUrl})`))
      }, this.handshakeTimeoutMs)

      ws.once('open', () => {
        disableNagle(ws)
        ws.send(JSON.stringify({
          type: 'agent:register',
          platform: 'android',
          agentId: getMachineId(),
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
        let msg: { type?: string; registeredSessions?: unknown }
        try {
          msg = JSON.parse(data.toString())
        } catch {
          // malformed 첫 프레임이 핸들러 밖으로 throw되면 connect()가 reject 없이 행된다 (#272)
          clearTimeout(timer)
          ws.terminate()
          reject(new PlatformError('relay sent a malformed handshake response'))
          return
        }
        if (msg.type === 'agent:registered') {
          registered = true
          clearTimeout(timer)
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
          clearTimeout(timer)
          ws.close()
          reject(new PlatformError(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      // 등록 전의 정상 close(예: 릴레이의 1008 인증 거절)는 'error' 없이 도착한다.
      // 사유를 살려 reject해야 무한 대기(스피너 행)가 아니라 진단 가능한 실패가 된다 (#271).
      ws.once('close', (code, reason) => {
        if (registered) return
        clearTimeout(timer)
        const reasonText = reason.toString()
        reject(new PlatformError(
          `relay closed the connection during handshake (code=${code}${reasonText ? `: ${reasonText}` : ''})`,
        ))
      })

      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer)
        ws.terminate()
        reject(new PlatformError(`relay rejected the WebSocket upgrade (HTTP ${res.statusCode})`))
      })

      ws.once('error', (e) => { clearTimeout(timer); reject(e) })
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
        emulatorAudio: null,
        audioMuteQemuPid: null,
        grpcPort: null,
        grpcClient: null,
        cornerRadius: 0,
        secureContext: false,
        external: false,
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
      }).catch((e) => {
        // 실패 원인을 남겨야 인증 거절(1008)과 네트워크 장애를 구분할 수 있다 (#271)
        logger.warn(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
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
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    this.stopHostMute(state)
    state.grpcClient?.close()
    state.grpcClient = null
    state.cornerRadius = 0
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
  // Ports reserved between pick() and the emulator actually binding them — avoids two concurrent
  // boots racing onto the same port before either emulator has claimed it.
  private pendingGrpcPorts = new Set<number>()

  // A FREE gRPC port for a new emulator. Each emulator must get its own port — a shared fixed 8554
  // makes a second emulator collide and every session ends up streaming the first emulator (#stream-bleed).
  private async pickFreeGrpcPort(): Promise<number> {
    const base = Number(process.env.TAPFLOW_ANDROID_GRPC_PORT) || 8554
    for (let p = base; p < base + 200; p += 2) { // emulators conventionally use even ports
      if (this.pendingGrpcPorts.has(p)) continue
      // Reserve before the async probe so two concurrent boots can't both claim the same port.
      this.pendingGrpcPorts.add(p)
      let free = false
      try {
        free = await isTcpPortFree(p)
        if (free) return p
      } finally {
        if (!free) this.pendingGrpcPorts.delete(p)
      }
    }
    throw new PlatformError('No free gRPC port available for the emulator')
  }

  // Audio output is ON by default; opt out with TAPFLOW_AUDIO=off. Gates both emulator launch
  // (`-no-audio` removal) and the gRPC streamAudio pump — both must read the same flag so the audio
  // backend matches the stream. Unlike iOS, the emulator also plays to the host (agent Mac) — it has
  // no host-output-only mute, so use the Mac's own volume; see contributing/simulator-audio.md (#341).
  private audioEnabled(): boolean {
    return process.env.TAPFLOW_AUDIO !== 'off'
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

    void this.pumpVideo(state, streamWs, reader, onFrame, () => session.control.resetVideo()).then(() => {
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
    requestIdr?: () => void,
  ): Promise<void> {
    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)
    // Keyframe-aware backpressure: when the agent→relay socket fills, drop whole GOPs to the next
    // keyframe (never forward an orphan P-frame whose reference was dropped — that decodes to a
    // sheared/ghosted frame until the next IDR). On a drop with no keyframe, ask the encoder for an
    // IDR (throttled) so the stream resyncs fast instead of waiting for the periodic one.
    const dropper = createKeyframeAwareSender()
    let lastIdrReq = 0
    const onWantKeyframe = requestIdr
      ? () => { const now = Date.now(); if (now - lastIdrReq >= 500) { lastIdrReq = now; requestIdr() } }
      : undefined
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
        // Declare reorder=0 on the keyframe SPS so the decoder (WASM/WebCodecs) emits frames
        // immediately instead of buffering the level's max DPB (~hundreds of ms of latency on every
        // frame). The gRPC/VideoToolbox SPS omits bitstream_restriction; scrcpy's is a no-op.
        const payload = value.keyframe ? (rewriteLowLatencySpsInFrame(value.payload) as Buffer) : value.payload
        const frame = writeEnvelopeHeader(payload, Date.now(), { codec: CODEC_H264, keyframe: value.keyframe })
        const sent = dropper.send(streamWs, frame, threshold, value.keyframe, onDrop, onWantKeyframe)
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
    // Connect to THIS emulator's port: the one we launched it with, else the port it advertises in
    // its discovery .ini (covers externally-booted emulators), else the legacy default.
    const port = state.grpcPort ?? discoverGrpcPort(serial) ?? 8554
    // Downscale box (longest side), server-side resize. Per-session tier from the viewer context
    // (secure→native / LAN-HTTP→1280 / external→1000); TAPFLOW_ANDROID_MAX_SIZE | TAPFLOW_MAX_SIZE
    // is a hard override.
    const maxSize = pickMaxSize({
      secureContext: state.secureContext,
      external: state.external,
      override: process.env.TAPFLOW_ANDROID_MAX_SIZE ?? process.env.TAPFLOW_MAX_SIZE,
    })
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
    state.cornerRadius = info.cornerRadius

    const reader = video.frames().getReader()
    // If the gRPC video ends unexpectedly (emulator crash / disconnect), restart the stream so the
    // session recovers instead of going dead — mirrors the scrcpy pump's auto-restart.
    void this.pumpVideo(state, streamWs, reader, undefined, () => video.requestIdr()).then(() => {
      if (state.emulatorVideo === video && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    })

    // Opt-in audio output, on the SAME gRPC client + stream socket as video. Best-effort: if it
    // ends or errors it does NOT trigger a video restart — video owns the session lifecycle.
    if (this.audioEnabled()) {
      const audio = client.streamAudio()
      state.emulatorAudio = audio
      void this.pumpAudio(state, streamWs, audio)
      this.startHostMute(state) // #341: silence the emulator's host (agent Mac) output — iOS parity
    }
  }

  // #341: the emulator also plays to the agent Mac's speakers (its `-audio` backend has no
  // host-output-only mute). On macOS 14.2+ we hold a mute-only Core Audio process tap on the
  // emulator's qemu pid so its host output is silenced while gRPC keeps capturing for the browser —
  // matching iOS's muteBehavior=.muted. Below 14.2 / non-macOS: no-op (fall back to the Mac's volume).
  private startHostMute(state: DeviceState): void {
    if (!isAudioSupported()) return
    if (state.audioMuteQemuPid != null) return // already muting this session (e.g. a stream restart)
    const avdName = state.deviceId.replace(/^avd:/, '')
    const qemuPid = findEmulatorPid(avdName)
    if (!qemuPid) { logger.debug(`host-mute: no qemu pid for ${avdName}`); return }
    try {
      launchMuteOnlyTap(ensureHelperApp(), [qemuPid])
      state.audioMuteQemuPid = qemuPid
      logger.info(`host-mute: silencing emulator host output on the agent Mac (qemu ${qemuPid})`)
    } catch (e) {
      logger.warn(`host-mute: failed to launch mute tap: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Stop muting on teardown so the emulator is audible again if the operator uses it directly. The
  // mute helper also self-exits when qemu dies, so this only matters when the emulator outlives us.
  private stopHostMute(state: DeviceState): void {
    if (state.audioMuteQemuPid == null) return
    try { execFileSync('pkill', ['-f', `audiotap-helper.*--mute-only ${state.audioMuteQemuPid}$`], { stdio: 'ignore' }) } catch { /* already gone */ }
    state.audioMuteQemuPid = null
  }

  // Forward raw-PCM audio frames to the relay on the shared stream socket. Uses the yielding sender,
  // never the keyframe-aware video sender: audio must never inflate the socket buffer enough to make
  // video's backpressure misfire. A dropped audio frame is a brief glitch; a stalled video isn't.
  private async pumpAudio(state: DeviceState, streamWs: WebSocket, audio: AudioStream): Promise<void> {
    const warnDrop = createRateLimitedDropWarn(logger, `${state.deviceId} audio`)
    try {
      for await (const f of audio.frames) {
        if (streamWs.readyState !== WebSocket.OPEN) break
        const frame = writeEnvelopeHeader(f.audio, Date.now(), { codec: CODEC_AUDIO })
        sendAudioYieldingToVideo(streamWs, frame, warnDrop)
      }
    } catch {
      // stream cancelled or ws closed — expected on teardown/restart
    }
  }

  private async restartVideoStream(state: DeviceState): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) { state.restarting = false; return }

    state.scrcpySession?.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    state.grpcClient?.close()
    state.grpcClient = null
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

  // 원격 릴레이는 PAT 인증을 요구한다 (#271) — control/stream WS 모두 같은 토큰을 쓴다.
  private wsClientOptions(): { headers?: Record<string, string>; rejectUnauthorized?: boolean } {
    const opts: { headers?: Record<string, string>; rejectUnauthorized?: boolean } = {}
    if (this.token) opts.headers = { authorization: `Bearer ${this.token}` }
    // All-in-one (tapflow start): the relay's domain cert won't match wss://localhost, but localhost
    // never leaves the machine so MITM is impossible — accept it. External relays keep verification.
    if (this.relayUrl && isLocalhostWss(this.relayUrl)) opts.rejectUnauthorized = false
    return opts
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    const streamWs = new WebSocket(this.relayUrl!, this.wsClientOptions())
    state.streamWs = streamWs
    await registerStreamWs(streamWs, state.sessionId)
    return streamWs
  }

  private async handleDeviceBoot(sessionId: string, avdId: string, tier?: { secureContext: boolean; external: boolean }): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state || !this.ws) return

    const seq = ++state.bootSeq

    this.cleanupDeviceState(state)
    if (tier) { state.secureContext = tier.secureContext; state.external = tier.external }
    this.ws.send(JSON.stringify({ type: 'device:booting', sessionId }))

    try {
      const avdName = avdId.replace(/^avd:/, '')
      const devices = await this.adb.listDevices()
      if (seq !== state.bootSeq) return

      const target = devices.find((d) => d.id === avdId)
      if (!target) throw new PlatformError(`Device not found: ${avdId}`)

      if (target.status !== 'booted') {
        // One unique gRPC port per emulator (undefined when forced to scrcpy → no `-grpc`).
        const grpcPort = this.forceScrcpy() ? undefined : await this.pickFreeGrpcPort()
        state.grpcPort = grpcPort ?? null
        try {
          this.launcher.launch(avdName, grpcPort, { audio: this.audioEnabled() })
          const serial = await this.launcher.findSerial(avdName)
          if (seq !== state.bootSeq) return
          await this.launcher.waitForBoot(serial)
          if (seq !== state.bootSeq) return
          this.adb.setSerial(avdId, serial)
        } finally {
          // The emulator now holds the port (or boot failed) — drop the reservation either way.
          if (grpcPort !== undefined) this.pendingGrpcPorts.delete(grpcPort)
        }
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
          cornerRadius: state.cornerRadius,
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
        const { deviceId, secureContext, external } = msg.payload as { deviceId: string; secureContext?: boolean; external?: boolean }
        this.handleDeviceBoot(msg.sessionId!, deviceId, { secureContext: !!secureContext, external: !!external })
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
      case 'app:clear-state': {
        const { bundleId } = (msg.payload ?? {}) as { bundleId?: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial || !bundleId) {
          this.ws?.send(JSON.stringify({ type: 'app:clear-state-error', sessionId, message: !serial ? 'No booted device' : 'bundleId missing' }))
          break
        }
        this.adb.clearAppData(serial, bundleId)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:clear-state-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:clear-state-error', sessionId, message }))
          })
        break
      }
      case 'ui:tree:request': {
        const raw = msg as unknown as { requestId: string; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'ui:tree:error', sessionId, requestId, message: 'No booted device' }))
          break
        }
        this.adb.dumpUiHierarchy(serial)
          .then((xml) => this.ws?.send(JSON.stringify({
            type: 'ui:tree:response',
            sessionId,
            requestId,
            elements: parseUiAutomatorDump(xml),
          })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'ui:tree:error', sessionId, requestId, message }))
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

  async queryUITree(): Promise<UIElement[]> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new ValidationError('no booted device — call connect() first')
    return parseUiAutomatorDump(await this.adb.dumpUiHierarchy(serial))
  }

  stream(): ReadableStream<Buffer> {
    const state = this.deviceStates.values().next().value
    // Works on either video backend (scrcpy for real devices, gRPC host-encode for emulators).
    const frames = state?.scrcpySession?.video.start() ?? state?.emulatorVideo?.frames()
    if (!frames) throw new ValidationError('no active video stream — call connect() first')
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap ScrcpyFrame payloads.
    return frames.pipeThrough(new TransformStream<ScrcpyFrame, Buffer>({
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
