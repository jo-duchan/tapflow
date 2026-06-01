import type { Decoder, DecoderSize } from './types'

/**
 * Minimal muxer seam — satisfied by jmuxer, mockable in tests.
 * Receives Annex B framed H.264 and feeds the <video>'s MediaSource.
 */
export interface Muxer {
  feed(data: { video: Uint8Array }): void
  destroy(): void
}

/**
 * H.264 decoder for plain-HTTP LAN access via Media Source Extensions.
 *
 * MSE works without a secure context (unlike WebCodecs), at the cost of some
 * media-element buffering latency. NAL units are muxed to fragmented MP4 by the
 * injected `Muxer` (jmuxer) and rendered by a self-playing <video>.
 *
 * Owns its render surface so the viewer stays decoder-agnostic. The jmuxer
 * factory is injected (see createJMuxer) to keep this module free of the
 * browser-only MediaSource dependency.
 */
export class MSEDecoder implements Decoder {
  private readonly video: HTMLVideoElement
  private readonly createMuxer: (video: HTMLVideoElement) => Muxer
  private muxer: Muxer
  private sps: Uint8Array | null = null
  private _size: DecoderSize | null = null
  private resizeCb?: (size: DecoderSize) => void

  constructor(createMuxer: (video: HTMLVideoElement) => Muxer) {
    this.createMuxer = createMuxer
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.addEventListener('resize', this.handleResize)
    this.muxer = createMuxer(this.video)
  }

  get surface(): HTMLVideoElement { return this.video }
  get size(): DecoderSize | null { return this._size }

  onResize(cb: (size: DecoderSize) => void): void { this.resizeCb = cb }

  decode(data: ArrayBuffer): void {
    this.reinitOnResolutionChange(data)
    this.muxer.feed({ video: new Uint8Array(data) })
  }

  // MSE cannot switch resolution mid-stream (a new init segment is required).
  // When the SPS changes — e.g. device rotation in a landscape-capable app flips
  // the encoded size — rebuild the muxer/MediaSource so decoding doesn't stall.
  private reinitOnResolutionChange(data: ArrayBuffer): void {
    const nal = new Uint8Array(data)
    const startCode = nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1
    const nalType = (startCode ? nal[4] : nal[0]) & 0x1f
    if (nalType !== 7) return // SPS only
    const changed = !this.sps || nal.length !== this.sps.length || nal.some((b, i) => b !== this.sps![i])
    if (this.sps && changed) {
      this.muxer.destroy()
      this.muxer = this.createMuxer(this.video)
    }
    this.sps = nal
  }

  close(): void {
    this.video.removeEventListener('resize', this.handleResize)
    this.muxer.destroy()
  }

  private handleResize = (): void => {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (!width || !height) return
    if (!this._size || this._size.width !== width || this._size.height !== height) {
      this._size = { width, height }
      this.resizeCb?.(this._size)
    }
  }
}
