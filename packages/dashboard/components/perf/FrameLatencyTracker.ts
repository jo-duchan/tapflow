import type { FrameTiming } from './types'

export interface SubmitInfo {
  /** performance.now() when decode() was handed to the decoder. */
  submitTime: number
  /** performance.now() when the frame arrived over the WebSocket. */
  recvAt: number
  recvInterval: number
  /** Wall-clock epoch ms stamped by the agent (envelope). */
  capturedAt?: number
  /** Wall-clock epoch ms stamped by the relay (envelope). */
  relayedAt?: number
}

const DEFAULT_MAX_PENDING = 8

/**
 * Correlates a decoder's async "frame presented" events back to the decode-submit
 * that produced them, so the H.264 path (fire-and-forget into a decoder surface)
 * can report decodeMs / glass-to-glass like the synchronous JPEG path.
 *
 * Relies on submit order == present order — exact because the encoder is baseline
 * H.264 with B-frames OFF (no reorder), so a plain FIFO matches each present to its
 * submit. Bounded so a stall or a submit that never yields a frame can't lag latency
 * forever — the oldest unmatched submit is dropped past `maxPending`.
 */
export class FrameLatencyTracker {
  private readonly pending: SubmitInfo[] = []

  constructor(private readonly maxPending = DEFAULT_MAX_PENDING) {}

  onSubmit(info: SubmitInfo): void {
    this.pending.push(info)
    while (this.pending.length > this.maxPending) this.pending.shift()
  }

  /**
   * @param presentTime  performance.now() at the moment the frame was presented.
   * @param presentEpoch performance.timeOrigin + presentTime (epoch ms). Provide
   *   only when the agent and browser share one clock (localhost) so glass-to-glass
   *   is meaningful; omit on LAN where clocks differ.
   */
  onPresented(presentTime: number, presentEpoch?: number): FrameTiming | null {
    const info = this.pending.shift()
    if (!info) return null
    const timing: FrameTiming = {
      recvAt: info.recvAt,
      recvInterval: info.recvInterval,
      decodeMs: presentTime - info.submitTime,
      paintMs: 0, // present already includes paint; the decoder owns the surface
      capturedAt: info.capturedAt,
      relayedAt: info.relayedAt,
    }
    if (presentEpoch !== undefined && info.capturedAt !== undefined) {
      timing.glassToGlassMs = presentEpoch - info.capturedAt
    }
    return timing
  }

  reset(): void {
    this.pending.length = 0
  }
}
