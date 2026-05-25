export interface FrameTiming {
  recvAt: number
  recvInterval: number
  decodeMs: number
  paintMs: number
  capturedAt?: number
  relayedAt?: number
}

export interface PerfHook {
  onFrameBegin: () => void
  onFrameEnd: (t: FrameTiming) => void
}
