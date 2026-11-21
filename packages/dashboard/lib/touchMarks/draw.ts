import { TOUCH_MARK, touchParts, type NormPoint, type PxPoint, type TouchOptions, type TouchPart, type TouchState, type TouchTone } from './model'

type Rgb = readonly [number, number, number]

/**
 * The material, from the user's Figma (Medium, node 4564:1730): a translucent fill, a light border inside the disc, and
 * a thin dark shadow both sides of the border's outer edge (`0 0 2px 1px`). Figma drew it at 8 %; 20 % was chosen so
 * the edge holds on a white screen (user, 2026-11-21, mockup row "G · 그림자 20%"). The border is 1 px where Figma has
 * 2, and the moving dot's backdrop blur 3 px where it has 1, both set beside Revyl's marks (user, 2026-11-21): 2 px
 * read heavy, and 1 px of blur did not read as glass.
 *
 * The fill is the tone: light grey for a person, blue for a machine. **The border and the shadow are what keep either
 * one on any screen**: the fill and the shadow carry it on white, the border on black — one of the three always differs
 * from what is under it, as a pointer cursor's fill, outline and shadow do.
 *
 * A machine's are blue too, not white and black: a white ring on a blue dot read as two colours, and a navy shadow at a
 * quarter's strength read grey on white (user, 2026-11-21). blue-300 for the border, blue-600 at 35 % for the shadow.
 * A screen as blue as the border is the one place it fades, and the user judged that rare.
 */
