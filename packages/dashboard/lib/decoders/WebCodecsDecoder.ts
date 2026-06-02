import type { Decoder, DecoderSize, DecodeSample } from './types'
import { WebCodecsCore } from './WebCodecsCore'
import { WebGLVideoRenderer } from '../WebGLVideoRenderer'

/** Minimal renderer seam — satisfied by WebGLVideoRenderer, mockable in tests. */
export interface FrameRenderer {
  /** Takes ownership of `frame` and closes it — callers must not close it. */
  drawFrame(frame: VideoFrame): { width: number; height: number } | null
  dispose(): void
}

function defaultRenderer(canvas: HTMLCanvasElement): FrameRenderer {
  const r = new WebGLVideoRenderer(canvas)
  r.init()
  return r
}

/**
 * H.264 decoder for secure contexts (HTTPS/localhost). Lowest latency: decodes
 * via WebCodecs and renders VideoFrames straight to its own WebGL <canvas> — no
 * media-element buffering. For plain-HTTP LAN access use MSEDecoder.
 *
 * Owns its render surface so the viewer stays decoder-agnostic.
 */
export class WebCodecsDecoder implements Decoder {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: FrameRenderer
  private readonly core: WebCodecsCore
  private _size: DecoderSize | null = null
  private resizeCb?: (size: DecoderSize) => void
  private decodedCb?: (presentTime: number, sample?: DecodeSample) => void
  private lastSample?: DecodeSample

  constructor(createRenderer: (canvas: HTMLCanvasElement) => FrameRenderer = defaultRenderer) {
    this.canvas = document.createElement('canvas')
    this.renderer = createRenderer(this.canvas)
    this.core = new WebCodecsCore((frame) => this.render(frame))
  }

  get surface(): HTMLCanvasElement { return this.canvas }
  get size(): DecoderSize | null { return this._size }

  onResize(cb: (size: DecoderSize) => void): void { this.resizeCb = cb }
  onDecodedFrame(cb: (presentTime: number, sample?: DecodeSample) => void): void {
    this.decodedCb = cb
    this.core.setDecodeSampler((s) => { this.lastSample = s })
  }

  decode(data: ArrayBuffer): void { this.core.decode(data) }

  close(): void {
    this.core.close()
    this.renderer.dispose()
  }

  private render(frame: VideoFrame): void {
    const size = this.renderer.drawFrame(frame)
    if (!size) return
    this.decodedCb?.(performance.now(), this.lastSample)
    this.lastSample = undefined
    if (!this._size || this._size.width !== size.width || this._size.height !== size.height) {
      this._size = size
      this.resizeCb?.(size)
    }
  }
}
