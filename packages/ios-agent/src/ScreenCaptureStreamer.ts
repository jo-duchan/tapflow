import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const SRC_DIR = join(__dirname, '..', 'src')
const SWIFT_SRC = join(SRC_DIR, 'screencapture-helper.swift')
const BINARY = join(SRC_DIR, 'screencapture-helper')

// All values in DeviceKit composite PDF points (1x)
export interface ChromeGeometry {
  compositeWidth: number
  compositeHeight: number
  screenX: number
  screenY: number
  screenWidth: number
  screenHeight: number
}

function ensureCompiled(): void {
  if (existsSync(BINARY)) return
  console.error('[ScreenCaptureStreamer] compiling screencapture-helper...')
  execFileSync('swiftc', [
    SWIFT_SRC,
    '-o', BINARY,
    '-framework', 'ScreenCaptureKit',
    '-framework', 'AppKit',
    '-framework', 'ImageIO',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.error('[ScreenCaptureStreamer] compiled OK')
}

export class ScreenCaptureStreamer {
  constructor(
    private readonly fps: number = 30,
    private readonly geometry: ChromeGeometry,
  ) {}

  start(): ReadableStream<Buffer> {
    ensureCompiled()

    const g = this.geometry
    const args = [
      String(this.fps),
      String(g.compositeWidth), String(g.compositeHeight),
      String(g.screenX), String(g.screenY),
      String(g.screenWidth), String(g.screenHeight),
    ]

    const proc = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stderr.on('data', (d: Buffer) => process.stderr.write(d))

    return new ReadableStream<Buffer>({
      start(controller) {
        let buf = Buffer.alloc(0)

        proc.stdout.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk])

          while (buf.length >= 4) {
            const frameLen = buf.readUInt32BE(0)
            if (buf.length < 4 + frameLen) break
            controller.enqueue(buf.subarray(4, 4 + frameLen))
            buf = buf.subarray(4 + frameLen)
          }
        })

        proc.stdout.on('end', () => controller.close())
        proc.on('error', (e) => controller.error(e))
      },
      cancel() {
        proc.kill()
      },
    })
  }
}
