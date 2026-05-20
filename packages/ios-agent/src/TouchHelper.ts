import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:touch-helper')

const BINARY = join(import.meta.dirname, '..', 'bin', 'touch-helper')

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
      logger.error(msg)
    })
    this.proc.on('exit', (code) => {
      logger.error(`exited with code ${code ?? 'null'}`)
    })
    this.proc.on('error', (e) => {
      logger.error(`spawn error: ${e.message}`)
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

  // Legacy path for home (code=0) and lock (code=1) buttons
  pressLegacyButton(code: number): void {
    if (!this.proc?.stdin?.writable) return
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(5, 0)
    buf.writeUInt32BE(code, 1)
    buf.writeUInt32BE(0, 5)
    this.proc.stdin.write(buf)
  }

  pinchStart(x1: number, y1: number, x2: number, y2: number): void {
    this.writeTwoFinger(6, x1, y1, x2, y2)
  }

  pinchMove(x1: number, y1: number, x2: number, y2: number): void {
    this.writeTwoFinger(7, x1, y1, x2, y2)
  }

  pinchEnd(): void {
    this.writeTwoFinger(8, 0, 0, 0, 0)
  }

  // HID keyboard — type 9 frame: [9][modifiers][pad x3][usage:u32BE]
  // modifiers: USB HID modifier bitmap (0x01=LeftCtrl, 0x02=LeftShift, 0x04=LeftAlt, 0x08=LeftMeta, …)
  // usage: keyboard usage code from HID Keyboard/Keypad page (0x07)
  sendKey(usage: number, modifiers = 0): void {
    if (!this.proc?.stdin?.writable) return
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(9, 0)
    buf.writeUInt8(modifiers, 1)
    buf.writeUInt8(0, 2)
    buf.writeUInt8(0, 3)
    buf.writeUInt8(0, 4)
    buf.writeUInt32BE(usage, 5)
    this.proc.stdin.write(buf)
  }

  private writeTwoFinger(type: number, x1: number, y1: number, x2: number, y2: number): void {
    if (!this.proc?.stdin?.writable) return
    const buf = Buffer.allocUnsafe(17)
    buf.writeUInt8(type, 0)
    buf.writeFloatBE(x1, 1)
    buf.writeFloatBE(y1, 5)
    buf.writeFloatBE(x2, 9)
    buf.writeFloatBE(y2, 13)
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
