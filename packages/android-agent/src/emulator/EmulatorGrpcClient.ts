import { credentials, loadPackageDefinition, type ClientReadableStream } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The vendored proto sits two levels up from this file in both src/ (tsx) and dist/ (build),
// since both EmulatorGrpcClient live at <pkg>/{src,dist}/emulator/.
const PROTO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'proto', 'emulator_controller.proto')

// SkinRotation (Image.format.rotation) — what coarse orientation the emulator reports per frame.
export type SkinRotation = 'PORTRAIT' | 'LANDSCAPE' | 'REVERSE_PORTRAIT' | 'REVERSE_LANDSCAPE'

/** One raw RGBA8888 screenshot from the emulator's gRPC stream. Pixels are bottom-up
 *  (proto: "left to right and bottom up") — the encoder flips rows. */
export interface EmulatorFrame {
  image: Buffer
  width: number
  height: number
  rotation: SkinRotation
  seq: number
}

export interface ScreenshotStream {
  frames: AsyncIterable<EmulatorFrame>
  cancel(): void
}

/** One raw-PCM audio packet from the emulator's gRPC stream (S16LE / 44100 / Stereo). */
export interface EmulatorAudioFrame {
  audio: Buffer
  timestamp: number   // epoch microseconds (AudioPacket.timestamp) — for loose A/V sync
}

export interface AudioStream {
  frames: AsyncIterable<EmulatorAudioFrame>
  cancel(): void
}

// --- proto message shapes (only the fields we touch; enums decoded as strings) ---
interface ImageFormatMsg { format: string; width: number; height: number; display: number }
interface ImageMsg {
  image: Buffer
  seq: number
  format: { rotation: { rotation: SkinRotation }; width: number; height: number }
}
// proto-loader is configured with enums:String and longs:String, so enum/uint64 fields
// arrive (and are sent) as strings.
interface AudioFormatMsg { samplingRate: number; channels: string; format: string; mode: string }
interface AudioPacketMsg { format: AudioFormatMsg; timestamp: string; audio: Buffer }
interface TouchMsg { x: number; y: number; identifier: number; pressure: number }
interface TouchEventMsg { touches: TouchMsg[]; display: number }
interface KeyboardEventMsg { codeType: string; eventType: string; keyCode?: number; key?: string; text?: string }
interface MouseEventMsg { x: number; y: number; buttons: number; display: number }
interface WheelEventMsg { dx: number; dy: number; display: number }

type UnaryCb = (err: Error | null) => void

/** The subset of the generated EmulatorController stub we use. Injectable for tests. */
export interface RawEmulatorController {
  streamScreenshot(format: ImageFormatMsg): ClientReadableStream<ImageMsg>
  streamAudio(format: AudioFormatMsg): ClientReadableStream<AudioPacketMsg>
  sendTouch(event: TouchEventMsg, cb: UnaryCb): void
  sendKey(event: KeyboardEventMsg, cb: UnaryCb): void
  sendMouse(event: MouseEventMsg, cb: UnaryCb): void
  sendWheel(event: WheelEventMsg, cb: UnaryCb): void
  close(): void
}

// Loaded once — the package definition is process-wide.
type EmulatorControllerCtor = new (
  addr: string,
  creds: ReturnType<typeof credentials.createInsecure>,
  options: Record<string, unknown>,
) => RawEmulatorController

let ctorCache: EmulatorControllerCtor | null = null
function loadController(): EmulatorControllerCtor {
  if (ctorCache) return ctorCache
  const def = loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true })
  const pkg = loadPackageDefinition(def) as unknown as {
    android: { emulation: { control: { EmulatorController: EmulatorControllerCtor } } }
  }
  ctorCache = pkg.android.emulation.control.EmulatorController
  return ctorCache
}

/**
 * Thin gRPC wrapper over the Android emulator's EmulatorController — host-side video capture
 * (`streamScreenshot`, bypassing the guest SW H.264 encoder) plus input injection
 * (`sendTouch/sendKey/sendMouse/sendWheel`), so the emulator path needs no scrcpy. Connects to
 * the unprotected localhost gRPC port the agent launches the emulator with (`-grpc <port>`).
 */
