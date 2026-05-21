import os from 'os'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { WebSocket } from 'ws'
import type { Device, DeviceAgent } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent')
import {
  createResourceSampler,
  registerStreamWs,
  sendBinaryWithBackpressure,
  createRateLimitedDropWarn,
  DEFAULT_BACKPRESSURE_BYTES,
} from '@tapflowio/agent-core/utils'
import { SimctlWrapper } from './SimctlWrapper.js'
import { ScreenCaptureStreamer } from './ScreenCaptureStreamer.js'
import { MjpegStreamer } from './MjpegStreamer.js'
import { TouchHelper } from './TouchHelper.js'
import { DeviceChromeLoader, type ChromeData } from './DeviceChromeLoader.js'
import { KEY_CODE_MAP } from './KeyCodeMap.js'

export interface IOSAgentOptions {
  fps?: number
  intervalMs?: number
}

interface DeviceState {
  sessionId: string
  deviceId: string
  touchHelper: TouchHelper | null
  streamWs: WebSocket | null
  streamReader: ReadableStreamDefaultReader<Buffer> | null
  bootSeq: number
  orientation: 'portrait' | 'landscapeRight'
  loadedChrome: ChromeData | null
  // tracks whether the software keyboard is currently visible so we can send ⌘K
  // in the correct direction. reset to false on any hardware key event because
  // iOS auto-hides the software keyboard whenever a hardware key is pressed.
  softKeyboardVisible: boolean
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly fps: number
  private readonly intervalMs: number | undefined
  private readonly chromeLoader: DeviceChromeLoader
  private ws: WebSocket | null = null
  private deviceStates = new Map<string, DeviceState>()
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private readonly resources = createResourceSampler()

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.fps = options.fps ?? 30
    this.intervalMs = options.intervalMs
    this.chromeLoader = new DeviceChromeLoader()
  }

  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    this.relayUrl = relayUrl
    const devices = await this.simctl.listDevices()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'agent:register',
          platform: 'ios',
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
        streamReader: null,
        bootSeq: 0,
        orientation: 'portrait',
        loadedChrome: null,
        softKeyboardVisible: false,
      })
    })
  }

  disconnect(): void {
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    for (const state of this.deviceStates.values()) {
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
    this.simctl.stopKeyboardDaemon()
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
    const stream = this.intervalMs !== undefined
      ? new MjpegStreamer(this.simctl, this.intervalMs).start()
      : new ScreenCaptureStreamer(this.fps, state.deviceId).start()

    const reader = stream.getReader()
    state.streamReader = reader

    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const onDrop = createRateLimitedDropWarn(logger, state.deviceId)

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          sendBinaryWithBackpressure(streamWs, value, threshold, onDrop)
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      if (state.streamReader === reader && streamWs.readyState === WebSocket.OPEN) {
        this.startBinaryStream(state, streamWs)
      }
    }

    void pump()
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    const streamWs = new WebSocket(this.relayUrl!)
    state.streamWs = streamWs
    await registerStreamWs(streamWs, state.sessionId)
    return streamWs
  }

  private async handleDeviceBoot(sessionId: string, deviceId: string, fullErase = false): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state || !this.ws) return

    const seq = ++state.bootSeq

    void state.streamReader?.cancel()
    state.streamReader = null
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
        await this.simctl.boot(deviceId)
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

  private async handleDeviceShutdown(sessionId: string, deviceId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return

    state.bootSeq++
    void state.streamReader?.cancel()
    state.streamReader = null
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null

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
        const { deviceId, resetMode } = msg.payload as { deviceId: string; resetMode?: string }
        const sessionId = msg.sessionId!
        this.handleDeviceBoot(sessionId, deviceId, resetMode === 'full-erase')
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
        this.simctl.launchApp(bundleId)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:launch-done', sessionId })))
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
        const { name } = msg.payload as { name: string }
        if (name === 'home') {
          state.touchHelper.pressLegacyButton(0)
        } else {
          const btn = state.loadedChrome?.buttons.find((b) => b.name === name)
          if (btn && btn.usagePage > 0 && btn.usage > 0) {
            state.touchHelper.pressButton(btn.usagePage, btn.usage)
          }
        }
        break
      }
    }
  }

  /**
   * .app.zip 이면 임시 디렉토리에 풀어 .app 경로로 설치, .apk 이면 직접 설치.
   * install 완료 후 임시 디렉토리를 정리한다.
   */
  private async installBuild(filePath: string, bundleId?: string): Promise<void> {
    if (bundleId) {
      await this.simctl.uninstallApp(bundleId).catch(() => { /* 미설치 상태면 무시 */ })
    }

    if (!filePath.endsWith('.zip')) {
      return this.simctl.installApp(filePath)
    }

    const tmpDir = path.join(tmpdir(), `tapflow-install-${randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      const result = spawnSync('unzip', ['-o', filePath, '-d', tmpDir])
      if (result.status !== 0) {
        throw new ValidationError(`zip 압축 해제 실패 — 시뮬레이터용 .app.zip 파일인지 확인하세요.`)
      }

      const entries = fs.readdirSync(tmpDir)
      const appDir = entries.find(e => e.endsWith('.app') && fs.statSync(path.join(tmpDir, e)).isDirectory())
      if (!appDir) {
        throw new ValidationError('.app 디렉토리를 찾을 수 없습니다. xcodebuild -sdk iphonesimulator 로 빌드한 .app 을 zip 압축해 업로드하세요.')
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
  launchApp(bundleId: string): Promise<void> { return this.simctl.launchApp(bundleId) }
  screenshot(): Promise<Buffer> { return this.simctl.screenshot() }
  stream(): ReadableStream<Buffer> {
    const first = this.deviceStates.values().next().value
    if (!first) throw new ValidationError('no booted device — call connect() first')
    return new ScreenCaptureStreamer(this.fps, first.deviceId).start()
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
