import os from 'os'
import { WebSocket } from 'ws'
import type { AndroidButton, Device, DeviceAgent } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'
import {
  createResourceSampler,
  registerStreamWs,
  sendBinaryWithBackpressure,
  createRateLimitedDropWarn,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
} from '@tapflowio/agent-core/utils'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher } from './EmulatorLauncher.js'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'

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
  displayWidth: number
  displayHeight: number
  videoWidth: number   // actual scrcpy video frame dimensions — used for touch coordinates
  videoHeight: number
  deviceRotation: number
  lastTouchPx: { x: number; y: number }
  bootSeq: number
  restarting: boolean
}

export interface AndroidAgentOptions {
  fps?: number
  /** AVD name or emulator serial to expose. Omit to expose all detected devices. */
  deviceFilter?: string
}

export class AndroidAgent implements DeviceAgent {
  private readonly adb: AdbWrapper
  private readonly launcher: EmulatorLauncher
  private ws: WebSocket | null = null
  private deviceStates = new Map<string, DeviceState>()
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0

  private readonly deviceFilter?: string

  constructor(options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
    this.deviceFilter = options.deviceFilter
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
        displayWidth: 0,
        displayHeight: 0,
        videoWidth: 0,
        videoHeight: 0,
        deviceRotation: 0,
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

    const delays = [1000, 2000, 4000, 8000, 16000, 30000]
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
    const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.scrcpySession !== null).length
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

  private async startVideoStream(state: DeviceState, streamWs: WebSocket): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) return

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const session = new ScrcpySession()
    const info = await session.start(serial, (rotation) => this.handleRotationNotification(state, rotation))
    state.scrcpySession = session
    state.deviceRotation = 0

    state.displayWidth = info.width
    state.displayHeight = info.height
    state.videoWidth = info.width
    state.videoHeight = info.height

    const stream = session.video.start()
    const reader = stream.getReader()

    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const onDrop = createRateLimitedDropWarn(logger, state.deviceId)

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          // Detect video size changes via H.264 SPS so ScrcpyControl.screenSize always
          // matches what scrcpy server is actually encoding (landscape-aware vs portrait-locked).
          const parsed = parseSpsFromNal(value)
          if (parsed && (parsed.width !== state.videoWidth || parsed.height !== state.videoHeight)) {
            state.videoWidth = parsed.width
            state.videoHeight = parsed.height
            state.scrcpySession?.control.updateScreenSize(parsed.width, parsed.height)
            logger.info(`video size → ${parsed.width}×${parsed.height}`)
          }
          sendBinaryWithBackpressure(streamWs, writeEnvelopeHeader(value, Date.now()), threshold, onDrop)
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      if (state.scrcpySession === session && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    }

    void pump()
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

  private handleRotationNotification(state: DeviceState, rotation: number): void {
    if (rotation === state.deviceRotation) return
    const prevRotation = state.deviceRotation
    state.deviceRotation = rotation

    // Swap displayW/H when rotation changes by an odd number of 90° steps.
    // Do NOT call control.updateScreenSize here — scrcpy screenWidth/Height must match
    // the actual video frame dimensions set in the ScrcpyControl constructor, not the
    // display orientation. Portrait-locked apps keep portrait video even on a landscape
    // device; mismatching screenSize causes scrcpy to silently drop all touch events.
    const quarters = ((rotation - prevRotation) + 4) % 4
    if (quarters === 1 || quarters === 3) {
      ;[state.displayWidth, state.displayHeight] = [state.displayHeight, state.displayWidth]
    }

    logger.info(`rotation ${prevRotation}→${rotation} displaySize=${state.displayWidth}×${state.displayHeight}`)

    this.ws?.send(JSON.stringify({
      type: 'device:rotate',
      sessionId: state.sessionId,
      payload: { rotation, displayWidth: state.displayWidth, displayHeight: state.displayHeight },
    }))
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
        this.launcher.launch(avdName)
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
        if (state.scrcpySession && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          state.scrcpySession.control.touchDown(0, px, py)
        } else {
          state.touchHelper?.touchStart(x, y)
        }
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        if (state.scrcpySession && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          state.scrcpySession.control.touchMove(0, px, py)
        } else {
          state.touchHelper?.touchMove(x, y)
        }
        break
      }
      case 'input:touch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        if (state.scrcpySession) {
          state.scrcpySession.control.touchUp(0, state.lastTouchPx.x, state.lastTouchPx.y)
        } else {
          state.touchHelper?.touchEnd()
        }
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        if (state.scrcpySession && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          state.scrcpySession.control.pinchStart(px1, py1, px2, py2)
        } else {
          state.touchHelper?.pinchStart(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        if (state.scrcpySession && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          state.scrcpySession.control.pinchMove(px1, py1, px2, py2)
        } else {
          state.touchHelper?.pinchMove(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        if (state.scrcpySession) {
          state.scrcpySession.control.pinchEnd()
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
        // Optimistically advance rotation by 90° so the view updates immediately.
        // ROTATION_NOTIFICATION will reconcile the actual value; dedup logic in handleRotationNotification
        // prevents a double-swap if prediction matches.
        this.handleRotationNotification(state, (state.deviceRotation + 1) % 4)
        this.adb.enableAutoRotate(serial).catch(() => {})
        this.adb.emuRotate(serial).catch(() => {})
        break
      }
      case 'input:button': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { name } = msg.payload as { name: string }
        state.touchHelper.pressButton(name)
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
    return state.scrcpySession.video.start()
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

}
