import { credentials, loadPackageDefinition, type ClientReadableStream, type ClientWritableStream } from '@grpc/grpc-js'
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
// A raw evdev event, delivered to the guest kernel as sent (`EmulatorController.streamInputEvent`).
interface AndroidEventMsg { type: number; code: number; value: number; display: number }
interface InputEventMsg { android_event: AndroidEventMsg }
interface CallOptions { deadline: number }
interface ClipDataMsg { text: string }

// Clipboard calls run inside a per-device critical section on the agent: one that never
// settles would wedge every later copy/paste on that device, so they all carry a deadline.
// (The video/audio streams deliberately have none — they are long-lived by design.)
const CLIPBOARD_DEADLINE_MS = 5_000
// Input carries a deadline for a different reason than clipboard does. gRPC deadlines are real
// cancellation, so an exceeded one means the emulator did not get the input — which makes answering
// failure safe to retry. Kept under the 2s window the MCP client waits before falling back to
// optimistic success, so a dead emulator produces an answer rather than that fallback.
const INPUT_DEADLINE_MS = 1_500
type ClipCb = (err: Error | null, res?: ClipDataMsg) => void
interface DisplayConfigMsg { width: number; height: number; display: number }
interface DisplayConfigsMsg { displays: DisplayConfigMsg[] }
type DisplayCb = (err: Error | null, res?: DisplayConfigsMsg) => void

/** The subset of the generated EmulatorController stub we use. Injectable for tests. */
export interface RawEmulatorController {
  streamScreenshot(format: ImageFormatMsg): ClientReadableStream<ImageMsg>
  streamAudio(format: AudioFormatMsg): ClientReadableStream<AudioPacketMsg>
  sendTouch(event: TouchEventMsg, options: CallOptions, cb: UnaryCb): void
  streamInputEvent(options: CallOptions, cb: UnaryCb): ClientWritableStream<InputEventMsg>
  getDisplayConfigurations(empty: Record<string, never>, options: CallOptions, cb: DisplayCb): void
  sendKey(event: KeyboardEventMsg, options: CallOptions, cb: UnaryCb): void
  sendMouse(event: MouseEventMsg, cb: UnaryCb): void
  sendWheel(event: WheelEventMsg, cb: UnaryCb): void
  getClipboard(empty: Record<string, never>, options: CallOptions, cb: ClipCb): void
  setClipboard(clip: ClipDataMsg, options: CallOptions, cb: UnaryCb): void
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

// linux/input-event-codes.h — the events a cancel sends (`touchCancel`).
const EV_SYN = 0, SYN_REPORT = 0, EV_ABS = 3, ABS_MT_SLOT = 0x2f, ABS_MT_TOOL_TYPE = 0x37
const MT_TOOL_FINGER = 0, MT_TOOL_PALM = 2

/**
 * Thin gRPC wrapper over the Android emulator's EmulatorController — host-side video capture
 * (`streamScreenshot`, bypassing the guest SW H.264 encoder) plus input injection
 * (`sendTouch/sendKey/sendMouse/sendWheel`), so the emulator path needs no scrcpy. Connects to
 * the unprotected localhost gRPC port the agent launches the emulator with (`-grpc <port>`).
 */
export class EmulatorGrpcClient {
  private readonly raw: RawEmulatorController
  private closed = false
  // Every touch call waits for the one before it to settle. Each `sendTouch` is its own unary call, and the
  // emulator does not take concurrent calls in the order they were sent: measured on Android 14, a tap's up
  // overtook its down while the emulator was busy right after an install — the kernel dropped the up (the
  // touch was already up), then applied the down, and the touch stayed pressed until the next one. iOS
  // writes its frames down one pipe and cannot reorder; this is that, for gRPC.
  private touchQueue: Promise<void> = Promise.resolve()
  // A cancel marks its slot a palm and puts it back to a finger after (`touchCancel`). The emulator's own touches
  // never set the tool type, so a slot left a palm would cancel every later touch on it while each was acked
  // delivered. A slot whose put-back failed is kept here, and the next press on it puts it back first — checked
  // inside the press's queued step, so a press queued behind the cancel sees the cancel's outcome.
  private readonly palmSlots = new Set<number>()

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

