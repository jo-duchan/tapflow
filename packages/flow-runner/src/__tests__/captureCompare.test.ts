import { describe, it, expect } from 'vitest'
import { screenDiff, statusBarRect, turnRect, sameShape, SCREEN_DIFF_THRESHOLD, type Pixels } from '../capture/index.js'

// 1b-3b: Match compares the screen a step is about to act on with the one it was recorded on.
// The recorded picture's size: the device's frame is drawn at it before the two are compared.
const W = 160
const H = 361
/** A white picture with dark boxes drawn on it, in fractions. */
function picture(boxes: Array<[number, number, number, number]> = [], shade = 0): Pixels {
  const data = new Uint8ClampedArray(W * H * 4).fill(255)
  for (const [x, y, w, h] of boxes) {
    for (let py = Math.round(y * H); py < Math.round((y + h) * H); py++) {
      for (let px = Math.round(x * W); px < Math.round((x + w) * W); px++) {
        const i = (py * W + px) * 4
        data[i] = data[i + 1] = data[i + 2] = shade
      }
    }
  }
  return { width: W, height: H, data }
}

describe('screenDiff', () => {
  it('reads one screen as itself and a different one as different', () => {
    const form = picture([[0.1, 0.2, 0.8, 0.05], [0.1, 0.3, 0.8, 0.05]])
    expect(screenDiff(form, picture([[0.1, 0.2, 0.8, 0.05], [0.1, 0.3, 0.8, 0.05]]), [])).toBe(0)
    expect(screenDiff(form, picture([[0.1, 0.5, 0.8, 0.3]]), [])).toBeGreaterThan(SCREEN_DIFF_THRESHOLD)
  })

  it('does not count a difference the cut misses: a shade under it', () => {
    expect(screenDiff(picture(), { ...picture([[0, 0, 1, 1]], 235) }, [])).toBe(0)
    expect(screenDiff(picture(), picture([[0, 0, 1, 1]], 225), [])).toBeGreaterThan(0.99)
  })

  it('leaves out what a mask covers, on both pictures', () => {
    const clock = picture([[0.1, 0, 0.2, 0.03]])
    expect(screenDiff(picture(), clock, [])).toBeGreaterThan(0)
    expect(screenDiff(picture(), clock, [statusBarRect('ios', undefined)!])).toBe(0)
    const keys = picture([[0, 0.6, 1, 0.4]])
    expect(screenDiff(picture(), keys, [{ x: 0, y: 0.6, width: 1, height: 0.4 }])).toBe(0)
  })

  it('cannot compare pictures of two sizes, or nothing left to compare', () => {
    expect(screenDiff(picture(), { width: W, height: H + 4, data: new Uint8ClampedArray(W * (H + 4) * 4) }, [])).toBe('incomparable')
    expect(screenDiff(picture(), picture(), [{ x: 0, y: 0, width: 1, height: 1 }])).toBe('incomparable')
  })
})

describe('where the status bar is in the frame', () => {
  it('runs along the top upright and down a side when the screen is turned', () => {
    expect(statusBarRect('android', undefined)).toEqual({ x: 0, y: 0, width: 1, height: 0.035 })
    const r90 = statusBarRect('ios', 90)!
    expect(r90.width).toBeCloseTo(0.055)
    expect(r90.height).toBeCloseTo(1)
    expect(r90.x).toBeCloseTo(0)
    const r270 = statusBarRect('ios', 270)!
    expect(r270.x).toBeCloseTo(1 - 0.055)
    expect(statusBarRect('windows', 0)).toBeUndefined()
  })

  it('turns a rect as a point is turned', () => {
    expect(turnRect({ x: 0, y: 0.6, width: 1, height: 0.4 }, 180)).toEqual({ x: 0, y: 0, width: 1, height: expect.closeTo(0.4) as number })
  })
})

describe('sameShape', () => {
  it('takes a 160 px thumbnail and its frame as one shape, and a fold\'s other panel as not', () => {
    expect(sameShape({ width: 160, height: 361 }, { width: 1072, height: 2416 })).toBe(true)
    expect(sameShape({ width: 160, height: 361 }, { width: 1800, height: 2000 })).toBe(false)
  })
})
