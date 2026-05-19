import { describe, it, expect } from 'vitest'
import {
  iosToNormScreen,
  androidToNorm,
  toPinchFingers,
  iosDisplayScale,
} from '@/lib/coordinate-transform'

// ── helpers ──────────────────────────────────────────────────────────────────

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height }
}

function srect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height }
}

// ── iosToNormScreen — portrait ────────────────────────────────────────────────

describe('iosToNormScreen — portrait', () => {
  const r = rect(0, 0, 200, 400)
  const cw = 200, ch = 400
  const fullScreen = srect(0, 0, 200, 400)

  it('정중앙 → {0.5, 0.5}', () => {
    expect(iosToNormScreen({ x: 100, y: 200 }, r, cw, ch, fullScreen, false))
      .toEqual({ x: 0.5, y: 0.5 })
  })

  it('bezel 클릭(screenRect 바깥) → null', () => {
    const inner = srect(50, 50, 100, 300)
    expect(iosToNormScreen({ x: 10, y: 10 }, r, cw, ch, inner, false)).toBeNull()
  })

  it('screenRect 우하단 경계 정확히 → {1, 1}', () => {
    const inner = srect(50, 50, 100, 300)
    // click at (50+100, 50+300) = (150, 350)
    // cx = 150 * (200/200) = 150, cy = 350 * (400/400) = 350
    // (cx - sx)/sw = (150-50)/100 = 1, (cy-sy)/sh = (350-50)/300 = 1
    expect(iosToNormScreen({ x: 150, y: 350 }, r, cw, ch, inner, false))
      .toEqual({ x: 1, y: 1 })
  })
})

// ── iosToNormScreen — landscape ───────────────────────────────────────────────
// In landscape the rect is the outer unrotated div (width=portraitH, height=portraitW).
// Mapping: portrait_x = 1-v, portrait_y = u  (where u=xFrac, v=yFrac of landscape rect)

describe('iosToNormScreen — landscape rotation (off-by-one guard)', () => {
  // Landscape rect: width=compositeH, height=compositeW so that u/v are direct fractions
  const cw = 200, ch = 400
  const fullScreen = srect(0, 0, 200, 400)
  const landscapeRect = rect(0, 0, ch, cw) // width=400, height=200

  it('시각 좌상단(u=0,v=0) → portrait {1, 0}', () => {
    // u=0,v=0 → cx=(1-0)*200=200, cy=0*400=0 → {(200-0)/200, (0-0)/400} = {1, 0}
    expect(iosToNormScreen({ x: 0, y: 0 }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 1, y: 0 })
  })

  it('시각 정중앙(u=0.5,v=0.5) → portrait {0.5, 0.5}', () => {
    // u=0.5,v=0.5 → cx=0.5*200=100, cy=0.5*400=200 → {0.5, 0.5}
    expect(iosToNormScreen({ x: ch * 0.5, y: cw * 0.5 }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0.5, y: 0.5 })
  })

  it('시각 우하단(u=1,v=1) → portrait {0, 1}', () => {
    // u=1,v=1 → cx=(1-1)*200=0, cy=1*400=400 → {0, 1}
    expect(iosToNormScreen({ x: ch, y: cw }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0, y: 1 })
  })

  it('시각 우상단(u=0,v=1) → portrait {0, 0}', () => {
    // u=0,v=1 → cx=0, cy=0 → {0, 0}
    expect(iosToNormScreen({ x: 0, y: cw }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0, y: 0 })
  })
})

// ── androidToNorm — portrait ──────────────────────────────────────────────────

describe('androidToNorm — portrait', () => {
  const r = rect(0, 0, 360, 800)

  it('정중앙 → {0.5, 0.5}', () => {
    expect(androidToNorm({ x: 180, y: 400 }, r, false)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('범위 밖 클릭 → null', () => {
    expect(androidToNorm({ x: -10, y: 50 }, r, false)).toBeNull()
  })
})

// ── androidToNorm — landscape CSS rotation ───────────────────────────────────
// Canvas rotated 90° CW: portrait_x = yv, portrait_y = 1 - xv

describe('androidToNorm — landscape (CSS rotate 90deg CW)', () => {
  const r = rect(0, 0, 1, 1) // unit rect so xv=x, yv=y

  it('시각 좌상단(xv=0,yv=0) → portrait {0, 1}', () => {
    expect(androidToNorm({ x: 0, y: 0 }, r, true)).toEqual({ x: 0, y: 1 })
  })

  it('시각 우하단(xv=1,yv=1) → portrait {1, 0}', () => {
    expect(androidToNorm({ x: 1, y: 1 }, r, true)).toEqual({ x: 1, y: 0 })
  })
})

// ── toPinchFingers ────────────────────────────────────────────────────────────

describe('toPinchFingers', () => {
  it('f1이 {0.3, 0.4} → f0는 점 대칭 {0.7, 0.6}', () => {
    const { f0, f1 } = toPinchFingers({ x: 0.3, y: 0.4 })
    expect(f0).toEqual({ x: 0.7, y: 0.6 })
    expect(f1).toEqual({ x: 0.3, y: 0.4 })
  })

  it('f1이 정중앙 → f0도 정중앙', () => {
    const { f0, f1 } = toPinchFingers({ x: 0.5, y: 0.5 })
    expect(f0).toEqual({ x: 0.5, y: 0.5 })
    expect(f1).toEqual({ x: 0.5, y: 0.5 })
  })
})

// ── iosDisplayScale ───────────────────────────────────────────────────────────

describe('iosDisplayScale', () => {
  it('compositeH < maxH → scale 1', () => {
    expect(iosDisplayScale(500, 800)).toBe(1)
  })

  it('compositeH > maxH → maxH / compositeH', () => {
    expect(iosDisplayScale(1600, 800)).toBe(0.5)
  })

  it('compositeH = 0 → 1 (division-by-zero guard)', () => {
    expect(iosDisplayScale(0, 800)).toBe(1)
  })
})
