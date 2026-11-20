import { useEffect, useRef, useState } from 'react'
import {
  BLEED, TouchMarkStore, drawTouchParts, layerPoint, prefersReducedMotion, stillParts, touchDone, touchParts,
  type MachineTouch, type NormPoint, type PlaceOnLayer, type StillTouch, type TouchState, type TouchTone,
} from '@/lib/touchMarks'

/** What the layer draws: a person's live pointer, a machine's latest touch, or a still picture's mark. */
export type TouchMarksSource =
  | { store: TouchMarkStore; touch?: never; still?: never }
  | { touch: MachineTouch | null; store?: never; still?: never }
  | { still: StillTouch | null; store?: never; touch?: never }

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

/**
 * The one place a touch is drawn over a device or a picture of one: the QA viewer's pointer (`store`), an agent's or a
 * replay's touches (`touch`), and a step picture's mark (`still`). A canvas, drawn by `drawTouchParts` — the same call
 * the QA viewer's recording makes, so a video shows what the page did.
 *
 * Draws only when something changes and while something moves on its own; a hover disc that sits still costs nothing.
 * Under the stalled-stream notice (z 8), so nothing here suggests live input on a picture the page says has stopped.
 */
export function TouchMarksLayer({ tone, place, store, touch, still }: { tone: TouchTone; place: PlaceOnLayer } & TouchMarksSource) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [own] = useState(() => new TouchMarkStore())
  const source = store ?? own
  // Read on every frame rather than restarting the loop: a caller builds `place` on each render.
  const placeRef = useRef(place)
  useEffect(() => { placeRef.current = place })

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
        if (mark) drawTouchParts(ctx, stillParts(mark, toPx), tone, dpr)
        return
      }
      const now = performance.now()
      const opts = { reduced: prefersReducedMotion() }
      const shown = source.stateAt(now)
      if (shown.touch && touchDone(shown.touch, now, toPx, opts)) source.dropFinished()
      drawTouchParts(ctx, touchParts(source.stateAt(now), now, toPx, opts), tone, dpr)
      if (source.animating(now)) frame = requestAnimationFrame(draw)
    }
    const wake = () => {
      // A live pointer's anchors are kept on the element as it moves; a machine's and a still mark's come from props.
      if (store) {
        const a = anchorsOf(shownPoints(store.stateAt(performance.now())), placeRef.current)
        if (a) c.dataset.anchor = a
        else delete c.dataset.anchor
      }
      if (!frame) frame = requestAnimationFrame(draw)
    }
    wake()
    const unsubscribe = source.subscribe(wake)
    const resize = new ResizeObserver(wake)
    resize.observe(c)
    return () => { unsubscribe(); resize.disconnect(); cancelAnimationFrame(frame) }
  }, [source, store, tone, isStill, stillKey])

  const anchor = still ? (still.kind === 'tap' ? still.point : still.from)
    : touch ? (touch.kind === 'tap' ? touch.point : touch.from) : undefined
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="touch-marks"
      data-tone={tone}
      data-anchor={anchor ? anchorsOf([anchor], place) : undefined}
      className="pointer-events-none absolute"
      style={{ zIndex: 5, inset: -BLEED, width: `calc(100% + ${2 * BLEED}px)`, height: `calc(100% + ${2 * BLEED}px)` }}
    />
  )
}
