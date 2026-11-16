import { describe, it, expect } from 'vitest'
import { screenDiff, screenCells, withoutAreas, diffAreas, statusBarRect, turnRect, sameShape, SCREEN_DIFF_THRESHOLD, type Pixels } from '../capture/index.js'

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

// (c): a stop draws where the two differ, from the same grid it measured.
describe('screenCells and diffAreas', () => {
  const cellsOf = (a: Pixels, b: Pixels) => {
    const c = screenCells(a, b, [])
    if (c === 'incomparable') throw new Error('incomparable')
    return c
  }

  it('measures the share screenDiff does', () => {
    const a = picture([[0.1, 0.2, 0.8, 0.05]])
    const b = picture([[0.1, 0.5, 0.8, 0.3]])
    expect(cellsOf(a, b).share).toBe(screenDiff(a, b, []))
    expect(screenCells(picture(), { ...picture(), width: W + 1 }, [])).toBe('incomparable')
  })

  it('draws no area where nothing differs', () => {
    expect(diffAreas(cellsOf(picture(), picture()))).toEqual([])
  })

  it('draws one box around one change, inside the picture', () => {
    const [area, ...rest] = diffAreas(cellsOf(picture(), picture([[0.25, 0.4, 0.5, 0.1]])))
    expect(rest).toEqual([])
    expect(area!.x).toBeGreaterThanOrEqual(0.2)
    expect(area!.x + area!.width).toBeLessThanOrEqual(0.8)
    expect(area!.y).toBeGreaterThanOrEqual(0.35)
    expect(area!.y + area!.height).toBeLessThanOrEqual(0.55)
  })

  it('keeps two changes far apart as two boxes, largest first', () => {
    const areas = diffAreas(cellsOf(picture(), picture([[0.1, 0.1, 0.2, 0.05], [0.1, 0.7, 0.8, 0.2]])))
    expect(areas).toHaveLength(2)
    expect(areas[0]!.y).toBeGreaterThan(0.6)
  })

  it('joins changes up to three unchanged cells apart, and not four, across and down', () => {
    // A 9 by 9 grid, the middle row or column set at the given places.
    const across = (cols: number[]) => {
      const cells = new Uint8Array(9 * 9)
      for (const c of cols) cells[4 * 9 + c] = 1
      return { cells, gridWidth: 9, gridHeight: 9 }
    }
    const down = (rows: number[]) => {
      const cells = new Uint8Array(9 * 9)
      for (const r of rows) cells[r * 9 + 4] = 1
      return { cells, gridWidth: 9, gridHeight: 9 }
    }
    expect(diffAreas(across([0, 4]))).toHaveLength(1)
    expect(diffAreas(across([0, 5]))).toHaveLength(2)
    expect(diffAreas(down([0, 4]))).toHaveLength(1)
    expect(diffAreas(down([0, 5]))).toHaveLength(2)
  })

  it('never boxes what a mask left out', () => {
    const keys = picture([[0, 0.6, 1, 0.4]])
    const c = screenCells(picture(), keys, [{ x: 0, y: 0.6, width: 1, height: 0.4 }])
    if (c === 'incomparable') throw new Error('incomparable')
    expect(diffAreas(c)).toEqual([])
  })

  it('judges again without the areas a person set aside, over what is left', () => {
    const both = cellsOf(picture(), picture([[0.1, 0.1, 0.8, 0.2], [0.1, 0.7, 0.3, 0.05]]))
    const top = { x: 0.05, y: 0.05, width: 0.9, height: 0.3 }
    const rest = withoutAreas(both, [top])
    // The lower change is still there, and measured over fewer cells.
    expect(diffAreas(rest)).toHaveLength(1)
    expect(rest.share).toBeGreaterThan(0)
    expect(rest.share).toBeLessThan(both.share)
    // Set aside where the only change was: alike.
    expect(withoutAreas(cellsOf(picture(), picture([[0.1, 0.1, 0.8, 0.2]])), [top]).share).toBe(0)
  })
})