const TONES: Record<TouchTone, { fill: Rgb; line: Rgb; border: string; shadow: string; lineShadow: string }> = {
  person: { fill: [228, 228, 228], line: [255, 255, 255], border: '#fff', shadow: 'rgba(0,0,0,0.2)', lineShadow: 'rgba(0,0,0,0.4)' },
  machine: { fill: [59, 130, 246], line: [96, 165, 250], border: '#93c5fd', shadow: 'rgba(37,99,235,0.35)', lineShadow: 'rgba(37,99,235,0.55)' },
}
const FILL_A = 0.8
/** A moving finger's dot is lighter, and shows what is under it blurred. */
const GLASS_A = 0.4
/** The border, inside a disc's radius. */
export const TOUCH_BORDER = 1
const BORDER = TOUCH_BORDER
/** A box-shadow's 2 px blur is a Gaussian of σ 1; a canvas `shadowBlur` of 2 is the same. */
const SHADOW_BLUR = 2
const LINE_W = 1.5
/** The glass dot's backdrop blur, in the same units as the parts. */
export const GLASS_BLUR = 3

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`

function circle(ctx: CanvasRenderingContext2D, at: PxPoint, r: number): void {
  ctx.beginPath(); ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
}

/** The shadow outside a disc: a circle one unit larger (the spread), blurred, cut away where the disc is. */
function outerShadow(ctx: CanvasRenderingContext2D, at: PxPoint, r: number, shadow: string, pxScale: number): void {
  ctx.save()
  const reach = r + 8
  ctx.beginPath(); ctx.rect(at.x - reach, at.y - reach, 2 * reach, 2 * reach); ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
  ctx.clip('evenodd')
  circle(ctx, at, r + 1)
  ctx.fillStyle = shadow; ctx.shadowColor = shadow; ctx.shadowBlur = SHADOW_BLUR * pxScale
  ctx.fill()
  ctx.restore()
}

/** The same shadow inside the border's outer edge. */
function innerShadow(ctx: CanvasRenderingContext2D, at: PxPoint, r: number, shadow: string, pxScale: number): void {
  ctx.save()
  circle(ctx, at, r); ctx.clip()
  circle(ctx, at, r + 1)
  ctx.strokeStyle = shadow; ctx.lineWidth = 2; ctx.shadowColor = shadow; ctx.shadowBlur = SHADOW_BLUR * pxScale
  ctx.stroke()
  ctx.restore()
}

function border(ctx: CanvasRenderingContext2D, at: PxPoint, r: number, color: string): void {
  circle(ctx, at, r - BORDER / 2)
  ctx.strokeStyle = color; ctx.lineWidth = BORDER
  ctx.stroke()
}

/** Clips to everywhere but the given discs, over the reach of a line between `a` and `b`. */
function clipOut(ctx: CanvasRenderingContext2D, a: PxPoint, b: PxPoint, discs: { at: PxPoint; r: number }[]): void {
  const pad = Math.max(...discs.map((d) => d.r)) + 8
  const x = Math.min(a.x, b.x, ...discs.map((d) => d.at.x)) - pad
  const y = Math.min(a.y, b.y, ...discs.map((d) => d.at.y)) - pad
  const w = Math.max(a.x, b.x, ...discs.map((d) => d.at.x)) + pad - x
  const h = Math.max(a.y, b.y, ...discs.map((d) => d.at.y)) + pad - y
  // One clip per disc: a single even-odd path over two overlapping discs — a pinch's fingers close together — counts
  // their overlap three times and lets the line back in there (review).
  for (const d of discs) {
    // A subpath of its own, or the arc is joined to the rect's corner by an edge that can leave a seam.
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.moveTo(d.at.x + d.r, d.at.y); ctx.arc(d.at.x, d.at.y, d.r, 0, Math.PI * 2)
    ctx.clip('evenodd')
  }
}

/**
 * Blurs what the canvas already holds under a disc: a recording draws the device's frame first, so the glass dot's
 * backdrop is right there. A live layer has nothing under it on its own canvas — it blurs with CSS instead
 * (`TouchMarksLayer`). Positions go through the context's transform, which a recording rotates.
 *
 * The canvas is drawn onto itself, which the platform does from a snapshot: a copy through a second, small canvas read
 * the frame back from the GPU on every recorded frame (review). Where canvas `filter` is unsupported the copy lands on
 * the same pixels unblurred — the glass is then a lighter dot, and nothing worse.
 */
function blurUnder(ctx: CanvasRenderingContext2D, at: PxPoint, r: number, pxScale: number): void {
  if (typeof ctx.getTransform !== 'function') return
  const m = ctx.getTransform()
  const k = Math.hypot(m.a, m.b)
  const cx = m.a * at.x + m.c * at.y + m.e
  const cy = m.b * at.x + m.d * at.y + m.f
  const pad = Math.ceil(r * k + 4 * GLASS_BLUR * pxScale)
  const sx = Math.floor(cx - pad); const sy = Math.floor(cy - pad); const size = 2 * pad
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.beginPath(); ctx.arc(cx, cy, (r - BORDER) * k, 0, Math.PI * 2); ctx.clip()
  ctx.filter = `blur(${GLASS_BLUR * pxScale}px)`
  ctx.drawImage(ctx.canvas, sx, sy, size, size, sx, sy, size, size)
  ctx.restore()
}

export interface DrawOptions {
  /** Blur what the canvas holds under a glass dot — for a recording, which drew the device's frame first. */
  backdrop?: boolean
}

/**
 * Draws touch parts on a canvas, in whatever space its transform is set to. `pxScale` is how many canvas pixels one
 * of those units is: a canvas shadow and filter ignore the transform, so they are scaled by hand.
 */
export function drawTouchParts(
  ctx: CanvasRenderingContext2D, parts: TouchPart[], tone: TouchTone, pxScale = 1, opts: DrawOptions = {},
): void {
  const T = TONES[tone]
  const glass = parts.filter((p): p is Extract<TouchPart, { kind: 'disc' }> => p.kind === 'disc' && p.glass === true)
  for (const p of parts) {
    ctx.save()
    if (p.kind === 'line') {
      // Not inside a glass dot: its blur is of what lies under the marks, and on the live page that is the screen
      // alone — a CSS backdrop under the canvas — so a line drawn through it stayed sharp there (user, 2026-11-21).
      // Cut at the dot's edge, the line ends where Figma's blurred one fades out, on the page and in a recording alike.
      if (glass.length > 0) clipOut(ctx, p.from, p.to, glass)
      const g = ctx.createLinearGradient(p.from.x, p.from.y, p.to.x, p.to.y)
      g.addColorStop(0, rgba(T.line, TOUCH_MARK.lineFrom))
      g.addColorStop(1, rgba(T.line, TOUCH_MARK.lineTo))
      ctx.strokeStyle = g
      ctx.lineWidth = LINE_W
      ctx.lineCap = 'round'
      ctx.shadowColor = T.lineShadow
      ctx.shadowBlur = SHADOW_BLUR * pxScale
      ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(p.to.x, p.to.y); ctx.stroke()
    } else {
      // A tap's release is the border alone, widening as it fades; every other disc is filled.
      ctx.globalAlpha = p.alpha ?? 1
      if (p.kind === 'disc' && p.glass && opts.backdrop) blurUnder(ctx, p.at, p.r, pxScale)
      outerShadow(ctx, p.at, p.r, T.shadow, pxScale)
      if (p.kind === 'disc') {
        circle(ctx, p.at, p.r - BORDER)
        ctx.fillStyle = rgba(T.fill, p.glass ? GLASS_A : FILL_A)
        ctx.fill()
      }
      border(ctx, p.at, p.r, T.border)
      innerShadow(ctx, p.at, p.r, T.shadow, pxScale)
    }
    ctx.restore()
  }
}

/** A touch state drawn at `now`: the model and the renderer in one call, for a live overlay and a recording alike. */
export function drawTouchState(
  ctx: CanvasRenderingContext2D, state: TouchState, now: number, toPx: (p: NormPoint) => PxPoint,
  tone: TouchTone, opts: TouchOptions = {}, pxScale = 1, draw: DrawOptions = {},
): void {
  drawTouchParts(ctx, touchParts(state, now, toPx, opts), tone, pxScale, draw)
}

/** Whether the viewer asked for less motion. Read per frame, so changing the setting applies without a reload. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}
