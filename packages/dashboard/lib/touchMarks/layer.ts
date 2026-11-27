import type { NormPoint, PxPoint } from './model'

/** Where a point on the device's screen (0–1) sits in a layer's box, as fractions of it. */
export type PlaceOnLayer = (x: number, y: number) => { left: number; top: number }

/**
 * How far the canvas reaches past the box on each side, in CSS px: a mark near an edge — a tap's widening ring, the
 * shadow — is drawn past it, as an SVG with visible overflow was. The ripple's widest is 39.5 px, by then all but faded.
 */
export const BLEED = 40

/**
 * A screen point to the canvas's CSS pixels, for a canvas `cssW` × `cssH` that bleeds past its box: placement is in the
 * box, drawing anywhere on the canvas. The one conversion the drawing uses, exported so a test can hold it — the canvas
 * itself has nothing a test's DOM can read (review: dropping the bleed passed every test).
 */
export function layerPoint(place: PlaceOnLayer, cssW: number, cssH: number): (p: NormPoint) => PxPoint {
  const w = cssW - 2 * BLEED
  const h = cssH - 2 * BLEED
  return (p) => { const q = place(p.x, p.y); return { x: BLEED + q.left * w, y: BLEED + q.top * h } }
}
