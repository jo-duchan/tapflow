import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOLD_FRAME_MS, HOLD_WOBBLE, holdStill } from '../hold.js'

afterEach(() => { vi.useRealTimers() })

describe('holdStill', () => {
  // Measured on iOS: neither a silent hold nor the same point repeated stops the glide; a wobbling point does.
  it('sends the end point every frame for the hold, wobbling, starting on the point itself', async () => {
    vi.useFakeTimers()
    let t = 0
    const now = () => t
    const sent: Array<{ x: number; y: number }> = []
    const done = holdStill([0.5, 0.3], 150, (p) => sent.push(p), () => true, now)
    for (let i = 0; i < 20; i++) { t += HOLD_FRAME_MS; await vi.advanceTimersByTimeAsync(HOLD_FRAME_MS) }
    expect(await done).toBe(true)
    expect(sent[0]).toEqual({ x: 0.5, y: 0.3 })
    expect(sent.length).toBe(Math.ceil(150 / HOLD_FRAME_MS))
    expect(new Set(sent.map((p) => p.y))).toEqual(new Set([0.3, 0.3 + HOLD_WOBBLE]))
  })

  it('wobbles toward the middle at the bottom edge, so no point leaves the screen', async () => {
    vi.useFakeTimers()
    let t = 0
    const sent: Array<{ x: number; y: number }> = []
    const done = holdStill([0.5, 1], 40, (p) => sent.push(p), () => true, () => t)
    for (let i = 0; i < 5; i++) { t += HOLD_FRAME_MS; await vi.advanceTimersByTimeAsync(HOLD_FRAME_MS) }
    await done
    for (const p of sent) expect(p.y).toBeLessThanOrEqual(1)
    expect(sent.some((p) => p.y < 1)).toBe(true)
  })

  it('stops, and says so, when the gesture is taken away, the last wait included', async () => {
    vi.useFakeTimers()
    let t = 0
    let open = true
    const sent: unknown[] = []
    const done = holdStill([0.5, 0.3], 100, (p) => sent.push(p), () => open, () => t)
    t += 50; await vi.advanceTimersByTimeAsync(50)
    const before = sent.length
    open = false
    for (let i = 0; i < 10; i++) { t += HOLD_FRAME_MS; await vi.advanceTimersByTimeAsync(HOLD_FRAME_MS) }
    expect(await done).toBe(false)
    expect(sent.length).toBe(before)
    // Taken away during the final wait only.
    let t2 = 0
    let open2 = true
    const last = holdStill([0.5, 0.3], HOLD_FRAME_MS, () => { open2 = false }, () => open2, () => t2)
    t2 += HOLD_FRAME_MS; await vi.advanceTimersByTimeAsync(HOLD_FRAME_MS)
    expect(await last).toBe(false)
  })

  it('is bounded by its clock, not by a count of frames: a slow timer still lifts on time', async () => {
    vi.useFakeTimers()
    let t = 0
    const sent: unknown[] = []
    const done = holdStill([0.5, 0.3], 150, (p) => sent.push(p), () => true, () => t)
    t += 1_000; await vi.advanceTimersByTimeAsync(HOLD_FRAME_MS)
    expect(await done).toBe(true)
    expect(sent).toHaveLength(1)
  })
})
