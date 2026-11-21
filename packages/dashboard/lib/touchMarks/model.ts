import type { Point } from '@tapflowio/protocol'

/**
 * What a touch looks like on the device, as one model for every place one is drawn: the QA viewer's own pointer (live
 * and in its recording), an AI agent's touches in the watch view, and Flow Capture's — its Match and Verify replays and
 * its step pictures. **The motion is the same everywhere; the colour says which surface it is on**: white on Manual QA,
 * where a person drives the device, blue in Flow Capture and on an AI agent's watch page (user, 2026-11-21). The
 * constants below are the user's Figma (Medium, node 4564:1730).
 *
 * Pure: a state and a time in, the parts to draw out, in the caller's pixels (`toPx`). Points stay in the device
 * screen's own space (0–1, the input's space) until then, so one state serves an overlay and a recording alike.
 */

/** A point on the device's screen, as fractions of it — the space input is sent in (protocol's `Point`). */
export type NormPoint = Point
/** A point in the pixels the caller draws in: the same shape, named apart so the two spaces read apart. */
export type PxPoint = Point

/**
 * The surface's colour: `person` on Manual QA (white: a light grey fill in a white border), `machine` in Flow Capture and
 * on an AI agent's watch page (blue).
 * Chosen by the surface, not by who made each touch: Flow Capture's step pictures show a person's recorded touches and
 * are blue, so one dialog never mixes the two (user, 2026-11-21).
 */
export type TouchTone = 'person' | 'machine'

/**
 * Radii are to a disc's outer edge, its border inside them — the user's Figma (Medium, node 4564:1730): a tap 27 px
 * across. The swipe's moving dot is 19 where Figma has 15, made larger beside Revyl's, where 15 read as a speck (user,
 * 2026-11-21). The hover has no frame there; it stays a little larger than the press, as before.
 */
export const TOUCH_MARK = {
  /** The disc a pointer shows before it presses, and each finger of a pinch while Option is held. */
  hoverR: 15.5,
  /** A press tightens the disc to this. A swipe's start keeps it, faint. */
  dotR: 13.5,
  /** A moving finger's dot, once it has shrunk. */
  endR: 9.5,
  /** Travel before a press splits into a faint start and a moving dot: under it, the press is a tap. */
  splitPx: 4,
  /** Travel over which the moving dot shrinks from `dotR` to `endR`. */
  shrinkPx: 24,
  /** A press tightening from the hover disc. */
  growMs: 80,
  /** A tap's release: a ring widening by `rippleGrowPx` as it fades. */
  rippleMs: 350,
  rippleGrowPx: 26,
  /** A swipe or a pinch is held whole this long after the lift, then goes at once — no fade (user: a fade read as lag). */
  holdMs: 200,
  /** A machine's tap is held this long, or for its own `holdMs` when longer — a long press — up to `maxGestureMs`. */
  tapMs: 110,
  /**
   * The longest a machine's gesture is drawn — a long press's hold, a swipe's or a pinch's own length — so a finger
   * stuck down does not hold a mark for minutes. One cap for all three (user, 2026-11-21): a 1 s cap on swipes and
   * pinches drew a 2 s pinch in half its time once the relay told the length (review of #1205).
   */
  maxGestureMs: 3000,
  /** The shortest a machine's swipe or pinch is drawn, so a fling is not over in a frame. */
  minStrokeMs: 150,
  /** A machine's swipe starts moving this long after its press. */
  swipeLeadMs: 60,
  /** A machine's swipe with no duration of its own is drawn over this. */
  swipeMs: 400,
  /** The start, faint, so the direction reads at a glance. */
  startAlpha: 0.6,
  /** The line's opacity at its start and at the finger. */
  lineFrom: 0.6,
  lineTo: 1,
} as const

/** One finger of a touch: where it went down, where it is, and the farthest it has been from where it went down. */
export interface Finger { start: NormPoint; cur: NormPoint; far: NormPoint }
/** A press, from down to (once lifted) up, on the caller's clock (`performance.now()`). */
export interface Touch { fingers: Finger[]; downAt: number; upAt: number | null }
/** What is on the screen: the hover discs (none, one, or a pinch's two), and the touch being drawn. */
export interface TouchState { hover: NormPoint[]; touch: Touch | null }

export const NO_TOUCH: TouchState = { hover: [], touch: null }

