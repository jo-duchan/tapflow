import { describe, it, expect, vi } from 'vitest'
import type { RawStep } from '@tapflowio/flow-runner/browser'
import { Remembered, MAX_CARRIED_SHARE } from '@/lib/flowCapture/remembered'

// (c), R6 revised: what Continue anyway accepted is carried to a later step only on the same screen, never over what
// the step touches, and a mostly different stop only ever skips its own step.
const tap = (x: number, y: number, over: Record<string, unknown> = {}): RawStep =>
  ({ at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'tap', point: [x, y], ...over }) as unknown as RawStep
const SKY = { x: 0, y: 0.1, width: 1, height: 0.2 }
const MASKS = [{ x: 0, y: 0, width: 1, height: 0.055 }]

const made = (alike: boolean | ((a: string, b: string) => boolean) = true) => {
  const asked = vi.fn(async (a: string, b: string) => (typeof alike === 'function' ? alike(a, b) : alike))
  const r = new Remembered(asked)
  r.begin(0)
  return { r, asked }
}

describe('what Continue anyway remembers', () => {
  it('carries an area to a later step on the same screen, and says from where', async () => {
    const { r, asked } = made(true)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.8), '/t/5', MASKS, undefined)).toEqual({ areas: [SKY], from: 2 })
    // Held against the accepted step's picture with the area itself set aside.
    expect(asked).toHaveBeenCalledWith('/t/2', '/t/5', [...MASKS, SKY], undefined)
  })

  it('does not carry it to another screen', async () => {
    const { r } = made(false)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.8), '/t/5', MASKS, undefined)).toBeNull()
  })

  it('never carries an area over the point the step touches; one away from it is carried', async () => {
    const { r } = made(true)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.2), '/t/5', MASKS, undefined)).toBeNull()
    expect(await r.carried(6, tap(0.5, 0.6), '/t/6', MASKS, undefined)).toEqual({ areas: [SKY], from: 2 })
  })

  it('places the touch in the picture by the turn, unless it was made in the frame', async () => {
    const { r } = made(true)
    // A band down the left of the frame: where the top of a screen turned a quarter lands.
    const band = { x: 0, y: 0, width: 0.2, height: 1 }
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [band], mostly: false })
    const turned = await r.carried(5, tap(0.5, 0.1), '/t/5', MASKS, 90)
    const framed = await r.carried(6, tap(0.5, 0.1, { space: 'frame' }), '/t/6', MASKS, 90)
    // One of the two lands in the band and the other does not: the turn is applied to one only.
    expect([turned, framed].filter((c) => c === null)).toHaveLength(1)
  })

  it('keeps the person\'s word at the step it was given, over its target too', async () => {
    const { r, asked } = made(false)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await r.carried(2, tap(0.5, 0.2), '/t/2', MASKS, undefined)).toEqual({ areas: [SKY], from: 2 })
    expect(asked).not.toHaveBeenCalled()
  })

  it('does not carry areas that cover much of the screen to another step; smaller ones are', async () => {
    const { r } = made(true)
    const big = { x: 0, y: 0.1, width: 1, height: MAX_CARRIED_SHARE + 0.05 }
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [big], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.9), '/t/5', MASKS, undefined)).toBeNull()
    r.accept({ index: 3, recordedUrl: '/t/3', areas: [SKY], mostly: false })
    expect(await r.carried(6, tap(0.5, 0.9), '/t/6', MASKS, undefined)).toEqual({ areas: [SKY], from: 3 })
  })

  // Pre-PR review of (c): the cap holds the areas carried together, not each accepted stop alone.
  it('carries areas from several stops only up to the cap together', async () => {
    const { r } = made(true)
    const fifth = (y: number) => ({ x: 0, y, width: 1, height: 0.15 })
    r.accept({ index: 1, recordedUrl: '/t/1', areas: [fifth(0.1)], mostly: false })
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [fifth(0.3)], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.9), '/t/5', MASKS, undefined)).toEqual({ areas: [fifth(0.1)], from: 1 })
  })

  it('skips only the step a mostly different stop was accepted at, and carries nothing from it', async () => {
    const { r, asked } = made(true)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: true })
    expect(await r.carried(2, tap(0.5, 0.9), '/t/2', MASKS, undefined)).toBe('skip')
    expect(await r.carried(5, tap(0.5, 0.9), '/t/5', MASKS, undefined)).toBeNull()
    expect(asked).not.toHaveBeenCalled()
    // An area accepted at the same step still leaves the rest of it compared.
    const { r: other } = made(true)
    other.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await other.carried(2, tap(0.5, 0.9), '/t/2', MASKS, undefined)).toEqual({ areas: [SKY], from: 2 })
  })

  it('asks once per pair of steps, however often the step is compared', async () => {
    const { r, asked } = made(true)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    for (let i = 0; i < 5; i++) await r.carried(5, tap(0.5, 0.8), '/t/5', MASKS, undefined)
    expect(asked).toHaveBeenCalledTimes(1)
  })

  // CodeRabbit on #1177: a second stop at the same step is held against the later screen with its own areas set aside.
  it('asks again for a second stop at the same step, with its own areas', async () => {
    const ROW = { x: 0, y: 0.5, width: 1, height: 0.1 }
    const asked = vi.fn(async (_a: string, _b: string, masks: unknown[]) => masks.includes(ROW))
    const r = new Remembered(asked)
    r.begin(0)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.9), '/t/5', MASKS, undefined)).toBeNull()
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [ROW], mostly: false })
    expect(await r.carried(5, tap(0.5, 0.9), '/t/5', MASKS, undefined)).toEqual({ areas: [ROW], from: 2 })
  })

  it('does not keep an answer Stop cut short', async () => {
    const { r, asked } = made(false)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: false })
    const stop = new AbortController()
    stop.abort()
    await r.carried(5, tap(0.5, 0.8), '/t/5', MASKS, undefined, stop.signal)
    await Promise.resolve()
    await r.carried(5, tap(0.5, 0.8), '/t/5', MASKS, undefined)
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('forgets on a Match from another start, and keeps on one from the same', async () => {
    const { r } = made(true)
    r.accept({ index: 2, recordedUrl: '/t/2', areas: [SKY], mostly: true })
    r.begin(0)
    expect(await r.carried(2, tap(0.5, 0.9), '/t/2', MASKS, undefined)).toBe('skip')
    r.begin(1)
    expect(await r.carried(2, tap(0.5, 0.9), '/t/2', MASKS, undefined)).toBeNull()
  })
})