export class EmulatorGrpcClient {
  private readonly raw: RawEmulatorController

  /** `raw` is injectable so tests can drive it without a live emulator. */
  constructor(addr: string, raw?: RawEmulatorController) {
    this.raw = raw ?? new (loadController())(addr, credentials.createInsecure(), {
      // Native 1080p RGBA frames are ~10MB; the 4MB default would reject them.
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    })
  }

  /** Server-side resize (width/height) doubles as W3 downscale and trims pipe bytes; 0 = native.
   *  Empty frames (display inactive) are skipped — consumers only see real pixels. */
  streamScreenshot(opts: { width?: number; height?: number; display?: number } = {}): ScreenshotStream {
    const call = this.raw.streamScreenshot({
      format: 'RGBA8888',
      width: opts.width ?? 0,
      height: opts.height ?? 0,
      display: opts.display ?? 0,
    })
    async function* mapped(): AsyncGenerator<EmulatorFrame> {
      for await (const msg of call as AsyncIterable<ImageMsg>) {
        if (!msg.image || msg.image.length === 0) continue
        yield {
          image: msg.image,
          width: msg.format.width,
          height: msg.format.height,
          rotation: msg.format.rotation.rotation,
          seq: msg.seq,
        }
      }
    }
    return { frames: mapped(), cancel: () => call.cancel() }
  }

  /** Server-side streaming of raw PCM (S16LE / 44100 / Stereo). MODE_REAL_TIME so the
   *  emulator overwrites stale audio if we fall behind — the freshest packet wins, never
   *  blocking the emulator (matches the drop-old policy; audio must never backpressure video). */
  streamAudio(opts: { samplingRate?: number } = {}): AudioStream {
    const call = this.raw.streamAudio({
      samplingRate: opts.samplingRate ?? 44100,
      channels: 'Stereo',
      format: 'AUD_FMT_S16',
      mode: 'MODE_REAL_TIME',
    })
    async function* mapped(): AsyncGenerator<EmulatorAudioFrame> {
      for await (const msg of call as AsyncIterable<AudioPacketMsg>) {
        if (!msg.audio || msg.audio.length === 0) continue
        yield { audio: msg.audio, timestamp: Number(msg.timestamp) }
      }
    }
    return { frames: mapped(), cancel: () => call.cancel() }
  }

  // --- input (coords are display-resolution px, top-left origin; pressure 0 = up) ---

  private touch(touches: TouchMsg[], display = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.sendTouch({ touches, display }, (err) => (err ? reject(err) : resolve()))
    })
  }

  touchDown(pointerId: number, x: number, y: number): Promise<void> {
    return this.touch([{ x, y, identifier: pointerId, pressure: 1 }])
  }

  touchMove(pointerId: number, x: number, y: number): Promise<void> {
    return this.touch([{ x, y, identifier: pointerId, pressure: 1 }])
  }

  touchUp(pointerId: number, x = 0, y = 0): Promise<void> {
    return this.touch([{ x, y, identifier: pointerId, pressure: 0 }])
  }

  pinchStart(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.touch([
      { x: x1, y: y1, identifier: 0, pressure: 1 },
      { x: x2, y: y2, identifier: 1, pressure: 1 },
    ])
  }

  pinchMove(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.touch([
      { x: x1, y: y1, identifier: 0, pressure: 1 },
      { x: x2, y: y2, identifier: 1, pressure: 1 },
    ])
  }

  pinchEnd(): Promise<void> {
    return this.touch([
      { x: 0, y: 0, identifier: 0, pressure: 0 },
      { x: 0, y: 0, identifier: 1, pressure: 0 },
    ])
  }

  sendKey(event: { keyCode?: number; key?: string; text?: string; codeType?: string; eventType?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.sendKey(
        { codeType: event.codeType ?? 'XKB', eventType: event.eventType ?? 'keypress', ...event },
        (err) => (err ? reject(err) : resolve()),
      )
    })
  }

  sendWheel(dx: number, dy: number, display = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.sendWheel({ dx, dy, display }, (err) => (err ? reject(err) : resolve()))
    })
  }

  close(): void {
    this.raw.close()
  }
}
