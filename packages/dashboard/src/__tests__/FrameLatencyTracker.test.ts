import { describe, it, expect, beforeEach } from 'vitest'
import { FrameLatencyTracker } from '@/components/perf/FrameLatencyTracker'

describe('FrameLatencyTracker', () => {
  let tracker: FrameLatencyTracker

  beforeEach(() => {
    tracker = new FrameLatencyTracker()
  })

  it('matches a presented frame to its submit and reports decodeMs as the delta', () => {
    tracker.onSubmit({ submitTime: 100, recvAt: 90, recvInterval: 33 })
    const t = tracker.onPresented(118)
    expect(t).not.toBeNull()
    expect(t!.decodeMs).toBe(18) // 118 - 100
    expect(t!.recvAt).toBe(90)
    expect(t!.recvInterval).toBe(33)
    expect(t!.paintMs).toBe(0) // present already includes paint; no separate measure
  })

  it('correlates in FIFO order (submit order == present order, B-frames off)', () => {
    tracker.onSubmit({ submitTime: 100, recvAt: 90, recvInterval: 33 })
    tracker.onSubmit({ submitTime: 133, recvAt: 124, recvInterval: 34 })
    const a = tracker.onPresented(120)
    const b = tracker.onPresented(150)
    expect(a!.decodeMs).toBe(20)  // 120 - 100 (first submit)
    expect(a!.recvAt).toBe(90)
    expect(b!.decodeMs).toBe(17)  // 150 - 133 (second submit)
    expect(b!.recvAt).toBe(124)
  })

  it('returns null when a present arrives with nothing pending', () => {
    expect(tracker.onPresented(50)).toBeNull()
  })

  it('carries envelope agent/relay hops through to the timing', () => {
    tracker.onSubmit({
      submitTime: 100, recvAt: 90, recvInterval: 33,
      capturedAt: 1_700_000_000_000, relayedAt: 1_700_000_000_005,
    })
    const t = tracker.onPresented(118)
    expect(t!.capturedAt).toBe(1_700_000_000_000)
    expect(t!.relayedAt).toBe(1_700_000_000_005)
  })

  it('computes glassToGlassMs from epoch present minus capturedAt when both are known', () => {
    tracker.onSubmit({
      submitTime: 100, recvAt: 90, recvInterval: 33,
      capturedAt: 1_700_000_000_000,
    })
    // presentEpoch = timeOrigin + present, injected by the caller (single-clock/localhost only)
    const t = tracker.onPresented(118, 1_700_000_000_040)
    expect(t!.glassToGlassMs).toBe(40) // 1_700_000_000_040 - 1_700_000_000_000
  })

  it('leaves glassToGlassMs undefined when capturedAt is absent', () => {
    tracker.onSubmit({ submitTime: 100, recvAt: 90, recvInterval: 33 })
    const t = tracker.onPresented(118, 1_700_000_000_040)
    expect(t!.glassToGlassMs).toBeUndefined()
  })

  it('leaves glassToGlassMs undefined when no epoch present is provided', () => {
    tracker.onSubmit({
      submitTime: 100, recvAt: 90, recvInterval: 33,
      capturedAt: 1_700_000_000_000,
    })
    const t = tracker.onPresented(118)
    expect(t!.glassToGlassMs).toBeUndefined()
  })

  it('bounds pending growth by dropping the oldest unmatched submit', () => {
    const small = new FrameLatencyTracker(2) // maxPending = 2
    small.onSubmit({ submitTime: 1, recvAt: 1, recvInterval: 0 })
    small.onSubmit({ submitTime: 2, recvAt: 2, recvInterval: 0 })
    small.onSubmit({ submitTime: 3, recvAt: 3, recvInterval: 0 }) // evicts submitTime:1
    // Oldest survivor is submitTime:2 → decodeMs = 10 - 2
    expect(small.onPresented(10)!.decodeMs).toBe(8)
    expect(small.onPresented(11)!.decodeMs).toBe(8) // submitTime:3 → 11 - 3
    expect(small.onPresented(12)).toBeNull()
  })

  it('reset() clears all pending submits', () => {
    tracker.onSubmit({ submitTime: 100, recvAt: 90, recvInterval: 33 })
    tracker.reset()
    expect(tracker.onPresented(118)).toBeNull()
  })
})