  /**
   * Display 0's size **as the emulator has it configured** — which is not always the panel the
   * guest is currently drawing on.
   *
   * This is the divisor for input, and that is the only reason it exists. `sendTouch` takes
   * pixels and the emulator converts them to its touch device's normalized range, so the number
   * it divides by is its own, not the guest's. They agree on a phone and on an unfolded foldable
   * (where the panel *is* `hw.lcd`), and disagree the moment the device folds: measured on a
   * Pixel 9 Pro Fold, folded reports `1080x2424` to `dumpsys` while this stays `2076x2152`, so
   * every tap went 1.92x too far across and 0.89x too far down.
   *
   * Asking the emulator rather than deriving it is the point. The guest's own numbers are what
   * misled two earlier attempts, and the device's `getevent` range is a normalized `32768x32768`
   * that is not a pixel reference at all.
   */
  getDisplaySize(): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      this.raw.getDisplayConfigurations({}, { deadline: Date.now() + INPUT_DEADLINE_MS }, (err, res) => {
        if (err) return resolve(null)
        const d = res?.displays?.find((x) => Number(x.display ?? 0) === 0) ?? res?.displays?.[0]
        const width = Number(d?.width ?? 0)
        const height = Number(d?.height ?? 0)
        // A zero would divide every coordinate to the top-left corner, which is worse than the
        // panel size this falls back to.
        resolve(width > 0 && height > 0 ? { width, height } : null)
      })
    })
  }

  // --- input (coords are display-resolution px, top-left origin; pressure 0 = up) ---

  private touch(touches: TouchMsg[], display = 0): Promise<void> {
    return this.enqueue(() => this.sendTouch(touches, display))
  }

  // The deadline starts when the call is sent, not when it was queued. A failed call still lets the next one
  // go — the queue only ever holds settled-and-swallowed promises — because holding an up back behind a
  // failed down would leave the touch pressed, the defect this queue fixes. So the order holds for calls the
  // emulator answered; one our deadline abandoned may still be applied after the next (AGENTS.md).
  private enqueue(step: () => Promise<void>): Promise<void> {
    const call = this.touchQueue.then(step)
    this.touchQueue = call.catch(() => {})
    return call
  }

  private sendTouch(touches: TouchMsg[], display = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.sendTouch(
        { touches, display },
        { deadline: Date.now() + INPUT_DEADLINE_MS },
        (err) => (err ? reject(err) : resolve()),
      )
    })
  }

  /** Raw evdev events, settled when the emulator answers the stream — so the queue's order holds for them too. */
  private sendEvents(events: Array<[type: number, code: number, value: number]>): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = this.raw.streamInputEvent({ deadline: Date.now() + INPUT_DEADLINE_MS }, (err) => (err ? reject(err) : resolve()))
      for (const [type, code, value] of events) stream.write({ android_event: { type, code, value, display: 0 } })
      stream.end()
    })
  }

  private toolType(slot: number, tool: number): Promise<void> {
    return this.sendEvents([[EV_ABS, ABS_MT_SLOT, slot], [EV_ABS, ABS_MT_TOOL_TYPE, tool], [EV_SYN, SYN_REPORT, 0]])
  }

  private async restoreFingers(slots: number[]): Promise<void> {
    for (const slot of slots) {
      if (!this.palmSlots.has(slot)) continue
      await this.toolType(slot, MT_TOOL_FINGER).then(() => { this.palmSlots.delete(slot) }, () => {})
    }
  }

  touchDown(pointerId: number, x: number, y: number): Promise<void> {
    return this.enqueue(async () => {
      await this.restoreFingers([pointerId])
      await this.sendTouch([{ x, y, identifier: pointerId, pressure: 1 }])
    })
  }

  /**
   * Lift the touch as cancelled (#1115): its slot is marked a palm, which Android's input reader turns into
   * `ACTION_CANCEL` (Android 11 and later), then released and put back to a finger — one unit on the touch queue, so
   * nothing slips between. The emulator's touch API has no cancel of its own. Measured on a Pixel 6 (Android 14): a
   * hold cancelled this way fires no tap and no long press, and the next tap is a tap. **The release goes out whether
   * or not the palm did**, so a touch is never left down; where the palm is not understood, that release is an up, as
   * an end would be. The slot is the pointer id, which holds while only the session's holder touches the device.
   */
  touchCancel(pointerId: number, x = 0, y = 0): Promise<void> {
    return this.enqueue(async () => {
      const palmed = await this.toolType(pointerId, MT_TOOL_PALM).then(() => true, () => false)
      try {
        await this.sendTouch([{ x, y, identifier: pointerId, pressure: 0 }])
      } finally {
        // Only a slot the palm reached needs putting back. One whose palm was refused (an emulator without
        // `streamInputEvent`) was never changed, and marking it would cost every later press a call that fails.
        if (palmed) await this.toolType(pointerId, MT_TOOL_FINGER).then(() => { this.palmSlots.delete(pointerId) }, () => { this.palmSlots.add(pointerId) })
      }
    })
  }

  touchMove(pointerId: number, x: number, y: number): Promise<void> {
    return this.touch([{ x, y, identifier: pointerId, pressure: 1 }])
  }

  touchUp(pointerId: number, x = 0, y = 0): Promise<void> {
    return this.touch([{ x, y, identifier: pointerId, pressure: 0 }])
  }

  pinchStart(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.enqueue(async () => {
      await this.restoreFingers([0, 1])
      await this.sendTouch([
        { x: x1, y: y1, identifier: 0, pressure: 1 },
        { x: x2, y: y2, identifier: 1, pressure: 1 },
      ])
    })
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
        { deadline: Date.now() + INPUT_DEADLINE_MS },
        (err) => (err ? reject(err) : resolve()),
      )
    })
  }

  sendWheel(dx: number, dy: number, display = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.sendWheel({ dx, dy, display }, (err) => (err ? reject(err) : resolve()))
    })
  }

  // Guest clipboard. The AVD images do not implement `adb shell cmd clipboard`, so this
  // gRPC pair is the only usable channel — and it round-trips UTF-8 (emoji, newlines, tabs)
  // byte-for-byte. `ClipData` carries a single `text` field.
  getClipboard(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.raw.getClipboard({}, { deadline: Date.now() + CLIPBOARD_DEADLINE_MS },
        (err, res) => (err ? reject(err) : resolve(res?.text ?? '')))
    })
  }

  setClipboard(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raw.setClipboard({ text }, { deadline: Date.now() + CLIPBOARD_DEADLINE_MS },
        (err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * Whether a write now has a client to go through. Unlike the scrcpy backend this one also reports
   * failure by rejecting, so this is the cheap synchronous half: it avoids firing an RPC at a
   * client we already closed and then waiting out its rejection.
   */
  isReady(): boolean {
    return !this.closed
  }

  close(): void {
    this.closed = true
    this.raw.close()
  }
}
