import { WebSocket } from 'ws'
import type { Device, DeviceAgent, Point } from '@tapflow/agent-core'
import { SimctlWrapper } from './SimctlWrapper'
import { MjpegStreamer } from './MjpegStreamer'

export interface IOSAgentOptions {
  intervalMs?: number
}

export class IOSAgent implements DeviceAgent {
  private readonly simctl: SimctlWrapper
  private readonly streamer: MjpegStreamer
  private ws: WebSocket | null = null
  private _sessionId: string | null = null
  private streamReader: ReadableStreamDefaultReader<Buffer> | null = null

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper) {
    this.simctl = simctl ?? new SimctlWrapper()
    this.streamer = new MjpegStreamer(this.simctl, options.intervalMs)
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  async connect(relayUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'agent:register' }))
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

  // WDA stubs — implemented in Phase 2
  async tap(_x: number, _y: number): Promise<void> {}
  async swipe(_from: Point, _to: Point): Promise<void> {}
  async type(_text: string): Promise<void> {}
}
