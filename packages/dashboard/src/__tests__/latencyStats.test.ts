import { describe, it, expect } from 'vitest'
import { percentile, summarizeLatency } from '@/components/perf/latencyStats'
import type { FrameTiming } from '@/components/perf/types'

describe('percentile', () => {
  it('returns 0 for an empty set', () => {
    expect(percentile([], 50)).toBe(0)
  })

  it('returns the median (p50) via nearest-rank', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
  })

  it('returns the p95 near the top of the distribution', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(percentile(v, 95)).toBe(95)
  })

  it('does not mutate the input order', () => {
    const v = [30, 10, 20]
    percentile(v, 50)
    expect(v).toEqual([30, 10, 20])
  })
})

function timing(over: Partial<FrameTiming>): FrameTiming {
  return { recvAt: 0, recvInterval: 0, decodeMs: 0, paintMs: 0, ...over }
}

describe('summarizeLatency', () => {
  it('summarizes decodeMs p50/p95/max', () => {
    const s = summarizeLatency([
      timing({ decodeMs: 10 }), timing({ decodeMs: 20 }), timing({ decodeMs: 30 }),
    ])
    expect(s.count).toBe(3)
    expect(s.decodeMs.p50).toBe(20)
    expect(s.decodeMs.max).toBe(30)
  })

  it('returns null glass-to-glass when no single-clock samples exist', () => {
    const s = summarizeLatency([timing({ decodeMs: 10 })])
    expect(s.glassToGlassMs).toBeNull()
  })

  it('summarizes glass-to-glass only over frames that carry it', () => {
    const s = summarizeLatency([
      timing({ glassToGlassMs: 40 }),
      timing({}), // no glass sample — excluded
      timing({ glassToGlassMs: 60 }),
    ])
    expect(s.glassToGlassMs).not.toBeNull()
    expect(s.glassToGlassMs!.p50).toBe(40) // nearest-rank p50 of [40,60]
    expect(s.glassToGlassMs!.max).toBe(60)
  })

  it('derives agent→relay from envelope hops, ignoring unpatched (relayedAt=0) frames', () => {
    const s = summarizeLatency([
      timing({ capturedAt: 1000, relayedAt: 1005 }), // 5ms
      timing({ capturedAt: 2000, relayedAt: 0 }),    // unpatched — excluded
      timing({ capturedAt: 3000, relayedAt: 3009 }), // 9ms
    ])
    expect(s.agentRelayMs).not.toBeNull()
    expect(s.agentRelayMs!.max).toBe(9)
  })

  it('returns null agent→relay when no usable hop samples exist', () => {
    const s = summarizeLatency([timing({ decodeMs: 10 })])
    expect(s.agentRelayMs).toBeNull()
  })
})
