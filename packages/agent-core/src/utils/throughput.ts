export interface ThroughputSample {
  elapsedMs: number
  sentFrames: number
  droppedFrames: number
  producedFrames: number
  sentBytes: number
  fpsSent: number
  kbPerSec: number
  avgFrameKB: number
  dropRate: number
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round3 = (n: number) => Math.round(n * 1000) / 1000

// Aggregates per-frame send/drop counts into a windowed throughput sample.
// Mirrors createResourceSampler: a stateful factory, reset on each sample().
export function createThroughputSampler() {
  let sentFrames = 0
  let sentBytes = 0
  let droppedFrames = 0
  let windowStart = Date.now()

  return {
    recordSent(bytes: number): void {
      sentFrames++
      sentBytes += bytes
    },
    recordDropped(): void {
      droppedFrames++
    },
    sample(): ThroughputSample {
      const now = Date.now()
      const elapsedMs = now - windowStart
      const elapsedSec = elapsedMs / 1000
      const producedFrames = sentFrames + droppedFrames
      const result: ThroughputSample = {
        elapsedMs,
        sentFrames,
        droppedFrames,
        producedFrames,
        sentBytes,
        fpsSent: elapsedSec > 0 ? round1(sentFrames / elapsedSec) : 0,
        kbPerSec: elapsedSec > 0 ? round1(sentBytes / 1024 / elapsedSec) : 0,
        avgFrameKB: sentFrames > 0 ? round1(sentBytes / 1024 / sentFrames) : 0,
        dropRate: producedFrames > 0 ? round3(droppedFrames / producedFrames) : 0,
      }
      sentFrames = 0
      sentBytes = 0
      droppedFrames = 0
      windowStart = now
      return result
    },
  }
}
