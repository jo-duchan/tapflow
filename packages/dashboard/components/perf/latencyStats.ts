import type { FrameTiming } from './types'

export interface Percentiles {
  p50: number
  p95: number
  max: number
}

export interface LatencySummary {
  count: number
  /** Decode→present (submit→present). Always available. */
  decodeMs: Percentiles
  /** Present(epoch) − capturedAt. Single-clock (localhost) only; null otherwise. */
  glassToGlassMs: Percentiles | null
  /** relayedAt − capturedAt (both agent-side). null when no usable hop samples. */
  agentRelayMs: Percentiles | null
}

/** Nearest-rank percentile. Returns 0 for an empty set. Does not mutate input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const idx = Math.min(Math.max(rank, 0), sorted.length - 1)
  return sorted[idx]
}

function stats(values: number[]): Percentiles {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : 0,
  }
}

export function summarizeLatency(timings: FrameTiming[]): LatencySummary {
  const decode = timings.map((t) => t.decodeMs).filter((v) => Number.isFinite(v))
  const glass = timings
    .map((t) => t.glassToGlassMs)
    .filter((v): v is number => v !== undefined)
  // relayedAt is 0 until the relay patches it; skip those so the hop isn't garbage.
  const agentRelay = timings
    .filter((t) => t.capturedAt !== undefined && t.relayedAt !== undefined && t.relayedAt > 0)
    .map((t) => (t.relayedAt as number) - (t.capturedAt as number))

  return {
    count: timings.length,
    decodeMs: stats(decode),
    glassToGlassMs: glass.length ? stats(glass) : null,
    agentRelayMs: agentRelay.length ? stats(agentRelay) : null,
  }
}
