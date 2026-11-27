import { useEffect, useRef, useState } from 'react'
import {
  BLEED, GLASS_BLUR, TOUCH_BORDER, TouchMarkStore, drawTouchParts, layerPoint, prefersReducedMotion, stillParts,
  timelineState, touchDone, touchParts, type MachineTouch, type NormPoint, type PlaceOnLayer, type StillTouch,
  type TouchPart, type TouchState, type TouchTimeline, type TouchTone,
} from '@/lib/touchMarks'

/** What the layer draws: a person's live pointer, a machine's latest touch, a still picture's mark, or a recording's. */
export type TouchMarksSource =
  | { store: TouchMarkStore; touch?: never; still?: never; timeline?: never }
  | { touch: MachineTouch | null; store?: never; still?: never; timeline?: never }
  | { still: StillTouch | null; store?: never; touch?: never; timeline?: never }
  /** A recording's touches on its playback clock: drawn when the clock moves, at its time — never the wall clock, so a
   *  seek back shows a touch again and a pause holds it. */
  | { timeline: TouchTimeline; store?: never; touch?: never; still?: never }

const pct = (n: number) => Math.round(n * 10000) / 100

/**
 * Where what is drawn starts, as percentages of the box (`x,y;x,y`): each finger's start, else each hover disc. A canvas
 * has no DOM to query, so this is what a test reads — that a mark sits under the pointer is the point of placement.
 */
function anchorsOf(points: NormPoint[], place: PlaceOnLayer): string | undefined {
  if (points.length === 0) return undefined
  return points.map((p) => { const q = place(p.x, p.y); return `${pct(q.left)},${pct(q.top)}` }).join(';')
}
const shownPoints = (s: TouchState): NormPoint[] => (s.touch ? s.touch.fingers.map((f) => f.start) : s.hover)

/** At most a pinch's two fingers move at once, so at most two glass dots. */
const GLASSES = 2

/**
 * Puts the CSS backdrop under each glass dot the canvas draws: the canvas cannot read the screen under it, so the blur
 * is the browser's, on an element sitting just under the canvas, where the dot's fill and border are then drawn.
 * It blurs the screen alone: where the dot passes over a swipe's own start, early in the swipe, the start stays sharp
 * here and is blurred in a recording, which blurs its canvas. Kept — the start is a mark, not the screen.
 */
function placeGlass(glass: (HTMLDivElement | null)[], parts: TouchPart[]): void {
  const dots = parts.filter((p) => p.kind === 'disc' && p.glass)
  glass.forEach((el, i) => {
    if (!el) return
    const p = dots[i]
    if (!p || p.kind !== 'disc') { el.style.display = 'none'; return }
    const r = p.r - TOUCH_BORDER
    el.style.display = 'block'
    el.style.width = el.style.height = `${2 * r}px`
    el.style.transform = `translate(${p.at.x - BLEED - r}px, ${p.at.y - BLEED - r}px)`
  })
}

/**
 * The one place a touch is drawn over a device or a picture of one: the QA viewer's pointer (`store`), an agent's or a
 * replay's touches (`touch`), and a step picture's mark (`still`). A canvas, drawn by `drawTouchParts` — the same call
 * the QA viewer's recording makes, so a video shows what the page did.
 *
 * Draws only when something changes and while something moves on its own; a hover disc that sits still costs nothing.
 * Under the stalled-stream notice (z 8), so nothing here suggests live input on a picture the page says has stopped.
 */
