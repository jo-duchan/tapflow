import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioFrame } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:audio')

const HELPER_SRC = join(import.meta.dirname, '..', 'src', 'audiotap-helper.swift')
const HELPER_APP = join(import.meta.dirname, '..', 'bin', 'audiotap-helper.app')
const HELPER_BIN = join(HELPER_APP, 'Contents', 'MacOS', 'audiotap-helper')

// LSUIElement → no Dock icon (background agent). NSAudioCaptureUsageDescription → the one-time TCC
// "audio recording" prompt. LSMinimumSystemVersion 14.2 → Core Audio process taps.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>audiotap-helper</string>
  <key>CFBundleIdentifier</key><string>io.tapflow.audiotap-helper</string>
  <key>CFBundleName</key><string>audiotap-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>NSAudioCaptureUsageDescription</key><string>tapflow captures the simulator's audio to stream it to the browser.</string>
  <key>NSMicrophoneUsageDescription</key><string>tapflow captures the simulator's audio to stream it to the browser.</string>
</dict></plist>
`
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`

/**
 * Build (mtime-gated) the audiotap-helper as a signed `.app` and return its path.
 *
 * WHY a `.app`, not a bare binary like the other helpers: a Core Audio process tap returns silence
 * unless the *responsible process* holds the audio-recording TCC grant. A CLI child the agent spawns
 * inherits the agent's (ungranted) responsibility. Launched via `open` (LaunchServices), the helper
 * is its own responsible process with its own one-time grant — so it must be a bundle. Steady state
 * (unchanged source) skips the rebuild/re-sign, so the grant persists (TCC keys on the cdhash).
 */
export function ensureHelperApp(): string {
  if (existsSync(HELPER_BIN)) {
    if (!existsSync(HELPER_SRC)) return HELPER_APP // source not shipped — trust the prebuilt bundle
    if (statSync(HELPER_BIN).mtimeMs >= statSync(HELPER_SRC).mtimeMs) return HELPER_APP
    logger.info('audiotap-helper source changed, rebuilding...')
  }
  if (!existsSync(HELPER_SRC)) {
    throw new PlatformError('audiotap-helper.app missing and source not found — reinstall @tapflowio/ios-agent')
  }
  logger.info('building audiotap-helper.app...')
  mkdirSync(join(HELPER_APP, 'Contents', 'MacOS'), { recursive: true })
  execFileSync('swiftc', [
    HELPER_SRC, '-o', HELPER_BIN, '-framework', 'CoreAudio', '-framework', 'AudioToolbox',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  writeFileSync(join(HELPER_APP, 'Contents', 'Info.plist'), INFO_PLIST)
  const entPath = join(import.meta.dirname, '..', 'bin', '.audiotap.entitlements')
  writeFileSync(entPath, ENTITLEMENTS)
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entPath, HELPER_APP],
    { stdio: ['ignore', 'ignore', 'inherit'] })
  logger.info('built audiotap-helper.app')
  return HELPER_APP
}

/**
 * Launch the helper bundle via LaunchServices, pointed at the agent's loopback port and the simulator
 * process PID(s) to tap. `-g` keeps it backgrounded (no focus steal). LaunchServices makes it its own
 * TCC-responsible process; it connects back to `port` and streams PCM.
 */
export function launchAudioHelper(appPath: string, port: number, pids: number[]): void {
  execFileSync('open', ['-g', '-a', appPath, '--args', String(port), ...pids.map(String)],
    { stdio: ['ignore', 'ignore', 'ignore'] })
}

// Wire format from the audiotap-helper: length-prefixed PCM frames — [u32 BE len][PCM bytes], where
// PCM is normalized S16LE / 44100 / Stereo. Mirrors the video helper's length-prefix framing
// (parseStreamFrames); the source is a localhost TCP socket the helper connects to.
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
 * Per-session loopback server the audiotap-helper connects back to. The helper process-taps the
 * simulator app's audio on the host (no device routing, no injection) and streams length-prefixed
 * frames here.
 *
 * Transport is 127.0.0.1 TCP: the OS assigns an ephemeral port (per-session isolation) which we hand
 * to the helper as a launch arg. The helper reconnects per launch; the server outlives reconnects.
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
