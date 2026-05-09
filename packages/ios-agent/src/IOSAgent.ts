import { WebSocket } from 'ws'
import type { Device, DeviceAgent } from '@tapflow/agent-core'
import { SimctlWrapper } from './SimctlWrapper'
import { ScreenCaptureStreamer } from './ScreenCaptureStreamer'
import { MjpegStreamer } from './MjpegStreamer'
import { WdaClient } from './WdaClient'
import { WdaLauncher } from './WdaLauncher'
import { TouchHelper } from './TouchHelper'
import { DeviceChromeLoader, type ChromeData } from './DeviceChromeLoader'
import { WebRTCStreamer } from './WebRTCStreamer'

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
  private orientation: 'portrait' | 'landscapeRight' = 'portrait'
  private ws: WebSocket | null = null
  private _sessionId: string | null = null
  private streamReader: ReadableStreamDefaultReader<Buffer> | null = null
  private streamMimeType: string = 'image/jpeg'
  private webrtc: WebRTCStreamer | null = null

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper, wdaClient?: WdaClient) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.fps = options.fps ?? 30
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
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            status: d.status,
          })),
        }))
      })

      ws.once('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent:registered') {
          this.ws = ws
          this._sessionId = msg.sessionId
          this.sendChromeData(devices)
          this.startStreaming().catch((e) => console.error('[agent] startStreaming failed:', e))
          ws.on('message', (d) => this.handleRelayMessage(JSON.parse(d.toString())))
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
    this.webrtc?.close()
    this.webrtc = null
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

  private async startStreaming(): Promise<void> {
    if (this.intervalMs === undefined) {
      const negotiated = await this.tryStartWebRTC()
      if (negotiated) return
    }
    this.startMjpegFallback()
  }

  private async tryStartWebRTC(): Promise<boolean> {
    const ws = this.ws
    if (!ws) return false

    return new Promise<boolean>((resolve) => {
      const NEGOTIATION_TIMEOUT_MS = 3000
      let resolved = false

      const settle = (success: boolean) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        resolve(success)
      }

      const timer = setTimeout(() => settle(false), NEGOTIATION_TIMEOUT_MS)

      const webrtc = new WebRTCStreamer({
        onOffer: (offer) => {
          this.ws?.send(JSON.stringify({ type: 'webrtc:offer', payload: offer }))
        },
        onIceCandidate: (candidate) => {
          this.ws?.send(JSON.stringify({ type: 'webrtc:ice', payload: candidate }))
        },
      })
      this.webrtc = webrtc

      const originalHandler = ws.listeners('message') as Array<(data: Buffer) => void>

      const signalingHandler = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as { type: string; payload?: unknown }
          if (msg.type === 'webrtc:answer') {
            webrtc.setAnswer(msg.payload as { type: 'answer'; sdp: string })
              .then(() => {
                this.ws?.off('message', signalingHandler)
                this.ws?.on('message', (d) => this.handleRelayMessage(JSON.parse(d.toString())))
                settle(true)
                this.pumpWebRTC()
              })
              .catch(() => settle(false))
          } else if (msg.type === 'webrtc:ice') {
            webrtc.addIceCandidate(msg.payload as RTCIceCandidateInit).catch(() => {})
          } else {
            // not a webrtc message — re-dispatch to existing handlers
            for (const h of originalHandler) h(data)
          }
        } catch { /* ignore malformed */ }
      }

      ws.on('message', signalingHandler)
      webrtc.start().catch(() => settle(false))
    })
  }

  private pumpWebRTC(): void {
    const stream = new ScreenCaptureStreamer(this.fps, this.bootedDeviceId ?? 'booted').start()
    const reader = stream.getReader()
    this.streamReader = reader

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          await this.webrtc?.pushFrame(value)
        }
      } catch {
        // stream cancelled or webrtc closed — expected on disconnect
      }
    }

    pump()
  }

  private startMjpegFallback(): void {
    let stream: ReadableStream<Buffer>
    if (this.intervalMs !== undefined) {
      stream = new MjpegStreamer(this.simctl, this.intervalMs).start()
      this.streamMimeType = 'image/png'
    } else {
      stream = new ScreenCaptureStreamer(this.fps, this.bootedDeviceId ?? 'booted').start()
      this.streamMimeType = 'image/jpeg'
    }

    const reader = stream.getReader()
    this.streamReader = reader

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'stream:frame',
              payload: value.toString('base64'),
              mimeType: this.streamMimeType,
            }))
          }
        }
      } catch {
        // stream cancelled or connection closed — expected on disconnect
      }
    }

    pump()
  }

  private handleRelayMessage(msg: { type: string; payload?: unknown }): void {
    switch (msg.type) {
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
            // Home uses the legacy IndigoHIDMessageForButton path (code=0)
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
      case 'webrtc:ice': {
        this.webrtc?.addIceCandidate(msg.payload as RTCIceCandidateInit).catch(() => {})
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