export function TouchMarksLayer({ tone, place, store, touch, still, timeline }: { tone: TouchTone; place: PlaceOnLayer } & TouchMarksSource) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const glass = useRef<(HTMLDivElement | null)[]>([])
  const [own] = useState(() => new TouchMarkStore())
  const source = store ?? own
  // Read on every frame rather than restarting the loop: a caller builds `place` on each render.
  const placeRef = useRef(place)
  useEffect(() => { placeRef.current = place })
  // ...but a mapping that really changed is drawn again: a device body turning spins the box by CSS, which leaves its
  // size alone, so no resize redraws it and a mark sat where it was until the pointer moved (review, CodeRabbit). A
  // placement is a turn and a scale, so three corners say whether it changed.
  const placeKey = [place(0, 0), place(1, 0), place(0, 1)].map((q) => `${q.left},${q.top}`).join(';')

  useEffect(() => {
    if (store || touch === undefined) return
    if (touch) own.play(touch)
    else own.clear()
  }, [store, touch, own])

  // A still mark is compared by value: a caller builds it inline, so its identity changes on every render.
  const isStill = still !== undefined
  const stillKey = still ? JSON.stringify(still) : ''
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    // Null where there is no 2D canvas (a test's DOM): nothing is drawn, and the anchors are still kept.
    const ctx = c.getContext('2d')
    const mark: StillTouch | null = stillKey ? JSON.parse(stillKey) as StillTouch : null
    let frame = 0
    const draw = () => {
      frame = 0
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const cssW = c.clientWidth
      const cssH = c.clientHeight
      const cw = Math.round(cssW * dpr)
      const ch = Math.round(cssH * dpr)
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      const toPx = layerPoint(placeRef.current, cssW, cssH)
      if (isStill) {
        const parts = mark ? stillParts(mark, toPx) : []
        drawTouchParts(ctx, parts, tone, dpr)
        placeGlass(glass.current, parts)
        return
      }
      if (timeline) {
        // The clock moves it, frame by frame while it plays: nothing here asks for frames of its own.
        const t = timeline.clock.now()
        const parts = touchParts(timelineState(timeline.touches, t), t, toPx, { reduced: prefersReducedMotion() })
        drawTouchParts(ctx, parts, tone, dpr)
        placeGlass(glass.current, parts)
        return
      }
      source.measureIn(toPx)
      const now = performance.now()
      const opts = { reduced: prefersReducedMotion() }
      const shown = source.stateAt(now)
      if (shown.touch && touchDone(shown.touch, now, toPx, opts)) source.dropFinished()
      const parts = touchParts(source.stateAt(now), now, toPx, opts)
      drawTouchParts(ctx, parts, tone, dpr)
      placeGlass(glass.current, parts)
      if (source.animating(now)) frame = requestAnimationFrame(draw)
    }
    const wake = () => {
      // A live pointer's anchors are kept on the element as it moves; a machine's and a still mark's come from props.
      const live = store ? store.stateAt(performance.now()) : timeline ? timelineState(timeline.touches, timeline.clock.now()) : null
      if (live) {
        const a = anchorsOf(shownPoints(live), placeRef.current)
        if (a) c.dataset.anchor = a
        else delete c.dataset.anchor
      }
      if (!frame) frame = requestAnimationFrame(draw)
    }
    wake()
    const unsubscribe = timeline ? timeline.clock.subscribe(wake) : source.subscribe(wake)
    const resize = new ResizeObserver(wake)
    resize.observe(c)
    return () => { unsubscribe(); resize.disconnect(); cancelAnimationFrame(frame) }
  }, [source, store, timeline, tone, isStill, stillKey, placeKey])

  const mark = still ?? touch
  const anchors = !mark ? [] : mark.kind === 'tap' ? [mark.point] : mark.kind === 'pinch' ? mark.from : [mark.from]
  return (
    <>
      {Array.from({ length: GLASSES }, (_, i) => (
        <div
          key={i}
          ref={(el) => { glass.current[i] = el }}
          aria-hidden="true"
          data-testid="touch-glass"
          className="pointer-events-none absolute left-0 top-0 rounded-full"
          style={{ zIndex: 5, display: 'none', backdropFilter: `blur(${GLASS_BLUR}px)`, WebkitBackdropFilter: `blur(${GLASS_BLUR}px)` }}
        />
      ))}
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="touch-marks"
      data-tone={tone}
      data-anchor={anchorsOf(anchors, place)}
      className="pointer-events-none absolute"
      style={{ zIndex: 5, inset: -BLEED, width: `calc(100% + ${2 * BLEED}px)`, height: `calc(100% + ${2 * BLEED}px)` }}
    />
    </>
  )
}
