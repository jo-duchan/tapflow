import os from 'os'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { WebSocket } from 'ws'
import type { Device, DeviceAgent, UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent')

// Cross-platform button name → iOS device-chrome button name. Chrome uses
// hyphens and "power" (not "lock"); MCP's vocabulary uses underscores. Names
// not listed here (incl. the raw chrome names the dashboard sends) pass through.
export const IOS_BUTTON_ALIASES: Record<string, string> = {
  lock: 'power',
  volume_up: 'volume-up',
  volume_down: 'volume-down',
}
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
  CODEC_JPEG,
  CODEC_H264,
  CODEC_AUDIO,
  sendAudioYieldingToVideo,
} from '@tapflowio/agent-core/utils'
import type { AudioFrame } from '@tapflowio/agent-core'
import { SimctlWrapper, isDeviceMissingError } from './SimctlWrapper.js'
import { ScreenCaptureStreamer, type StreamFrame } from './ScreenCaptureStreamer.js'
import { AudioCaptureStreamer, readSimVolume, applyGain } from './AudioCaptureStreamer.js'
import { ensureHelperApp, launchAudioHelper, isAudioSupported } from '@tapflowio/audiotap-helper'
import { enumerateSimPids } from './SimProcessTree.js'
import { MjpegStreamer } from './MjpegStreamer.js'
import { TouchHelper } from './TouchHelper.js'
import { XCUITreeReader } from './XCUITreeReader.js'
import { DeviceChromeLoader, type ChromeData } from './DeviceChromeLoader.js'
import { KEY_CODE_MAP, MODIFIER_BITS } from './KeyCodeMap.js'

// whole-sim audio: how often to re-enumerate the simulator's process tree for new audio-producing
// processes (launched apps, WebKit WebContent). Short enough that a tab's audio starts promptly,
// long enough to keep `ps` overhead negligible.
const AUDIO_POLL_MS = 1500

// 아카이브 추출(tar/unzip) 시 stdout 상한. 기본 1MB 로는 파일 많은 큰 .app 에서 넘칠 수 있어 넉넉히 잡는다.
const EXTRACT_MAXBUFFER = 256 * 1024 * 1024 // 256 MB

export interface IOSAgentOptions {
  fps?: number
  intervalMs?: number
  reconnectDelays?: number[]
  /** Injectable for tests; defaults to a real macOS power assertion (no-op under vitest). */
  sleepBlocker?: SleepBlocker
  /** Restrict the devices registered with the relay to this name or id (exposure filter). */
  deviceFilter?: string
  /** Credential for remote relays — sent as `Authorization: Bearer` on every relay WS (#271). */
  token?: string
  /** Handshake(연결~agent:registered) 타임아웃 ms. 기본 10초, 테스트용 주입 가능. */
  handshakeTimeoutMs?: number
}

