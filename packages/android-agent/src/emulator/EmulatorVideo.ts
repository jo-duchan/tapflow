import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createLogger } from '@tapflowio/agent-core'
import { EmulatorGrpcClient } from './EmulatorGrpcClient.js'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo.js'

const logger = createLogger('android-agent:emulator-video')

// The Swift VT encoder, two levels up in both src/ (tsx) and dist/ (build).
const ENCODER_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'emulator-encoder')

export interface EmulatorVideoInfo {
  width: number
  height: number
}

// The bits of the encoder child process this class touches — narrowed so tests can inject a fake
// without a real subprocess. ChildProcessWithoutNullStreams satisfies it structurally.
export interface EncoderProcess {
  readonly stdin: { write(chunk: Buffer): boolean; end(): void; destroyed: boolean; on(event: 'error', cb: (e: Error) => void): void }
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void; removeAllListeners(event: 'data'): void }
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  on(event: 'exit', cb: (code: number | null) => void): this
  on(event: 'error', cb: (e: Error) => void): this
  kill(): void
}

export interface EmulatorVideoOptions {
  fps?: number
  /** Server-side resize box (px). The emulator scales to fit, keeping aspect — doubles as the
   *  W3 downscale and trims pipe bytes. Both dims are required for the emulator to resize. */
  maxWidth?: number
  maxHeight?: number
  /** Injectable for tests; defaults to spawning the real Swift VT encoder binary. */
  spawnEncoder?: (fps: number) => EncoderProcess
}

/**
 * The emulator video backend: captures raw RGBA via the emulator's gRPC `streamScreenshot`
 * (bypassing the guest SW encoder), pipes it to the host-side Swift VideoToolbox encoder, and
 * emits the same `{payload, keyframe}` H.264 frames as `ScrcpyVideo` so the agent pump is
 * backend-agnostic. Input is handled separately via `EmulatorGrpcClient`.
 */
export class EmulatorVideo {
  private encoder: EncoderProcess | null = null
  private capture: { frames: AsyncIterable<{ image: Buffer; width: number; height: number; seq: number }>; cancel: () => void } | null = null
  private controller: ReadableStreamDefaultController<ScrcpyFrame> | null = null
  private readonly buffered: ScrcpyFrame[] = []
  private stdoutBuf = Buffer.alloc(0)
  private width = 0
  private height = 0
  private stopped = false
  private outputClosed = false

  constructor(private readonly client: EmulatorGrpcClient, private readonly options: EmulatorVideoOptions = {}) {}

  /** Spawns the encoder and starts capture; resolves once the first frame fixes the dimensions. */
  async start(): Promise<EmulatorVideoInfo> {
    const fps = this.options.fps ?? 30
    const spawnEncoder = this.options.spawnEncoder ?? ((f: number) => spawn(ENCODER_BIN, [String(f)]))
    this.encoder = spawnEncoder(fps)
    this.encoder.stderr.on('data', (d: Buffer) => logger.info(`encoder: ${d.toString().trim()}`))
    this.encoder.stdout.on('data', (chunk: Buffer) => this.onEncoderOutput(chunk))
    this.encoder.on('exit', (code) => { if (!this.stopped) logger.warn(`encoder exited (${code})`) })
    // Writes racing teardown (the encoder is killed while the pump still has a frame) surface as
    // EPIPE on stdin; without a handler that's an uncaught error that crashes the agent.
    this.encoder.stdin.on('error', (e) => { if (!this.stopped) logger.warn(`encoder stdin: ${e.message}`) })
    this.encoder.on('error', (e) => { if (!this.stopped) logger.warn(`encoder process: ${e.message}`) })

    this.capture = this.client.streamScreenshot({ width: this.options.maxWidth ?? 0, height: this.options.maxHeight ?? 0 })

    // Pump raw frames into the encoder; the first one fixes the reported size. Rejects if the
    // capture errors before any frame (e.g. auth failure) so the caller can fall back to scrcpy.
    return new Promise<EmulatorVideoInfo>((resolve, reject) => {
      void this.pump(resolve, reject)
    })
  }

