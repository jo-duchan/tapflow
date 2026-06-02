import type { Decoder, DecoderSize, DecodeSample } from './types'
import { YUVWebGLRenderer } from '../YUVWebGLRenderer'

/** Minimal renderer seam — satisfied by YUVWebGLRenderer, mockable in tests. */
export interface YUVRenderer {
  init(): boolean
  /** Draws one combined I420 (YUV420 planar) buffer; returns frame size or null. */
  drawI420(data: Uint8Array, width: number, height: number): { width: number; height: number } | null
  dispose(): void
}

interface PictureReadyMsg {
  type: 'pictureReady'
  width: number
  height: number
  data: ArrayBuffer
  renderStateId: number
}
type WorkerMsg = { type: 'decoderReady' } | PictureReadyMsg

// Single logical stream per decoder instance.
const RENDER_STATE_ID = 0

function defaultRenderer(canvas: HTMLCanvasElement): YUVRenderer {
  const r = new YUVWebGLRenderer(canvas)
  r.init()
  return r
}

function defaultWorker(): Worker {
  // new URL(..., import.meta.url) lets Vite bundle the worker as its own chunk
  // (type:'module' so its static `import 'tinyh264'` resolves; see vite.config worker.format).
  return new Worker(new URL('./tinyh264.worker.ts', import.meta.url), { type: 'module' })
}

/**
 * Software H.264 decoder via the tinyh264 (h264bsd) WASM module in a Web Worker.
 *
 * This is the tier-1 decoder for plain-HTTP LAN access: it needs no secure context
 * (unlike WebCodecs) and has no media-element buffer (unlike MSE), so it can reach
 * low latency over non-secure HTTP. The worker emits I420 (YUV420) frames, rendered
 * by YUVWebGLRenderer to this decoder's own <canvas>.
 *
 * tinyh264 accepts a whole Annex B access unit per `decode` call (start codes kept,
 * multiple NALs OK) — we forward each received frame as-is. Profile must be
 * (constrained-)baseline with no B-frames, which matches the iOS VideoToolbox encoder.
 *
 * Owns its render surface so the viewer stays decoder-agnostic.
 */
export class WASMDecoder implements Decoder {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: YUVRenderer
  private readonly worker: Worker
  private ready = false
  // Frames that arrived before the WASM module finished initializing.
  private readonly pending: ArrayBuffer[] = []
  private _size: DecoderSize | null = null
  private resizeCb?: (size: DecoderSize) => void
  private decodedCb?: (presentTime: number, sample?: DecodeSample) => void

  constructor(
    createRenderer: (canvas: HTMLCanvasElement) => YUVRenderer = defaultRenderer,
    createWorker: () => Worker = defaultWorker,
  ) {
    this.canvas = document.createElement('canvas')
    this.renderer = createRenderer(this.canvas)
    this.worker = createWorker()
    this.worker.onmessage = (e: MessageEvent<WorkerMsg>) => this.onMessage(e.data)
  }

  get surface(): HTMLCanvasElement { return this.canvas }
  get size(): DecoderSize | null { return this._size }

  onResize(cb: (size: DecoderSize) => void): void { this.resizeCb = cb }
  onDecodedFrame(cb: (presentTime: number, sample?: DecodeSample) => void): void { this.decodedCb = cb }

  decode(data: ArrayBuffer): void {
    if (!this.ready) { this.pending.push(data); return }
    this.post(data)
  }

  close(): void {
    this.worker.terminate()
    this.renderer.dispose()
  }

  private post(data: ArrayBuffer): void {
    // Transfer the buffer (zero-copy); the caller does not reuse it after decode().
    this.worker.postMessage(
      { type: 'decode', data, offset: 0, length: data.byteLength, renderStateId: RENDER_STATE_ID },
      [data],
    )
  }

  private onMessage(msg: WorkerMsg): void {
    if (msg.type === 'decoderReady') {
      this.ready = true
      for (const d of this.pending) this.post(d)
      this.pending.length = 0
      return
    }
    // pictureReady — render the decoded I420 frame.
    const size = this.renderer.drawI420(new Uint8Array(msg.data), msg.width, msg.height)
    if (!size) return
    // No exact per-frame decodeMs (software path) — the viewer's FIFO tracker derives
    // decode→present from submit↔present. Report present time only.
    this.decodedCb?.(performance.now())
    if (!this._size || this._size.width !== size.width || this._size.height !== size.height) {
      this._size = size
      this.resizeCb?.(size)
    }
  }
}
