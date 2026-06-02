export interface FrameTiming {
  recvAt: number
  recvInterval: number
  decodeMs: number
  paintMs: number
  capturedAt?: number
  relayedAt?: number
  /** Present(epoch) − capturedAt. Single-clock environments (localhost) only; undefined otherwise. */
  glassToGlassMs?: number
}

export interface PerfHook {
  onFrameBegin: () => void
  onFrameEnd: (t: FrameTiming) => void
}
