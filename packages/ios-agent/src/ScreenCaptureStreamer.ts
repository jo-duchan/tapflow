import { spawn, execFileSync } from 'child_process'
import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const SWIFT_SRC = join(import.meta.dirname, '..', 'src', 'screencapture-helper.swift')
const BINARY = join(import.meta.dirname, '..', 'bin', 'screencapture-helper')

function ensureCompiled(): void {
  if (existsSync(BINARY)) {
    // Swift source is not included in the published package — skip recompilation check
    if (!existsSync(SWIFT_SRC)) return
    const srcMtime = statSync(SWIFT_SRC).mtimeMs
    const binMtime = statSync(BINARY).mtimeMs
    if (binMtime >= srcMtime) return
    console.error('[ScreenCaptureStreamer] Swift source changed, recompiling...')
    unlinkSync(BINARY)
  }
  if (!existsSync(SWIFT_SRC)) {
    throw new Error('screencapture-helper binary missing and Swift source not found — reinstall @tapflow/ios-agent')
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

    // done is hoisted so both start() and cancel() share the same flag
    let done = false

    return new ReadableStream<Buffer>({
      start(controller) {
        let buf = Buffer.alloc(0)

        const close = () => {
          if (done) return
          done = true
          controller.close()
        }
        const error = (e: Error) => {
          if (done) return
          done = true
          controller.error(e)
        }

        proc.stdout.on('data', (chunk: Buffer) => {
          if (done) return
          buf = Buffer.concat([buf, chunk])
          while (buf.length >= 4) {
            const frameLen = buf.readUInt32BE(0)
            if (buf.length < 4 + frameLen) break
            controller.enqueue(buf.subarray(4, 4 + frameLen))
            buf = buf.subarray(4 + frameLen)
          }
        })

        proc.stdout.on('end', close)
        proc.on('error', error)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0)
            error(new Error(`[ScreenCaptureStreamer] exited with code ${code}`))
          else
            close()
        })
      },
      cancel() {
        done = true
        proc.kill('SIGTERM')
        const killTimer = setTimeout(() => proc.kill('SIGKILL'), 1000)
        proc.once('exit', () => clearTimeout(killTimer))
      },
    })
  }
}