/**
 * A disc (hover, press, a swipe's start, its moving finger), a ring (a tap's release), or the line between. `glass` is
 * the moving finger's dot: a lighter fill over what is under it, blurred.
 */
export type TouchPart =
  | { kind: 'disc'; at: PxPoint; r: number; alpha?: number; glass?: true }
  | { kind: 'ring'; at: PxPoint; r: number; alpha: number }
  | { kind: 'line'; from: PxPoint; to: PxPoint }

export interface TouchOptions {
  /** Prefers reduced motion: no tightening, ripple or shrinking; a swipe's end shows for the hold, then goes. */
  reduced?: boolean
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const dist = (a: PxPoint, b: PxPoint) => Math.hypot(a.x - b.x, a.y - b.y)

/** How far a finger has been from where it went down, in the caller's pixels. */
function travelled(f: Finger, toPx: (p: NormPoint) => PxPoint): number {
  return dist(toPx(f.far), toPx(f.start))
}

/** Whether any finger of a touch has moved far enough to be a swipe or a pinch rather than a tap. */
function moved(touch: Touch, toPx: (p: NormPoint) => PxPoint): boolean {
  return touch.fingers.some((f) => travelled(f, toPx) > TOUCH_MARK.splitPx)
}

/** Whether a lifted touch has nothing left to draw at `now`. */
export function touchDone(touch: Touch, now: number, toPx: (p: NormPoint) => PxPoint, opts: TouchOptions = {}): boolean {
  if (touch.upAt === null) return false
  const after = now - touch.upAt
  if (moved(touch, toPx)) return after > TOUCH_MARK.holdMs
  return opts.reduced ? true : after >= TOUCH_MARK.rippleMs
}

function fingerParts(f: Finger, touch: Touch, now: number, toPx: (p: NormPoint) => PxPoint, opts: TouchOptions): TouchPart[] {
  const M = TOUCH_MARK
  const start = toPx(f.start)
  const cur = toPx(f.cur)
  const far = travelled(f, toPx)
  if (far <= M.splitPx) {
    if (touch.upAt === null) {
      const grow = opts.reduced ? 1 : clamp01((now - touch.downAt) / M.growMs)
      return [{ kind: 'disc', at: start, r: M.hoverR + (M.dotR - M.hoverR) * grow }]
    }
    if (opts.reduced) return []
    const u = clamp01((now - touch.upAt) / M.rippleMs)
    return u >= 1 ? [] : [{ kind: 'ring', at: start, r: M.dotR + M.rippleGrowPx * u, alpha: 1 - u }]
  }
  const shrink = clamp01(far / M.shrinkPx)
  const endR = opts.reduced ? M.endR : M.dotR + (M.endR - M.dotR) * shrink
  const parts: TouchPart[] = []
  // From the start's centre, seen through its faint disc, to under the finger's dot: it shows from the moment they split.
  if (dist(start, cur) > 1) parts.push({ kind: 'line', from: start, to: cur })
  parts.push({ kind: 'disc', at: start, r: M.dotR, alpha: M.startAlpha })
  parts.push({ kind: 'disc', at: cur, r: endR, glass: true })
  return parts
}

/**
 * The parts to draw at `now`. A touch being drawn hides the hover discs: they come back once it is done, where the
 * pointer then is.
 */
export function touchParts(state: TouchState, now: number, toPx: (p: NormPoint) => PxPoint, opts: TouchOptions = {}): TouchPart[] {
  const touch = state.touch
  if (touch && !touchDone(touch, now, toPx, opts)) {
    // A swipe that ended is held whole, then gone at once: it is not drawn shrinking back while held.
    return touch.fingers.flatMap((f) => fingerParts(f, touch, now, toPx, opts))
  }
  return state.hover.map((p) => ({ kind: 'disc' as const, at: toPx(p), r: TOUCH_MARK.hoverR }))
}

/** A touch to draw on a still picture: a tap's point, a swipe's two ends, or a pinch's two fingers' ends. */
export type StillTouch =
  | { kind: 'tap'; point: NormPoint }
  | { kind: 'swipe'; from: NormPoint; to: NormPoint }
  | { kind: 'pinch'; from: Pair; to: Pair }

/** A pinch's two fingers. */
export type Pair = [NormPoint, NormPoint]

/** A still picture's mark: the frame just before the finger lifted — a pressed dot, or a swipe's (or a pinch's two) whole lines. */
export function stillParts(mark: StillTouch, toPx: (p: NormPoint) => PxPoint): TouchPart[] {
  const fingers: Finger[] = mark.kind === 'tap'
    ? [{ start: mark.point, cur: mark.point, far: mark.point }]
    : strokes(mark).map(([from, to]) => ({ start: from, cur: to, far: to }))
  return touchParts({ hover: [], touch: { fingers, downAt: 0, upAt: null } }, 0, toPx, { reduced: true })
}

/** A swipe's one stroke, or a pinch's two: each finger from where it went down to where it lifted. */
function strokes(m: { kind: 'swipe'; from: NormPoint; to: NormPoint } | { kind: 'pinch'; from: Pair; to: Pair }): [NormPoint, NormPoint][] {
  return m.kind === 'swipe' ? [[m.from, m.to]] : [[m.from[0], m.to[0]], [m.from[1], m.to[1]]]
}

/**
 * A machine's touch, to be played from `at` (the caller's clock when it learned of it). It has no pointer to follow,
 * so the motion is made here: the press, and for a swipe the finger moving from one end to the other.
 *
 * **Pressed the moment it arrives, with no hover first.** A touch reaches the page once it has already gone to the
 * device — the relay tells watchers after passing the input on, and Flow Capture's replay sends the tap on the next
 * line — so a hover before the press drew the press 300 ms after the device had reacted, over the screen it brought
 * (pre-PR review; user, 2026-11-21).
 */
export type MachineTouch = {
  id: number
  at: number
  /** `'frame'`: the points are of the video frame as it arrives, not the screen — a body-mode holder's (protocol
   *  `PointSpace`). The surface places them; the motion is the same. */
  space?: 'frame'
} & (
  | { kind: 'tap'; point: NormPoint; holdMs?: number }
  | { kind: 'swipe'; from: NormPoint; to: NormPoint; durationMs?: number }
  | { kind: 'pinch'; from: Pair; to: Pair; durationMs?: number }
)

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2)

