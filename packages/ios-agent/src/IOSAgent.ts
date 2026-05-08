import { WebSocket } from 'ws'
import type { Device, DeviceAgent, Point } from '@tapflow/agent-core'
import { SimctlWrapper } from './SimctlWrapper'
import { ScreenCaptureStreamer } from './ScreenCaptureStreamer'
import { WdaClient } from './WdaClient'
import { DeviceChromeLoader, type ChromeData } from './DeviceChromeLoader'
import type { ChromeGeometry } from './ScreenCaptureStreamer'

export interface IOSAgentOptions {
  fps?: number
  wdaUrl?: string
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly wda: WdaClient
  private readonly fps: number
  private readonly chromeLoader: DeviceChromeLoader
  private loadedChrome: ChromeData | null = null
  private ws: WebSocket | null = null
  private _sessionId: string | null = null
  private streamReader: ReadableStreamDefaultReader<Buffer> | null = null

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper, wda?: WdaClient) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.fps = options.fps ?? 30
    this.wda = wda ?? new WdaClient(options.wdaUrl)
    this.chromeLoader = new DeviceChromeLoader()
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  async connect(relayUrl: string): Promise<void> {
    const devices = await this.simctl.listDevices()
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
          this.startStreaming()
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
    this.ws?.close()
    this.ws = null
    this._sessionId = null
  }

  private sendChromeData(devices: Device[]): void {
    const booted = devices.find((d) => d.status === 'booted')
    if (!booted || !this.ws) return
    this.loadedChrome = this.chromeLoader.load(booted.name)
    if (!this.loadedChrome) return
    this.ws.send(JSON.stringify({ type: 'session:chrome', payload: this.loadedChrome }))
  }

  private chromeToGeometry(chrome: ChromeData): ChromeGeometry {
    // chromeData dimensions are at 2x (rasterized from PDF); divide by 2 for PDF points
    const scale = 2
    return {
      compositeWidth:  chrome.bezelWidth  / scale,
      compositeHeight: chrome.bezelHeight / scale,
      screenX:         chrome.screenRect.x      / scale,
      screenY:         chrome.screenRect.y      / scale,
      screenWidth:     chrome.screenRect.width  / scale,
      screenHeight:    chrome.screenRect.height / scale,
    }
  }

  private async startStreaming(): Promise<void> {
    let geometry: ChromeGeometry
    if (this.loadedChrome) {
      geometry = this.chromeToGeometry(this.loadedChrome)
    } else {
      // fallback: derive composite geometry from WDA screen size (assumes symmetric 21pt bezel)
      const screen = await this.wda.getWindowSize().catch(() => ({ width: 393, height: 852 }))
      const bezel = 21
      geometry = {
        compositeWidth:  screen.width  + bezel * 2,
        compositeHeight: screen.height + bezel * 2,
        screenX: bezel, screenY: bezel,
        screenWidth: screen.width, screenHeight: screen.height,
      }
    }
    const streamer = new ScreenCaptureStreamer(this.fps, geometry)
    const stream = streamer.start()
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
      case 'input:tap': {
        const { x, y } = msg.payload as { x: number; y: number }
        this.wda.getWindowSize()
          .then((size) => this.wda.tap(Math.round(x * size.width), Math.round(y * size.height)))
          .catch((e) => console.error('[agent] tap failed:', e))
        break
      }
      case 'input:swipe': {
        const { from, to } = msg.payload as { from: { x: number; y: number }; to: { x: number; y: number } }
        this.wda.getWindowSize()
          .then((size) => this.wda.swipe(
            { x: Math.round(from.x * size.width), y: Math.round(from.y * size.height) },
            { x: Math.round(to.x * size.width), y: Math.round(to.y * size.height) },
          ))
          .catch((e) => console.error('[agent] swipe failed:', e))
        break
      }
      case 'input:type': {
        const { text } = msg.payload as { text: string }
        this.wda.type(text).catch((e) => console.error('[agent] type failed:', e))
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
    if (!this.loadedChrome) throw new Error('chrome data not loaded — call connect() first')
    return new ScreenCaptureStreamer(this.fps, this.chromeToGeometry(this.loadedChrome)).start()
  }

  tap(x: number, y: number): Promise<void> { return this.wda.tap(x, y) }
  swipe(from: Point, to: Point): Promise<void> { return this.wda.swipe(from, to) }
  type(text: string): Promise<void> { return this.wda.type(text) }
}