interface DeviceState {
  sessionId: string
  deviceId: string
  touchHelper: TouchHelper | null
  streamWs: WebSocket | null
  streamReader: ReadableStreamDefaultReader<StreamFrame> | null
  // Current capture streamer (ScreenCaptureStreamer path only) — lets the relay
  // request an on-demand IDR for drop-to-keyframe recovery. null on the MjpegStreamer path.
  captureStreamer: ScreenCaptureStreamer | null
  bootSeq: number
  orientation: 'portrait' | 'landscapeRight'
  loadedChrome: ChromeData | null
  // tracks whether the software keyboard is currently visible so we can send ⌘K
  // in the correct direction. reset to false on any hardware key event because
  // iOS auto-hides the software keyboard whenever a hardware key is pressed.
  softKeyboardVisible: boolean
  // Browser-reported H.264 decode capability from device:boot. false (default) =
  // stream JPEG. Persisted so a stream reconnect re-picks the same codec.
  acceptH264: boolean
  // Viewer context from device:boot → downscale tier (native / 1280 / 1000).
  secureContext: boolean
  external: boolean
  // Audio output (opt-in). The loopback server the audiotap-helper streams PCM to, and its port —
  // the helper (launched at boot for the whole simulator) connects here. null/0 when audio is off.
  audioStreamer: AudioCaptureStreamer | null
  audioPort: number
  // whole-sim tap: the poll timer that re-enumerates the sim's process tree, and the last pid set we
  // pushed to the helper (so we only rebuild the tap when a NEW process appears).
  audioPoll: ReturnType<typeof setInterval> | null
  audioPids: Set<number> | null
  // Per-device capture gain (0–1) from the sim's sim_volume. The tap captures pre-volume audio, so we
  // multiply it back in. Per-session field → each simulator's volume is applied independently.
  audioVolume: number
  // Last app launched via app:launch — the XCUITest tree backend queries by bundleId
  // (unlike the old AXUIElement path, which read whatever window was on screen).
  currentBundleId?: string
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly fps: number
  private readonly intervalMs: number | undefined
  private readonly reconnectDelays: number[]
  private readonly chromeLoader: DeviceChromeLoader
  private readonly deviceFilter?: string
  private readonly token?: string
  private readonly handshakeTimeoutMs: number
  private ws: WebSocket | null = null
  private deviceStates = new Map<string, DeviceState>()
  private readonly uiTreeReader = new XCUITreeReader()
  // Holds a macOS power assertion while connected so the host doesn't idle-throttle the
  // simulator capture/encode when the Mac is unattended. No-op off macOS.
  private readonly sleepBlocker: SleepBlocker
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper) {
    // IOSAgent는 직접 export되므로 AgentRegistry.canRun() 가드를 우회해 인스턴스화될 수 있다.
    // 비-macOS에서는 simctl/캡처가 불명확한 에러로 늦게 실패하므로 여기서 일찍 막는다.
    // simctl 주입은 테스트 경로이므로(모킹) 가드를 건너뛴다.
    if (!simctl && process.platform !== 'darwin') {
      throw new PlatformError('IOSAgent requires macOS (xcrun simctl is macOS-only)')
    }
    this.simctl = simctl ?? new SimctlWrapper()
    this.fps = options.fps ?? 30
    this.intervalMs = options.intervalMs
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 16000, 30000]
    this.chromeLoader = new DeviceChromeLoader()
    this.deviceFilter = options.deviceFilter
    this.token = options.token
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
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
    const allDevices = await this.simctl.listDevices()
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
          platform: 'ios',
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
        streamReader: null,
        captureStreamer: null,
        bootSeq: 0,
        orientation: 'portrait',
        loadedChrome: null,
        softKeyboardVisible: false,
        acceptH264: false,
        secureContext: false,
        external: false,
        audioStreamer: null,
        audioPort: 0,
        audioPoll: null,
        audioPids: null,
        audioVolume: 1,
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
    this.uiTreeReader.stop()
    this.sleepBlocker.release()
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
    this.simctl.stopKeyboardDaemon()
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
    const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.streamReader !== null).length
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
    void state.streamReader?.cancel()
    state.streamReader = null
    state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
    if (state.audioPoll) { clearInterval(state.audioPoll); state.audioPoll = null }
    state.audioStreamer?.stop() // closes the loopback server → the helper sees EOF and exits
    state.audioStreamer = null
    state.audioPort = 0
    state.audioPids = null
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null
  }

  private sendChromeData(state: DeviceState, device: Device): void {
    if (!this.ws) return
    state.touchHelper = new TouchHelper(device.id)
    state.touchHelper.start()
    this.ws.send(JSON.stringify({
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    }))
    state.loadedChrome = this.chromeLoader.load(device.typeId ?? device.name)
    if (!state.loadedChrome) return
    this.ws.send(JSON.stringify({
      type: 'session:chrome',
      sessionId: state.sessionId,
      payload: state.loadedChrome,
    }))
  }

  private startBinaryStream(state: DeviceState, streamWs: WebSocket): void {
    // H.264 is the default; opt out per-agent with TAPFLOW_IOS_CODEC=jpeg. It also needs
    // a browser that reported it can decode it (device:boot acceptH264) — otherwise JPEG.
    // Only on the ScreenCaptureStreamer path — the MjpegStreamer fallback is always JPEG.
    const envAllowsH264 = process.env.TAPFLOW_IOS_CODEC !== 'jpeg'
    const useH264 = this.intervalMs === undefined && envAllowsH264 && state.acceptH264
    const codec = useH264 ? CODEC_H264 : CODEC_JPEG
    let stream: ReadableStream<StreamFrame>
    if (this.intervalMs !== undefined) {
      state.captureStreamer = null
      stream = new MjpegStreamer(this.simctl, this.intervalMs).start()
    } else {
      const maxSize = pickMaxSize({
        secureContext: state.secureContext,
        external: state.external,
        override: process.env.TAPFLOW_IOS_MAX_SIZE ?? process.env.TAPFLOW_MAX_SIZE,
      })
      const capture = new ScreenCaptureStreamer(this.fps, state.deviceId, useH264 ? 'h264' : 'jpeg', maxSize)
      state.captureStreamer = capture
      stream = capture.start()
    }

    const reader = stream.getReader()
    state.streamReader = reader

    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)

    // Opt-in JPEG baseline measurement (TAPFLOW_STREAM_METRICS=1): logs throughput
    // every 5s so the iOS JPEG bandwidth/drop baseline can be compared against H.264.
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
    // Keyframe-aware backpressure: drop whole GOPs to the next keyframe (never an orphan P-frame,
    // which decodes to a sheared frame on WASM) and force an IDR on a drop (throttled). JPEG frames
    // are self-contained, so each counts as a keyframe.
    const dropper = createKeyframeAwareSender()
    let lastIdrReq = 0
    const onWantKeyframe = () => { const now = Date.now(); if (now - lastIdrReq >= 500) { lastIdrReq = now; state.captureStreamer?.requestKeyframe() } }

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          // Declare reorder=0 on the keyframe SPS so every decoder (WebCodecs, MSE,
          // WASM) emits frames immediately instead of buffering the level's max DPB
          // (~8 frames ≈ 250ms). Keyframe-only (SPS lives there); no-op otherwise.
          const payload = codec === CODEC_H264 && value.keyframe
            ? rewriteLowLatencySpsInFrame(value.payload)
            : value.payload
          const frame = writeEnvelopeHeader(payload as Buffer, Date.now(), { codec, keyframe: value.keyframe })
          const sent = dropper.send(streamWs, frame, threshold, codec === CODEC_JPEG || value.keyframe, onDrop, onWantKeyframe)
          if (sent) metrics?.recordSent(value.payload.length)
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      if (metricsTimer) clearInterval(metricsTimer)
      if (state.streamReader === reader && streamWs.readyState === WebSocket.OPEN) {
        this.startBinaryStream(state, streamWs)
      }
    }

    void pump()
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

  private async handleDeviceBoot(sessionId: string, deviceId: string, fullErase = false, acceptH264 = false, tier?: { secureContext: boolean; external: boolean }): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state || !this.ws) return

    state.acceptH264 = acceptH264
    if (tier) { state.secureContext = tier.secureContext; state.external = tier.external }
    const seq = ++state.bootSeq

    void state.streamReader?.cancel()
    state.streamReader = null
    state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null

    this.ws.send(JSON.stringify({ type: 'device:booting', sessionId }))

    try {
      const devices = await this.simctl.listDevices()
      if (seq !== state.bootSeq) return

      const target = devices.find((d) => d.id === deviceId)
      if (!target) throw new PlatformError(`Device not found: ${deviceId}`)

      if (fullErase) {
        await this.simctl.erase(deviceId)
        await this.simctl.boot(deviceId)
      } else if (target.status !== 'booted') {
        await this.bootWithZombieRecovery(deviceId)
      }

      if (seq !== state.bootSeq) return

      const refreshed = await this.simctl.listDevices()
      const refreshedDevice = refreshed.find((d) => d.id === deviceId) ?? target
      this.sendChromeData(state, {
        ...refreshedDevice,
        status: 'booted',
      } as Device)

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        return
      }

      this.startBinaryStream(state, streamWs)
      // Opt-in audio output: stand up the loopback server and start the whole-sim tap now. Best-effort
      // — never blocks/affects the video path.
      if (this.audioEnabled()) this.startAudioCapture(state, streamWs, deviceId)
      this.ws?.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId } }))

      // Sync AppleKeyboards after ready — fire-and-forget so streaming isn't delayed.
      // hw=Automatic lets the hardware layout follow the active input source on LANG1/CapsLock.
      // By the time the user navigates to a text field the sync has already completed.
      this.simctl.syncKeyboardsFromLanguages(deviceId).catch((e) => {
        logger.error('syncKeyboardsFromLanguages failed:', e)
      })


    } catch (e) {
      if (seq !== state.bootSeq) return
      const message = e instanceof Error ? e.message : String(e)
      this.ws?.send(JSON.stringify({ type: 'device:boot-error', sessionId, message }))
    }
  }

  // Boot a device, auto-recovering from a vanished data dir. simctl lists the device
  // as available but `boot` fails; erase regenerates the data and we retry once. Guarded
  // by isDeviceMissingError so an unrelated boot failure never erases a healthy device.
  private async bootWithZombieRecovery(deviceId: string): Promise<void> {
    try {
      await this.simctl.boot(deviceId)
    } catch (e) {
      if (!isDeviceMissingError(e)) throw e
      logger.warn(`iOS device ${deviceId} data missing on disk — erasing to recover, retrying boot once`)
      await this.simctl.erase(deviceId)
      await this.simctl.boot(deviceId)
    }
  }

  private async handleDeviceShutdown(sessionId: string, deviceId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return

    state.bootSeq++
    void state.streamReader?.cancel()
    state.streamReader = null
    state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null
    state.currentBundleId = undefined
    // The resident tree runner is bound to this simulator; drop it so a later
    // boot rebuilds/relaunches it against the fresh runtime.
    this.uiTreeReader.stop()

    try {
      await this.simctl.shutdown(deviceId)
      this.ws?.send(JSON.stringify({
        type: 'device:shutdown-done',
        sessionId,
        payload: { deviceId },
      }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error('shutdown failed:', message)
    }
  }

  private handleRelayMessage(msg: { type: string; sessionId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId, resetMode, acceptH264, secureContext, external } = msg.payload as { deviceId: string; resetMode?: string; acceptH264?: boolean; secureContext?: boolean; external?: boolean }
        const sessionId = msg.sessionId!
        this.handleDeviceBoot(sessionId, deviceId, resetMode === 'full-erase', acceptH264 === true, { secureContext: !!secureContext, external: !!external })
          .catch((e) => logger.error('handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        const sessionId = msg.sessionId!
        this.handleDeviceShutdown(sessionId, deviceId)
          .catch((e) => logger.error('handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath, bundleId } = msg.payload as { filePath: string; bundleId?: string }
        const sessionId = msg.sessionId
        this.installBuild(filePath, bundleId)
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
        const launchState = this.deviceStates.get(sessionId!)
        this.simctl.launchApp(bundleId)
          .then(() => {
            // Track the foreground app so ui:tree:request can query it via XCUITest.
            if (launchState) launchState.currentBundleId = bundleId
            // Audio: the whole-sim tap's poll picks up the launched app process within one interval;
            // no per-launch helper needed.
            this.ws?.send(JSON.stringify({ type: 'app:launch-done', sessionId }))
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:launch-error', sessionId, message }))
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) { logger.error('touch:start — touchHelper not ready'); break }
        const { x, y } = msg.payload as { x: number; y: number }
        state.touchHelper.touchStart(x, y)
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { x, y } = msg.payload as { x: number; y: number }
        state.touchHelper.touchMove(x, y)
        break
      }
      case 'input:touch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        state?.touchHelper?.touchEnd()
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        state.touchHelper.pinchStart(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        state.touchHelper.pinchMove(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        state.touchHelper.pinchEnd()
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        state.orientation = state.orientation === 'portrait' ? 'landscapeRight' : 'portrait'
        this.simctl.rotate(state.deviceId, state.orientation)
          .catch((e) => logger.error('rotate failed:', e))
        break
      }
      case 'stream:request-idr': {
        // Relay drop-to-keyframe recovery: force an IDR so the stream resyncs fast.
        this.deviceStates.get(msg.sessionId!)?.captureStreamer?.requestKeyframe()
        break
      }
      case 'input:keyboard:toggle': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const showing = !state.softKeyboardVisible
        const op = showing
          ? this.simctl.showSoftwareKeyboard(state.deviceId)
          : this.simctl.hideSoftwareKeyboard(state.deviceId)
        op.then(() => {
          state.softKeyboardVisible = showing
          this.ws?.send(JSON.stringify({
            type: 'keyboard:toggled',
            sessionId: state.sessionId,
            payload: { visible: showing },
          }))
        }).catch((e: unknown) => {
          logger.error('keyboard toggle failed:', e)
        })
        break
      }
      case 'input:type': {
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const { text } = (msg.payload ?? {}) as { text?: string }
        if (!state?.touchHelper) {
          this.ws?.send(JSON.stringify({ type: 'input:type-error', sessionId, message: 'No booted device' }))
          break
        }
        // simctl pbcopy → Cmd+V paste. Works for arbitrary Unicode (unlike a
        // per-character HID path, which is limited to keys on the layout) and
        // needs a focused text field, same as real typing. Cmd+V goes through
        // the same HID keyboard path as input:key, so hide the software
        // keyboard first when it's up — otherwise iOS desyncs the hardware
        // keyboard context and the chord is dropped (same guard as input:key).
        const doType = async (): Promise<void> => {
          if (!text) return
          await this.simctl.setPasteboard(state.deviceId, text)
          if (state.softKeyboardVisible) {
            state.softKeyboardVisible = false
            await this.simctl.hideSoftwareKeyboard(state.deviceId).catch(() => {})
          }
          state.touchHelper?.sendKey(KEY_CODE_MAP['KeyV'], MODIFIER_BITS['MetaLeft'])
        }
        // Ack on completion so a following input step (e.g. pressKey Enter) is
        // only sent after the paste has actually landed.
        doType()
          .then(() => this.ws?.send(JSON.stringify({ type: 'input:type-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            logger.error('input:type (pbcopy+paste) failed:', e)
            this.ws?.send(JSON.stringify({ type: 'input:type-error', sessionId, message }))
          })
        break
      }
      case 'input:key': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { code, modifiers } = msg.payload as { code: string; modifiers?: number }
        const usage = KEY_CODE_MAP[code]
        if (usage === undefined) break
        if (state.softKeyboardVisible) {
          // Hide the SW keyboard first so iOS re-initialises the HW keyboard
          // context. Skipping this causes input-source desync (qks / ㅂㅏㄴ symptoms).
          state.softKeyboardVisible = false
          this.simctl.hideSoftwareKeyboard(state.deviceId)
            .then(() => state.touchHelper?.sendKey(usage, modifiers ?? 0))
            .catch((e: unknown) => {
              logger.error('hideSoftwareKeyboard (on key) failed:', e)
              state.touchHelper?.sendKey(usage, modifiers ?? 0)
            })
        } else {
          state.touchHelper.sendKey(usage, modifiers ?? 0)
        }
        break
      }
      case 'input:button': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { name, phase } = msg.payload as { name: string; phase?: 'down' | 'up' }
        // Map the cross-platform button vocabulary (used by MCP) onto this
        // device's actual chrome button names. Dashboard already sends the raw
        // chrome names (e.g. "volume-up"), which pass through unchanged.
        const chromeName = IOS_BUTTON_ALIASES[name] ?? name
        if (chromeName === 'home') {
          // Home has no HID down/up split — always a single legacy press. Send once on release
          // (or on a phase-less legacy message) so a down+up pair doesn't fire it twice.
          if (phase !== 'down') state.touchHelper.pressLegacyButton(0)
        } else {
          const btn = state.loadedChrome?.buttons.find((b) => b.name === chromeName)
          if (btn && btn.usagePage > 0 && btn.usage > 0) {
            if (phase === 'down') state.touchHelper.pressButtonDown(btn.usagePage, btn.usage)
            else if (phase === 'up') state.touchHelper.pressButtonUp(btn.usagePage, btn.usage)
            else state.touchHelper.pressButton(btn.usagePage, btn.usage)
          }
        }
        break
      }
      case 'open-url': {
        const { url } = msg.payload as { url: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        if (!state) {
          this.ws?.send(JSON.stringify({ type: 'open-url:error', sessionId, message: 'no booted device' }))
          break
        }
        this.simctl.openUrl(state.deviceId, url)
          .then(() => this.ws?.send(JSON.stringify({ type: 'open-url:done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'open-url:error', sessionId, message }))
          })
        break
      }
      case 'screenshot:request': {
        const raw = msg as unknown as { requestId: string; format?: 'png' | 'jpeg'; sessionId?: string }
        const { requestId, format } = raw
        const sessionId = msg.sessionId
        this.simctl.screenshot(format ?? 'png')
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
        if (!state || !bundleId) {
          this.ws?.send(JSON.stringify({ type: 'app:clear-state-error', sessionId, message: !state ? 'No booted device' : 'bundleId missing' }))
          break
        }
        this.simctl.clearAppData(bundleId)
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
        if (!state) {
          this.ws?.send(JSON.stringify({ type: 'ui:tree:error', sessionId, requestId, message: 'No booted device' }))
          break
        }
        this.readUITree(state)
          .then((elements) => this.ws?.send(JSON.stringify({ type: 'ui:tree:response', sessionId, requestId, elements })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'ui:tree:error', sessionId, requestId, message }))
          })
        break
      }
    }
  }

  // The XCUITest backend queries a specific app by bundleId (the last one launched
  // via app:launch), reading its tree from inside the simulator — no Simulator.app
  // window required.
  private async readUITree(state: DeviceState): Promise<UIElement[]> {
    if (!state.currentBundleId) {
      throw new PlatformError('no app launched — launch an app before querying the UI tree')
    }
    return this.uiTreeReader.read(state.deviceId, state.currentBundleId)
  }

  /**
   * .app.zip / .tar.gz(.tgz) 이면 임시 디렉토리에 풀어 .app 경로로 설치, 그 외(.apk 등)는
   * 직접 설치. tar 추출은 실행 비트·심볼릭 링크를 보존하고(재압축이 아니라 네이티브 보관),
   * macOS tar(libarchive)가 path traversal·symlink 탈출을 기본 차단한다. 완료 후 임시 정리.
   */
  private async installBuild(filePath: string, bundleId?: string): Promise<void> {
    if (bundleId) {
      await this.simctl.uninstallApp(bundleId).catch(() => { /* 미설치 상태면 무시 */ })
    }

    const lower = filePath.toLowerCase()
    const isTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz')
    const isZip = lower.endsWith('.zip')
    if (!isTar && !isZip) {
      return this.simctl.installApp(filePath)
    }

    const tmpDir = path.join(tmpdir(), `tapflow-install-${randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      // tar 는 기본 무음, unzip 은 -q 로 무음화해 큰 .app 에서 verbose stdout 이 기본
      // maxBuffer(1MB)를 넘겨 추출이 죽는 것을 막는다.
      const result = isTar
        ? spawnSync('tar', ['-xzf', filePath, '-C', tmpDir], { maxBuffer: EXTRACT_MAXBUFFER })
        : spawnSync('unzip', ['-q', '-o', filePath, '-d', tmpDir], { maxBuffer: EXTRACT_MAXBUFFER })
      // 실행 자체 실패(tar/unzip 부재=ENOENT 등)는 아카이브 무효와 구분한다.
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code ?? result.error.message
        throw new Error(`아카이브 추출 실행 실패 (${isTar ? 'tar' : 'unzip'}: ${code})`)
      }
      if (result.status !== 0) {
        throw new ValidationError(
          isTar
            ? 'tar.gz 압축 해제 실패 — 시뮬레이터용 .tar.gz(경로 탈출/심볼릭 링크 없는)인지 확인하세요.'
            : 'zip 압축 해제 실패 — 시뮬레이터용 .app.zip 파일인지 확인하세요.',
        )
      }

      const entries = fs.readdirSync(tmpDir)
      const appDir = entries.find(e => e.endsWith('.app') && fs.statSync(path.join(tmpDir, e)).isDirectory())
      if (!appDir) {
        throw new ValidationError('.app 디렉토리를 찾을 수 없습니다. iphonesimulator 로 빌드한 .app 을 .app.zip 또는 .tar.gz 로 업로드하세요.')
      }

      await this.simctl.installApp(path.join(tmpDir, appDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // DeviceAgent interface — delegate to SimctlWrapper
  listDevices(): Promise<Device[]> { return this.simctl.listDevices() }
  boot(deviceId: string): Promise<void> { return this.simctl.boot(deviceId) }
  shutdown(deviceId: string): Promise<void> { return this.simctl.shutdown(deviceId) }
  installApp(appPath: string): Promise<void> { return this.simctl.installApp(appPath) }
  async launchApp(bundleId: string): Promise<void> { await this.simctl.launchApp(bundleId) }

  async queryUITree(): Promise<UIElement[]> {
    const state = this.deviceStates.values().next().value
    if (!state) throw new ValidationError('no booted device — call connect() first')
    return this.readUITree(state)
  }

  // ── Audio output (opt-in, macOS 14.2+ Core Audio process taps) ───────────────────────────────
  // Simulator apps are host processes, so a process tap on the launched app's PID captures its audio
  // with no device routing, no injection, and no host-output hijack. The capture runs in a separate
  // signed .app (audiotap-helper) launched via LaunchServices so it holds its own audio-recording TCC
  // grant; it streams PCM back over loopback TCP. See AudioCaptureStreamer.

  // Audio output is ON by default (macOS 14.2+); opt out with TAPFLOW_AUDIO=off. The tap is .muted, so
  // the sim's audio goes only to the browser and the host (agent Mac) stays silent. The grant is
  // primed at `tapflow agent start`; see contributing/simulator-audio.md.
  private audioEnabled(): boolean {
    return process.env.TAPFLOW_AUDIO !== 'off' && isAudioSupported()
  }

  // Stand up the per-session loopback server the audiotap-helper streams to, pump its frames to the
  // relay, and start the whole-sim tap: launch the helper for the simulator's current process tree,
  // then poll for new processes (apps, WebKit WebContent) and push deltas over the same socket.
  private startAudioCapture(state: DeviceState, streamWs: WebSocket, udid: string): void {
    const seq = state.bootSeq
    const streamer = new AudioCaptureStreamer()
    streamer.listen()
      .then((port) => {
        // A reboot/shutdown/disconnect may have superseded this boot while listen() was binding —
        // discard so we don't leave an orphan helper/poll/server behind the current lifecycle.
        if (seq !== state.bootSeq || streamWs.readyState !== WebSocket.OPEN) { streamer.stop(); return }
        state.audioStreamer = streamer
        state.audioPort = port
        state.audioVolume = readSimVolume(udid)
        void this.pumpAudio(streamWs, streamer.frames(), state)
        this.launchWholeSimTap(state, udid)
        state.audioPoll = setInterval(() => {
          this.refreshAudioPids(state, udid)
          state.audioVolume = readSimVolume(udid) // track live sim-volume changes
        }, AUDIO_POLL_MS)
      })
      .catch((e) => logger.warn(`audio capture server failed to start: ${e instanceof Error ? e.message : String(e)}`))
  }

  // Launch the tap helper for the simulator's whole process tree. Swallows errors — audio must never
  // break the launch/video path (e.g. helper build fails, or the user hasn't granted the audio
  // permission). The helper holds the socket open; refreshAudioPids() pushes later updates to it.
  private launchWholeSimTap(state: DeviceState, udid: string): void {
    const pids = enumerateSimPids(udid)
    if (!pids.length) { logger.warn('no simulator processes to tap (audio idle until first poll)'); return }
    state.audioPids = new Set(pids)
    try {
      launchAudioHelper(ensureHelperApp(), state.audioPort, pids)
    } catch (e) {
      logger.warn(`audiotap-helper launch failed (audio disabled): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Re-enumerate the sim's process tree and, only when a NEW process appeared (a launched app or a
  // freshly spawned WebKit WebContent), push the updated set so the helper rebuilds its tap. Dead pids
  // need no rebuild — they resolve to no audio object, so the helper just stops mixing them; we still
  // refresh the baseline so a later reappearance is detected. Rebuilding only on additions keeps
  // short-lived daemon churn from causing constant tap teardown (audio glitches).
  private refreshAudioPids(state: DeviceState, udid: string): void {
    if (!state.audioStreamer) return
    const pids = enumerateSimPids(udid)
    if (!pids.length) return
    const prev = state.audioPids
    const hasNew = !prev || pids.some((p) => !prev.has(p))
    state.audioPids = new Set(pids)
    if (hasNew) state.audioStreamer.updatePids(pids)
  }

  // Forward captured PCM to the relay on the shared stream socket via the yielding sender (audio must
  // never inflate the socket buffer enough to trip video's backpressure). Mirrors android-agent.
  private async pumpAudio(streamWs: WebSocket, frames: ReadableStream<AudioFrame>, state: DeviceState): Promise<void> {
    const warnDrop = createRateLimitedDropWarn(logger, 'ios audio')
    const reader = frames.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || streamWs.readyState !== WebSocket.OPEN) break
        if (state.audioVolume < 0.999) applyGain(value.payload, state.audioVolume) // reflect sim volume (tap is pre-volume)
        const frame = writeEnvelopeHeader(value.payload, Date.now(), { codec: CODEC_AUDIO })
        sendAudioYieldingToVideo(streamWs, frame, warnDrop)
      }
    } catch {
      // stream cancelled or ws closed — expected on teardown/restart
    }
  }
  screenshot(): Promise<Buffer> { return this.simctl.screenshot() }
  stream(): ReadableStream<Buffer> {
    const first = this.deviceStates.values().next().value
    if (!first) throw new ValidationError('no booted device — call connect() first')
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap StreamFrame payloads.
    return new ScreenCaptureStreamer(this.fps, first.deviceId).start()
      .pipeThrough(new TransformStream<StreamFrame, Buffer>({
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

  openUrl(url: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    if (!first) throw new ValidationError('no booted device — call connect() first')
    return this.simctl.openUrl(first.deviceId, url)
  }
}
