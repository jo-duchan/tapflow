import type { Point, PointSpace, WatchActionKind } from '@tapflowio/protocol'

/**
 * What a session's watchers are told the holder did (A2), derived from the input the relay passes on. Pure, so the
 * rules are tested apart from the socket plumbing.
 */

/** A touch that ends within this distance of where it began is a tap; further is a swipe. Normalised 0–1. */
const TAP_RADIUS = 0.02

/**
 * A key as watchers see it. **A key that types a character is not named**: watchers are the whole team, and the
 * keys pressed one by one are the text typed. Keep in step with flow-runner's `activityLabel` (`pressKey`), which
 * applies the same rule to a flow step's name.
 */
export function keyForWatchers(code: string): string {
  return /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal|Comma|Equal|ParenLeft|ParenRight|Hash|Star)|Space|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/.test(code)
    || code.length === 1
    ? 'character'
    : code
}

/** How long the finger was down, and which picture its points are of — what a watcher needs to draw it as it was. */
export interface GestureTiming { ms?: number; space?: PointSpace }

const extras = ({ ms, space }: GestureTiming, key: 'holdMs' | 'durationMs') =>
  ({ ...(ms !== undefined ? { [key]: ms } : {}), ...(space ? { space } : {}) })

/** The gesture a touch made, from where it began (if seen) to where it ended. Null when there is nothing to show. */
export function gestureAction(start: Point | null, end: Point | null, timing: GestureTiming = {}): WatchActionKind | null {
  if (!start) return end ? { kind: 'tap', x: end.x, y: end.y, ...extras({ space: timing.space }, 'holdMs') } : null
  const to = end ?? start
  return Math.hypot(to.x - start.x, to.y - start.y) <= TAP_RADIUS
    ? { kind: 'tap', x: start.x, y: start.y, ...extras(timing, 'holdMs') }
    : { kind: 'swipe', from: [start.x, start.y], to: [to.x, to.y], ...extras(timing, 'durationMs') }
}

/**
 * A pinch's two fingers, from where they went down to where they last were. Null when its start was not seen — a
 * watcher then gets the bare row, as from an older relay. An end carries no points, so the last move is the end.
 */
export function pinchAction(p: { start: [Point, Point]; last: [Point, Point]; at: number; space?: PointSpace } | null, now: number): WatchActionKind {
  if (!p) return { kind: 'pinch' }
  const pair = (f: [Point, Point]): [[number, number], [number, number]] => [[f[0].x, f[0].y], [f[1].x, f[1].y]]
  return { kind: 'pinch', from: pair(p.start), to: pair(p.last), durationMs: now - p.at, ...(p.space ? { space: p.space } : {}) }
}
