import { spawn, execFileSync } from 'child_process'
import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const SRC_DIR = join(__dirname, '..', 'src')
const SWIFT_SRC = join(SRC_DIR, 'screencapture-helper.swift')
const BINARY = join(SRC_DIR, 'screencapture-helper')

function ensureCompiled(): void {
  if (existsSync(BINARY)) {
    const srcMtime = statSync(SWIFT_SRC).mtimeMs
    const binMtime = statSync(BINARY).mtimeMs
    if (binMtime >= srcMtime) return
    console.error('[ScreenCaptureStreamer] Swift source changed, recompiling...')
    unlinkSync(BINARY)
  }
  console.error('[ScreenCaptureStreamer] compiling screencapture-helper...')
  execFileSync('swiftc', [
    SWIFT_SRC,
    '-o', BINARY,
    '-framework', 'CoreVideo',
    '-framework', 'ImageIO',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.error('[ScreenCaptureStreamer] compiled OK')
}

export class ScreenCaptureStreamer {
  constructor(
    private readonly fps: number = 30,
    private readonly udid: string = 'booted',
  ) {}

  start(): ReadableStream<Buffer> {
    ensureCompiled()

    const proc = spawn(BINARY, [String(this.fps), this.udid], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stderr.on('data', (d: Buffer) => process.stderr.write(d))

    return new ReadableStream<Buffer>({
      start(controller) {
        let buf = Buffer.alloc(0)
        let closed = false

        const safeClose = () => {
          if (closed) return
          closed = true
          controller.close()
        }

        const safeError = (e: Error) => {
          if (closed) return
          closed = true
          controller.error(e)
        }

        proc.stdout.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk])
          while (buf.length >= 4) {
            const frameLen = buf.readUInt32BE(0)
            if (buf.length < 4 + frameLen) break
            controller.enqueue(buf.subarray(4, 4 + frameLen))
            buf = buf.subarray(4 + frameLen)
          }
        })

        proc.stdout.on('end', safeClose)
        proc.on('error', safeError)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0)
            safeError(new Error(`[ScreenCaptureStreamer] exited with code ${code}`))
        })
      },
      cancel() {
        proc.kill()
      },
    })
  }
}
