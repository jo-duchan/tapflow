import { TOUCH_MARK, touchParts, type NormPoint, type PxPoint, type TouchOptions, type TouchPart, type TouchState, type TouchTone } from './model'

/**
 * The material, per tone: a flat translucent fill (no highlight — at any size a lit centre read as a smudge), a bright
 * rim, a soft glow in the tone's own colour, and a faint dark shadow so it still reads on a white screen. White for a
 * person, blue for a machine (Tailwind blue-500 fill and glow, blue-400 rim and line).
 */
const TONES: Record<TouchTone, { fill: string; rim: readonly [number, number, number]; glow: string }> = {
  person: { fill: 'rgba(255,255,255,0.5)', rim: [255, 255, 255], glow: 'rgba(255,255,255,0.55)' },
  machine: { fill: 'rgba(59,130,246,0.6)', rim: [96, 165, 250], glow: 'rgba(59,130,246,0.75)' },
}
const RIM_A = 0.95
const RIM_W = 1.5
const LINE_W = 2
/** Canvas blur is about twice an SVG `stdDeviation`: these are the mockup's 2.5 px glow and 1.2 px shadow. */
const GLOW_BLUR = 5
const SHADOW_BLUR = 2.4

const rgba = ([r, g, b]: readonly [number, number, number], a: number) => `rgba(${r},${g},${b},${a})`

/**
 * Draws touch parts on a canvas, in whatever space its transform is set to. `pxScale` is how many canvas pixels one
 * of those units is: a canvas shadow ignores the transform, so the glow is scaled by hand.
 */
export function drawTouchParts(ctx: CanvasRenderingContext2D, parts: TouchPart[], tone: TouchTone, pxScale = 1): void {
  const T = TONES[tone]
  for (const p of parts) {
    ctx.save()
    if (p.kind === 'line') {
      const g = ctx.createLinearGradient(p.from.x, p.from.y, p.to.x, p.to.y)
      g.addColorStop(0, rgba(T.rim, TOUCH_MARK.lineFrom))
      g.addColorStop(1, rgba(T.rim, TOUCH_MARK.lineTo))
      ctx.strokeStyle = g
      ctx.lineWidth = LINE_W
      ctx.lineCap = 'round'
      ctx.shadowColor = T.glow
      ctx.shadowBlur = GLOW_BLUR * pxScale
      ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(p.to.x, p.to.y); ctx.stroke()
    } else {
      if (p.kind === 'ring') ctx.globalAlpha = p.alpha
      ctx.beginPath(); ctx.arc(p.at.x, p.at.y, p.r, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(T.rim, RIM_A)
      ctx.lineWidth = RIM_W
      // The dark shadow on the rim alone: a second fill would double the fill's opacity.
      ctx.shadowColor = 'rgba(0,0,0,0.22)'
      ctx.shadowBlur = SHADOW_BLUR * pxScale
      ctx.shadowOffsetY = pxScale
      ctx.stroke()
      ctx.shadowColor = T.glow
      ctx.shadowBlur = GLOW_BLUR * pxScale
      ctx.shadowOffsetY = 0
      ctx.fillStyle = T.fill
      // A ring is mostly rim: its fill is a tint, so what is under it still shows.
      if (p.kind === 'ring') ctx.globalAlpha = p.alpha * 0.35
      ctx.fill()
      if (p.kind === 'ring') ctx.globalAlpha = p.alpha
      ctx.stroke()
    }
    ctx.restore()
  }
}

/** A touch state drawn at `now`: the model and the renderer in one call, for a live overlay and a recording alike. */
export function drawTouchState(
  ctx: CanvasRenderingContext2D, state: TouchState, now: number, toPx: (p: NormPoint) => PxPoint,
  tone: TouchTone, opts: TouchOptions = {}, pxScale = 1,
): void {
  drawTouchParts(ctx, touchParts(state, now, toPx, opts), tone, pxScale)
}

/** Whether the viewer asked for less motion. Read per frame, so changing the setting applies without a reload. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}
