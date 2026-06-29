import net from 'node:net'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { AudioFrame } from '@tapflowio/agent-core'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:audio')

// The shared macOS process-tap helper (build/launch/permission) lives in @tapflowio/audiotap-helper.
// This file is the iOS-only capture/stream side: it reads the helper's PCM off a loopback socket,
// reflects the simulator volume, and exposes the frame stream.

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
    // Drop a stale helper's socket so two overlapping instances can't interleave frames into buf.
    if (this.activeSock && this.activeSock !== sock) this.activeSock.destroy()
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
    try { this.controller?.close() } catch { /* already closed/errored — fine */ } // end the frame stream so pumpAudio's reader unblocks
    this.controller = null
    this.pendingPids = null
    if (this.activeSock) { this.activeSock.destroy(); this.activeSock = null }
    if (this.server) { this.server.close(); this.server = null; logger.debug('audio capture server closed') }
  }
}
