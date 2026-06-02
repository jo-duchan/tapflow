import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createThroughputSampler } from '../utils/throughput'

describe('createThroughputSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts sent frames and bytes within the window', () => {
    const s = createThroughputSampler()
    s.recordSent(1000)
    s.recordSent(2000)
    vi.advanceTimersByTime(1000)
    const sample = s.sample()
    expect(sample.sentFrames).toBe(2)
    expect(sample.sentBytes).toBe(3000)
  })

  it('computes fpsSent over the elapsed window', () => {
    const s = createThroughputSampler()
    for (let i = 0; i < 60; i++) s.recordSent(500)
    vi.advanceTimersByTime(2000) // 60 frames / 2s = 30 fps
    expect(s.sample().fpsSent).toBe(30)
  })

  it('computes kbPerSec from sent bytes over the window', () => {
    const s = createThroughputSampler()
    s.recordSent(102_400) // 100 KB
    vi.advanceTimersByTime(1000) // over 1s → 100 KB/s
    expect(s.sample().kbPerSec).toBe(100)
  })

  it('computes avgFrameKB from sent frames only', () => {
    const s = createThroughputSampler()
    s.recordSent(51_200) // 50 KB
    s.recordSent(51_200) // 50 KB
    s.recordDropped() // dropped frames must not skew the average
    vi.advanceTimersByTime(1000)
    expect(s.sample().avgFrameKB).toBe(50)
  })

  it('computes dropRate as dropped / produced', () => {
    const s = createThroughputSampler()
    s.recordSent(1000)
    s.recordSent(1000)
    s.recordSent(1000)
    s.recordDropped() // 1 dropped of 4 produced → 0.25
    vi.advanceTimersByTime(1000)
    const sample = s.sample()
    expect(sample.producedFrames).toBe(4)
    expect(sample.droppedFrames).toBe(1)
    expect(sample.dropRate).toBe(0.25)
  })

  it('resets counters after each sample', () => {
    const s = createThroughputSampler()
    s.recordSent(1000)
    vi.advanceTimersByTime(1000)
    s.sample()
    vi.advanceTimersByTime(1000)
    const second = s.sample()
    expect(second.sentFrames).toBe(0)
    expect(second.sentBytes).toBe(0)
    expect(second.kbPerSec).toBe(0)
  })

  it('returns zeros without dividing by zero on an empty window', () => {
    const s = createThroughputSampler()
    const sample = s.sample()
    expect(sample.fpsSent).toBe(0)
    expect(sample.kbPerSec).toBe(0)
    expect(sample.avgFrameKB).toBe(0)
    expect(sample.dropRate).toBe(0)
  })
})