function swipeMs(m: Extract<MachineTouch, { kind: 'swipe' | 'pinch' }>): number {
  return Math.min(TOUCH_MARK.maxGestureMs, Math.max(TOUCH_MARK.minStrokeMs, m.durationMs ?? TOUCH_MARK.swipeMs))
}

/**
 * When a machine's touch has nothing left to draw. A swipe allows for a ripple too: one that moves no more than the
 * split in the layer's pixels is drawn as a tap, and stopping at its hold left the ring frozen mid-widening.
 */
export function machineTouchEnd(m: MachineTouch): number {
  return m.kind === 'tap'
    ? m.at + holdOf(m) + TOUCH_MARK.rippleMs
    : m.at + TOUCH_MARK.swipeLeadMs + swipeMs(m) + Math.max(TOUCH_MARK.holdMs, TOUCH_MARK.rippleMs)
}

/** How long a machine's tap is held: the usual press, or a long press's own hold (user: a tap, held for its duration). */
function holdOf(m: Extract<MachineTouch, { kind: 'tap' }>): number {
  return Math.max(TOUCH_MARK.tapMs, Math.min(TOUCH_MARK.maxGestureMs, m.holdMs ?? 0))
}

/** What a machine's touch shows at `now`. A pinch is two fingers, each moving as a swipe does. */
export function machineState(m: MachineTouch, now: number): TouchState {
  const press = m.at
  if (now < press) return NO_TOUCH
  if (m.kind === 'tap') {
    const up = press + holdOf(m)
    const p = m.point
    return { hover: [], touch: { fingers: [{ start: p, cur: p, far: p }], downAt: press, upAt: now >= up ? up : null } }
  }
  const moveAt = press + TOUCH_MARK.swipeLeadMs
  const ms = swipeMs(m)
  const u = ease(clamp01((now - moveAt) / ms))
  // At the end it is the end itself, not the arithmetic's nearest: the mark sits where the stroke really lifted.
  const fingers = strokes(m).map(([from, to]) => {
    const cur = u >= 1 ? to : { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }
    return { start: from, cur, far: cur }
  })
  const up = moveAt + ms
  return { hover: [], touch: { fingers, downAt: press, upAt: now >= up ? up : null } }
}