  private async pump(
    onFirst: (info: EmulatorVideoInfo) => void,
    onError: (e: Error) => void,
  ): Promise<void> {
    // Cap to target fps: the source streams up to 60fps under motion, but LAN-HTTP (WASM decode)
    // wants iOS-parity 30fps to halve decode/transport/bandwidth. The first frame (IDR) always
    // goes through; -2ms tolerates source jitter so 60→30 doesn't accidentally drop to 20.
    const minIntervalMs = 1000 / (this.options.fps ?? 30) - 2
    let lastFwdMs = 0
    let first = true
    let captureError: Error | undefined
    try {
      for await (const f of this.capture!.frames) {
        if (this.stopped) break
        if (f.width !== this.width || f.height !== this.height) {
          this.width = f.width
          this.height = f.height
          logger.info(`video size → ${f.width}×${f.height}`)
        }
        const now = performance.now()
        if (!first && now - lastFwdMs < minIntervalMs) continue
        lastFwdMs = now
        if (first) { first = false; onFirst({ width: f.width, height: f.height }) }
        this.writeToEncoder(f.image, f.width, f.height)
      }
    } catch (e) {
      captureError = e as Error
      if (!this.stopped) {
        logger.warn(`capture ended: ${captureError.message}`)
        // The emulator's default gRPC port requires a token; only an agent-launched `-grpc <port>`
        // endpoint is unsecured. A reused, externally-booted emulator (or one missing -grpc) hits this.
        if (captureError.message.includes('UNAUTHENTICATED')) {
          logger.error('emulator gRPC requires auth — relaunch it via the agent so it gets `-grpc <port>` (unsecured localhost), or shut down the externally-booted emulator first.')
        }
      }
    }
    // Settle start()'s promise: reject on a pre-first-frame error (→ scrcpy fallback), else resolve
    // (a clean early end, e.g. stopped during boot, reports the last-known dims).
    if (first) {
      if (captureError) onError(captureError)
      else onFirst({ width: this.width, height: this.height })
    }
    // Source ended (cancelled / emulator gone) — settle the output stream.
    this.closeOutput()
  }

  // Settle the output stream once. Set the flag *before* closing so a late encoder stdout chunk
  // (the encoder process flushes asynchronously) is dropped by emit() instead of enqueuing onto a
  // closed controller (which throws ERR_INVALID_STATE and would crash the agent).
  private closeOutput(): void {
    if (this.outputClosed) return
    this.outputClosed = true
    try { this.controller?.close() } catch { /* already closed */ }
  }

  private writeToEncoder(rgba: Buffer, w: number, h: number): void {
    if (this.stopped) return
    const stdin = this.encoder?.stdin
    if (!stdin || stdin.destroyed) return
    const hdr = Buffer.allocUnsafe(13)
    hdr[0] = 0x00
    hdr.writeUInt32BE(w, 1); hdr.writeUInt32BE(h, 5); hdr.writeUInt32BE(rgba.length, 9)
    stdin.write(hdr)
    stdin.write(rgba)
  }

  // Length-delimited Annex B from the encoder: [len:u32][flags:u8][payload]; flags bit0 = keyframe.
  private onEncoderOutput(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk])
    while (this.stdoutBuf.length >= 4) {
      const len = this.stdoutBuf.readUInt32BE(0)
      if (this.stdoutBuf.length < 4 + len) break
      const flags = this.stdoutBuf[4]!
      const payload = Buffer.from(this.stdoutBuf.subarray(5, 4 + len))
      this.stdoutBuf = this.stdoutBuf.subarray(4 + len)
      this.emit({ payload, keyframe: (flags & 1) === 1 })
    }
  }

  private emit(frame: ScrcpyFrame): void {
    if (this.outputClosed) return
    if (this.controller) {
      try { this.controller.enqueue(frame) } catch { this.outputClosed = true }
    } else {
      this.buffered.push(frame)
    }
  }

  /** H.264 access units, contract-compatible with `ScrcpyVideo.start()`. */
  frames(): ReadableStream<ScrcpyFrame> {
    return new ReadableStream<ScrcpyFrame>({
      start: (controller) => {
        this.controller = controller
        for (const f of this.buffered) controller.enqueue(f)
        this.buffered.length = 0
      },
      cancel: () => this.stop(),
    })
  }

  /** Relay drop-to-keyframe / join recovery: force the encoder to re-emit an IDR. */
  requestIdr(): void {
    if (this.stopped) return
    const stdin = this.encoder?.stdin
    if (stdin && !stdin.destroyed) stdin.write(Buffer.from([0x01]))
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.closeOutput()
    this.capture?.cancel()
    if (this.encoder) {
      // Drop late stdout so it can't enqueue after teardown.
      this.encoder.stdout.removeAllListeners('data')
      this.encoder.stdin.end()
      this.encoder.kill()
      this.encoder = null
    }
  }
}
