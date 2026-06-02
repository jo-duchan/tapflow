import { spawn, execFileSync } from 'child_process'
import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createLogger, PlatformError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:screencapture')

const SWIFT_SRC = join(import.meta.dirname, '..', 'src', 'screencapture-helper.swift')
const BINARY = join(import.meta.dirname, '..', 'bin', 'screencapture-helper')

function ensureCompiled(): void {
  if (existsSync(BINARY)) {
    // Swift source is not included in the published package — skip recompilation check
    if (!existsSync(SWIFT_SRC)) return
    const srcMtime = statSync(SWIFT_SRC).mtimeMs
    const binMtime = statSync(BINARY).mtimeMs
    if (binMtime >= srcMtime) return
    logger.info('Swift source changed, recompiling...')
    unlinkSync(BINARY)
  }
  if (!existsSync(SWIFT_SRC)) {
    throw new PlatformError('screencapture-helper binary missing and Swift source not found — reinstall @tapflowio/ios-agent')
  }
  logger.info('compiling screencapture-helper...')
  execFileSync('swiftc', [
    SWIFT_SRC,
    '-o', BINARY,
    '-framework', 'CoreVideo',
    '-framework', 'ImageIO',
    '-framework', 'VideoToolbox',
    '-framework', 'CoreMedia',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  logger.info('compiled OK')
}

export interface StreamFrame {
  payload: Buffer
  /** H.264 IDR (keyframe). Always false for JPEG. */
  keyframe: boolean
}

// Parses length-prefixed frames from a rolling buffer.
//   JPEG : [4-byte len][payload]
//   H.264: [4-byte len][flags:u8][payload]   (flags bit0 = keyframe; len counts the flags byte)
// Returns the parsed frames and the unconsumed remainder.
export function parseStreamFrames(
  buf: Buffer,
  h264: boolean,
): { frames: StreamFrame[]; rest: Buffer } {
  const frames: StreamFrame[] = []
  while (buf.length >= 4) {
    const frameLen = buf.readUInt32BE(0)
    if (buf.length < 4 + frameLen) break
    if (h264) {
      const flags = buf[4]
      frames.push({ payload: buf.subarray(5, 4 + frameLen), keyframe: (flags & 0x01) !== 0 })
    } else {
      frames.push({ payload: buf.subarray(4, 4 + frameLen), keyframe: false })
    }
    buf = buf.subarray(4 + frameLen)
  }
  return { frames, rest: buf }
}

export class ScreenCaptureStreamer {
  constructor(
    private readonly fps: number = 30,
    private readonly udid: string = 'booted',
    private readonly codec: 'jpeg' | 'h264' = 'jpeg',
  ) {}

  start(): ReadableStream<StreamFrame> {
    ensureCompiled()

    const proc = spawn(BINARY, [String(this.fps), this.udid, this.codec], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stderr.on('data', (d: Buffer) => process.stderr.write(d))

    // done is hoisted so both start() and cancel() share the same flag
    let done = false
    const h264 = this.codec === 'h264'

    return new ReadableStream<StreamFrame>({
      start(controller) {
        let buf: Buffer = Buffer.alloc(0)

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
          const { frames, rest } = parseStreamFrames(buf, h264)
          for (const f of frames) controller.enqueue(f)
          buf = rest
        })

        proc.stdout.on('end', close)
        proc.on('error', error)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            error(new PlatformError(`[ScreenCaptureStreamer] exited with code ${code}`))
          } else {
            close()
          }
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
