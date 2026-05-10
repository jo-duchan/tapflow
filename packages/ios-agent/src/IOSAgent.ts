import os from 'os'
import { WebSocket } from 'ws'
import type { Device, DeviceAgent } from '@tapflow/agent-core'
import { SimctlWrapper } from './SimctlWrapper'
import { ScreenCaptureStreamer } from './ScreenCaptureStreamer'
import { MjpegStreamer } from './MjpegStreamer'
import { WdaClient } from './WdaClient'
import { WdaLauncher } from './WdaLauncher'
import { TouchHelper } from './TouchHelper'
import { DeviceChromeLoader, type ChromeData } from './DeviceChromeLoader'

export interface WdaOptions {
  /** Auto-launch WDA if not running. Defaults to false. */
  autoStart?: boolean
  /** WDA HTTP port. Defaults to 8100. */
  port?: number
  /** Path to a pre-built .xctestrun file. Takes priority over WDA_PATH env and cache. */
  xctestrunPath?: string
}

export interface IOSAgentOptions {
  fps?: number
  intervalMs?: number  // when set, uses MjpegStreamer (simctl screenshot polling) instead of ScreenCaptureStreamer
  wdaUrl?: string
  wda?: WdaOptions
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly wda: WdaClient
  private readonly fps: number
  private readonly intervalMs: number | undefined
  private readonly wdaOptions: WdaOptions
  private readonly chromeLoader: DeviceChromeLoader
  private wdaLauncher: WdaLauncher | null = null
  private touchHelper: TouchHelper | null = null
  private loadedChrome: ChromeData | null = null
  private bootedDeviceId: string | null = null
  private bootSeq = 0
  private orientation: 'portrait' | 'landscapeRight' = 'portrait'
  private ws: WebSocket | null = null
  private _sessionId: string | null = null
  private streamReader: ReadableStreamDefaultReader<Buffer> | null = null

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper, wdaClient?: WdaClient) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.fps = options.fps ?? 60
    this.intervalMs = options.intervalMs
    this.wdaOptions = options.wda ?? {}
    const wdaPort = options.wda?.port ?? 8100
    const wdaBase = options.wdaUrl ?? `http://localhost:${wdaPort}`
    this.wda = wdaClient ?? new WdaClient(wdaBase)
    this.chromeLoader = new DeviceChromeLoader()
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  async connect(relayUrl: string): Promise<void> {
    const devices = await this.simctl.listDevices()
    const booted = devices.find((d) => d.status === 'booted')

    if (booted && this.wdaOptions.autoStart) {
      this.wdaLauncher = new WdaLauncher({
        udid: booted.id,
        port: this.wdaOptions.port ?? 8100,
        xctestrunPath: this.wdaOptions.xctestrunPath,
      })
      await this.wdaLauncher.ensureRunning()
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'agent:register',
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
          this._sessionId = msg.sessionId
          ws.on('message', (d) => {
            try { this.handleRelayMessage(JSON.parse(d.toString())) } catch { /* ignore malformed */ }
          })
          resolve()
        } else {
          reject(new Error(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      ws.once('error', reject)
    })
  }

  disconnect(): void {
    this.streamReader?.cancel()
    this.streamReader = null
    this.touchHelper?.stop()
    this.touchHelper = null
    this.wdaLauncher?.stop()
    this.wdaLauncher = null
    this.ws?.close()
    this.ws = null
    this._sessionId = null
  }

  private sendChromeData(devices: Device[]): void {
    const booted = devices.find((d) => d.status === 'booted')
    if (!booted || !this.ws) return
    this.bootedDeviceId = booted.id
    this.touchHelper = new TouchHelper(booted.id)
    this.touchHelper.start()
    this.ws.send(JSON.stringify({
      type: 'session:deviceInfo',
      payload: {
        deviceName: booted.name,
        osVersion: booted.osVersion ?? '',
      },
    }))
    this.loadedChrome = this.chromeLoader.load(booted.typeId ?? booted.name)
    if (!this.loadedChrome) return
    this.ws.send(JSON.stringify({ type: 'session:chrome', payload: this.loadedChrome }))
  }

  private startBinaryStream(): void {
    const stream = this.intervalMs !== undefined
      ? new MjpegStreamer(this.simctl, this.intervalMs).start()
      : new ScreenCaptureStreamer(this.fps, this.bootedDeviceId ?? 'booted').start()

    const reader = stream.getReader()
    this.streamReader = reader

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(value)
          }
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      // auto-restart if still connected (e.g. screencapture-helper exited unexpectedly)
      if (this.streamReader === reader && this.ws?.readyState === WebSocket.OPEN) {
        this.startBinaryStream()
      }
    }

    pump()
  }

  private async handleDeviceBoot(deviceId: string): Promise<void> {
    const seq = ++this.bootSeq

    this.streamReader?.cancel()
    this.streamReader = null
    this.touchHelper?.stop()
    this.touchHelper = null

    if (!this.ws) return
    this.ws.send(JSON.stringify({ type: 'device:booting' }))

    try {
      const devices = await this.simctl.listDevices()
      if (seq !== this.bootSeq) return

      const target = devices.find((d) => d.id === deviceId)
      if (!target) throw new Error(`Device not found: ${deviceId}`)

      if (target.status !== 'booted') {
        await this.simctl.boot(deviceId)
      }

      if (seq !== this.bootSeq) return

      const refreshed = await this.simctl.listDevices()
      this.sendChromeData(refreshed.map((d) => ({
        ...d,
        status: (d.id === deviceId ? 'booted' : 'shutdown') as Device['status'],
      })))
      this.startBinaryStream()
      this.ws?.send(JSON.stringify({ type: 'device:ready', payload: { deviceId } }))
    } catch (e) {
      if (seq !== this.bootSeq) return
      const message = e instanceof Error ? e.message : String(e)
      this.ws?.send(JSON.stringify({ type: 'device:boot-error', message }))
    }
  }

  private async handleDeviceShutdown(deviceId: string): Promise<void> {
    this.bootSeq++
    this.streamReader?.cancel()
    this.streamReader = null
    this.touchHelper?.stop()
    this.touchHelper = null
    this.bootedDeviceId = null

    try {
      await this.simctl.shutdown(deviceId)
      this.ws?.send(JSON.stringify({ type: 'device:shutdown-done', payload: { deviceId } }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[agent] shutdown failed:', message)
    }
  }

  private handleRelayMessage(msg: { type: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceBoot(deviceId).catch((e) => console.error('[agent] handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceShutdown(deviceId).catch((e) => console.error('[agent] handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath } = msg.payload as { filePath: string }
        this.simctl.installApp(filePath)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:install-done' })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:install-error', message }))
          })
        break
      }
      case 'app:launch': {
        const { bundleId } = msg.payload as { bundleId: string }
        this.simctl.launchApp(bundleId)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:launch-done' })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:launch-error', message }))
          })
        break
      }
      case 'input:touch:start': {
        if (!this.touchHelper) { console.error('[agent] touch:start — touchHelper not ready'); break }
        const { x, y } = msg.payload as { x: number; y: number }
        this.touchStart(x, y)
        break
      }
      case 'input:touch:move': {
        if (!this.touchHelper) break
        const { x, y } = msg.payload as { x: number; y: number }
        this.touchMove(x, y)
        break
      }
      case 'input:touch:end': {
        this.touchEnd().catch(() => {})
        break
      }
      case 'input:pinch:start': {
        if (!this.touchHelper) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        this.touchHelper.pinchStart(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:move': {
        if (!this.touchHelper) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        this.touchHelper.pinchMove(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:end': {
        if (!this.touchHelper) break
        this.touchHelper.pinchEnd()
        break
      }
      case 'input:rotate': {
        if (!this.bootedDeviceId) break
        this.orientation = this.orientation === 'portrait' ? 'landscapeRight' : 'portrait'
        this.simctl.rotate(this.bootedDeviceId, this.orientation)
          .catch((e) => console.error('[agent] rotate failed:', e))
        break
      }
      case 'input:type': {
        const { text } = msg.payload as { text: string }
        this.wda.type(text).catch((e) => console.error('[agent] type failed:', e))
        break
      }
      case 'input:button': {
        const { name } = msg.payload as { name: string }
        if (this.touchHelper) {
          if (name === 'home') {
            this.touchHelper.pressLegacyButton(0)
          } else {
            const btn = this.loadedChrome?.buttons.find((b) => b.name === name)
            if (btn && btn.usagePage > 0 && btn.usage > 0) {
              this.touchHelper.pressButton(btn.usagePage, btn.usage)
            } else {
              this.wda.pressButton(name).catch((e) => console.error('[agent] button wda fallback failed:', e))
            }
          }
        }
        break
      }
    }
  }

  // DeviceAgent interface — delegate to SimctlWrapper
  listDevices(): Promise<Device[]> { return this.simctl.listDevices() }
  boot(deviceId: string): Promise<void> { return this.simctl.boot(deviceId) }
  shutdown(deviceId: string): Promise<void> { return this.simctl.shutdown(deviceId) }
  installApp(path: string): Promise<void> { return this.simctl.installApp(path) }
  launchApp(bundleId: string): Promise<void> { return this.simctl.launchApp(bundleId) }
  screenshot(): Promise<Buffer> { return this.simctl.screenshot() }
  stream(): ReadableStream<Buffer> {
    if (!this.bootedDeviceId) throw new Error('no booted device — call connect() first')
    return new ScreenCaptureStreamer(this.fps, this.bootedDeviceId).start()
  }

  touchStart(x: number, y: number): void { this.touchHelper?.touchStart(x, y) }
  touchMove(x: number, y: number): Promise<void> {
    this.touchHelper?.touchMove(x, y)
    return Promise.resolve()
  }
  touchEnd(): Promise<void> {
    this.touchHelper?.touchEnd()
    return Promise.resolve()
  }
  type(text: string): Promise<void> { return this.wda.type(text) }
}
