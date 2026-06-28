import net from 'node:net'
import os from 'node:os'
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
 * process PID(s) to tap. `-g` keeps it backgrounded (no focus steal). `-n` forces a NEW instance per
 * simulator — without it `open -a` reuses the first sim's running helper, so a second concurrent sim
 * never gets its own tap and its audio silently breaks. LaunchServices makes each its own
 * TCC-responsible process; it connects back to `port` and streams PCM.
 */
export function launchAudioHelper(appPath: string, port: number, pids: number[]): void {
  execFileSync('open', ['-g', '-n', '-a', appPath, '--args', String(port), ...pids.map(String)],
    { stdio: ['ignore', 'ignore', 'ignore'] })
}

// Core Audio process taps need macOS 14.2+ (Darwin 23.2+). os.release() → "<darwinMajor>.<minor>.…".
export function isAudioSupported(): boolean {
  const [maj, min] = os.release().split('.').map(Number)
  return maj > 23 || (maj === 23 && min >= 2)
}

/**
 * Read the simulator's current media volume (`sim_volume`, 0–100) from its audiosettings.plist and
 * return it as a 0–1 gain. The Core Audio process tap captures audio *before* the simulator applies
 * its volume, so the agent multiplies it back in. The plist updates live as the user changes the
 * simulator volume. Returns 1 (full) when unreadable — a volume-read failure must never mute audio.
 */
export function readSimVolume(udid: string): number {
  const plist = join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid,
    'data', 'var', 'run', 'simulatoraudio', 'audiosettings.plist')
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
    const v = (JSON.parse(json) as { sim_volume?: number }).sim_volume
    if (typeof v === 'number' && v >= 0) return Math.min(1, v / 100)
  } catch { /* plist missing / not yet created → full volume */ }
  return 1
}

/**
 * Prime the audio-capture TCC grant up front (from `tapflow setup ios`) so the operator approves it
 * while present — not at first simulator boot, which a headless agent operator would likely miss.
 *
 * Runs the helper's --request-permission mode: a global tap whose *capture start* raises the same
 * audio-capture prompt a per-pid tap needs (the grant keys on the app cdhash + service, not the tap
 * shape), so no port/pid/booted simulator is required. `open -W` blocks until the helper exits, i.e.
 * until the modal is answered. The grant itself isn't readable back, so the caller treats a clean
 * return as "prompt shown / answered" and leaves approve-vs-deny to the operator.
 */
export function requestAudioPermission(): void {
  const app = ensureHelperApp()
  execFileSync('open', ['-W', '-n', '-a', app, '--args', '--request-permission'], { stdio: ['ignore', 'ignore', 'ignore'] })
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

// Apply a 0–1 gain to interleaved S16LE PCM in place. The process tap captures audio before the
// simulator's own volume is applied, so the agent multiplies sim_volume back in. Clamps to S16 range.
export function applyGain(buf: Buffer, gain: number): void {
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = Math.round(buf.readInt16LE(i) * gain)
    buf.writeInt16LE(s > 32767 ? 32767 : s < -32768 ? -32768 : s, i)
  }
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
  private activeSock: net.Socket | null = null
  private pendingPids: number[] | null = null

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
    this.activeSock = sock
    if (this.pendingPids) { this.writePids(sock, this.pendingPids); this.pendingPids = null }
    sock.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
      const { frames, rest } = parseAudioFrames(this.buf)
      this.buf = rest
      // timestamp: stamp on arrival (epoch µs). Loose A/V sync is acceptable for manual QA.
      for (const payload of frames) this.controller?.enqueue({ payload, timestamp: Date.now() * 1000 })
    })
    sock.on('close', () => { if (this.activeSock === sock) this.activeSock = null })
    sock.on('error', () => { /* helper disconnect — expected on app exit/relaunch */ })
  }

  /**
   * Push a new tap set to the running helper over the same loopback socket (the agent→helper
   * direction). Wire: [u32 BE count][pid:u32 BE × count] — mirrors the helper's read loop. The helper
   * tears down the old tap and rebuilds it for these pids, keeping the socket and frame stream alive.
   * If the helper hasn't connected yet, the latest set is buffered and flushed on connect.
   */
  updatePids(pids: number[]): void {
    if (this.activeSock) this.writePids(this.activeSock, pids)
    else this.pendingPids = pids
  }

  private writePids(sock: net.Socket, pids: number[]): void {
    const buf = Buffer.allocUnsafe(4 + pids.length * 4)
    buf.writeUInt32BE(pids.length, 0)
    pids.forEach((p, i) => buf.writeUInt32BE(p >>> 0, 4 + i * 4))
    sock.write(buf)
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
    this.pendingPids = null
    if (this.activeSock) { this.activeSock.destroy(); this.activeSock = null }
    if (this.server) { this.server.close(); this.server = null; logger.debug('audio capture server closed') }
  }
}
