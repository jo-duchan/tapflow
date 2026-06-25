import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioFrame } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:audio')

const TAP_SRC = join(import.meta.dirname, '..', 'src', 'audio-tap.c')
const TAP_DYLIB = join(import.meta.dirname, '..', 'bin', 'audio-tap.dylib')

// Compile the audio-tap dylib on demand (mtime check), mirroring screencapture-helper. Returns the
// dylib path to inject via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES. Built for the iOS simulator (arm64).
export function ensureAudioTapCompiled(): string {
  if (existsSync(TAP_DYLIB)) {
    if (!existsSync(TAP_SRC)) return TAP_DYLIB // source not shipped — trust the prebuilt binary
    if (statSync(TAP_DYLIB).mtimeMs >= statSync(TAP_SRC).mtimeMs) return TAP_DYLIB
    logger.info('audio-tap source changed, recompiling...')
    unlinkSync(TAP_DYLIB)
  }
  if (!existsSync(TAP_SRC)) {
    throw new PlatformError('audio-tap.dylib missing and source not found — reinstall @tapflowio/ios-agent')
  }
  logger.info('compiling audio-tap.dylib...')
  execFileSync('xcrun', [
    '--sdk', 'iphonesimulator', 'clang',
    '-arch', 'arm64', '-mios-simulator-version-min=14.0',
    '-dynamiclib', TAP_SRC, '-framework', 'AudioToolbox',
    '-o', TAP_DYLIB,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  logger.info('compiled OK')
  return TAP_DYLIB
}

// Wire format from the injected audio-tap dylib: length-prefixed PCM frames — [u32 BE len][PCM bytes],
// where PCM is the normalized S16LE / 44100 / Stereo the dylib produces. Mirrors the video helper's
// length-prefix framing (parseStreamFrames); the source is a localhost TCP socket the guest connects to.
export function parseAudioFrames(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0)
    if (buf.length < 4 + len) break
    frames.push(buf.subarray(4, 4 + len))
    buf = buf.subarray(4 + len)
  }
  return { frames, rest: buf }
}

/**
 * Per-session loopback server the injected audio-tap dylib connects back to. The dylib taps the guest
 * app's PCM at the CoreAudio source (no host device, no routing) and streams length-prefixed frames here.
 *
 * Transport is 127.0.0.1 TCP, not a unix socket: a sandboxed simulator app reaches the host's loopback
 * (the standard sim↔host dev path) but not arbitrary host unix-socket paths. The OS assigns an ephemeral
 * port (per-session isolation); we hand it to the dylib via the launch env.
 */
export class AudioCaptureStreamer {
  private server: net.Server | null = null
  private controller: ReadableStreamDefaultController<AudioFrame> | null = null
  private buf: Buffer = Buffer.alloc(0)
  private port = 0

  /** Binds 127.0.0.1:<ephemeral> and resolves the assigned port (pass it to the dylib). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.onConnection(sock))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        this.server = server
        resolve(this.port)
      })
    })
  }

  private onConnection(sock: net.Socket): void {
    this.buf = Buffer.alloc(0) // fresh per connection (the app relaunch reconnects)
    sock.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
      const { frames, rest } = parseAudioFrames(this.buf)
      this.buf = rest
      // timestamp: stamp on arrival (epoch µs). Loose A/V sync is acceptable for manual QA.
      for (const payload of frames) this.controller?.enqueue({ payload, timestamp: Date.now() * 1000 })
    })
    sock.on('error', () => { /* guest dylib disconnect — expected on app exit/relaunch */ })
  }

  /** The frame stream. Call after listen() and before the app connects. */
  frames(): ReadableStream<AudioFrame> {
    return new ReadableStream<AudioFrame>({
      start: (c) => { this.controller = c },
      cancel: () => this.stop(),
    })
  }

  stop(): void {
    this.controller = null
    if (this.server) { this.server.close(); this.server = null; logger.debug('audio capture server closed') }
  }
}
