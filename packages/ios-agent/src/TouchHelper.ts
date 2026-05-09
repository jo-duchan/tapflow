import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'

// Binary lives in src/, not dist/ — same convention as ScreenCaptureStreamer
const BINARY = join(__dirname, '..', 'src', 'touch-helper')

export class TouchHelper {
  private proc: ChildProcess | null = null
  private lastX = 0
  private lastY = 0

  constructor(private readonly udid: string) {}

  start(): void {
    const bin = BINARY
    this.proc = spawn(bin, [this.udid], { stdio: ['pipe', 'ignore', 'pipe'] })
    this.proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      // print all lines, even debug: lines, until we're confident it's working
      console.error('[touch-helper]', msg)
    })
    this.proc.on('exit', (code) => {
      console.error('[touch-helper] exited with code', code ?? 'null')
    })
    this.proc.on('error', (e) => {
      console.error('[touch-helper] spawn error:', e.message)
    })
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  touchStart(x: number, y: number): void {
    this.lastX = x
    this.lastY = y
    this.write(1, x, y)
  }

  touchMove(x: number, y: number): void {
    this.lastX = x
    this.lastY = y
    this.write(2, x, y)
  }

  touchEnd(): void {
    this.write(3, this.lastX, this.lastY)
  }

  pressButton(usagePage: number, usage: number): void {
    if (!this.proc?.stdin?.writable) return
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(4, 0)
    buf.writeUInt32BE(usagePage, 1)
    buf.writeUInt32BE(usage, 5)
    this.proc.stdin.write(buf)
  }

  private write(type: number, x: number, y: number): void {
    if (!this.proc?.stdin?.writable) return
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(type, 0)
    buf.writeFloatBE(x, 1)
    buf.writeFloatBE(y, 5)
    this.proc.stdin.write(buf)
  }
}
