import { WebSocket } from 'ws'
import type { Device, DeviceAgent, Point } from '@tapflow/agent-core'
import { SimctlWrapper } from './SimctlWrapper'
import { MjpegStreamer } from './MjpegStreamer'
import { WdaClient } from './WdaClient'

export interface IOSAgentOptions {
  intervalMs?: number
  wdaUrl?: string
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly streamer: MjpegStreamer
  private readonly wda: WdaClient
  private ws: WebSocket | null = null
  private _sessionId: string | null = null
  private streamReader: ReadableStreamDefaultReader<Buffer> | null = null

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper, wda?: WdaClient) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.streamer = new MjpegStreamer(this.simctl, options.intervalMs)
    this.wda = wda ?? new WdaClient(options.wdaUrl)
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  async connect(relayUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', async () => {
        const devices = await this.simctl.listDevices()
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
          this.startStreaming()
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

  private startStreaming(): void {
    const stream = this.streamer.start()
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

  // DeviceAgent interface — delegate to SimctlWrapper
  listDevices(): Promise<Device[]> { return this.simctl.listDevices() }
  boot(deviceId: string): Promise<void> { return this.simctl.boot(deviceId) }
  shutdown(deviceId: string): Promise<void> { return this.simctl.shutdown(deviceId) }
  installApp(path: string): Promise<void> { return this.simctl.installApp(path) }
  launchApp(bundleId: string): Promise<void> { return this.simctl.launchApp(bundleId) }
  screenshot(): Promise<Buffer> { return this.simctl.screenshot() }
  stream(): ReadableStream { return this.streamer.start() }

  tap(x: number, y: number): Promise<void> { return this.wda.tap(x, y) }
  swipe(from: Point, to: Point): Promise<void> { return this.wda.swipe(from, to) }
  type(text: string): Promise<void> { return this.wda.type(text) }
}
