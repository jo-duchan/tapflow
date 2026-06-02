/**
 * Common contract for H.264 stream decoders.
 *
 * Each implementation owns its render surface so the viewer stays decoder-agnostic:
 * - WebCodecsDecoder — VideoDecoder → WebGL <canvas> (lowest latency, secure context only)
 * - MSEDecoder — Media Source Extensions → <video> (works over plain HTTP)
 *
 * `pickDecoder()` selects an implementation at runtime based on capability.
 */
export interface DecoderSize {
  width: number
  height: number
}

/** Per-frame decode diagnostics, when the decoder can report them (WebCodecs). */
export interface DecodeSample {
  /** Exact decode-call → output latency for this frame (timestamp-matched, drop-immune). */
  decodeMs: number
  /** VideoDecoder.decodeQueueSize at output — depth of the decoder's backlog. */
  queueSize: number
}

export interface Decoder {
  /** Feed one Annex B framed H.264 NAL unit (00 00 00 01 + NAL). */
  decode(data: ArrayBuffer): void
  /** Release all decoder resources. */
  close(): void
  /** Live media element to mount: <canvas> (WebCodecs) or <video> (MSE). Valid as a drawImage source. */
  readonly surface: HTMLCanvasElement | HTMLVideoElement
  /** Latest decoded frame size; null until the first frame. */
  readonly size: DecoderSize | null
  /** Registers a callback fired once per size change (first frame, rotation). */
  onResize(cb: (size: DecoderSize) => void): void
  /**
   * Registers a callback fired once per presented frame, with performance.now()
   * at present time (decode + any media-element buffering included). When the
   * decoder can measure it (WebCodecs), an exact per-frame DecodeSample is also
   * passed. Optional — decoders that cannot observe their present moment omit it.
   * Latency instrumentation only.
   */
  onDecodedFrame?(cb: (presentTime: number, sample?: DecodeSample) => void): void
}
