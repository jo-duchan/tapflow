import type { Point } from '@tapflowio/protocol'

/**
 * What a touch looks like on the device, as one model for every place one is drawn: a person's own pointer in the QA
 * viewer (live and in its recording), and a machine's touches — an AI agent's in the watch view, Flow Capture's Match
 * and Verify, and their step pictures. **Colour says who touched; the motion is the same for both** (user, 2026-11-21;
 * the agreed mockup's numbers are the constants below).
 *
 * Pure: a state and a time in, the parts to draw out, in the caller's pixels (`toPx`). Points stay in the device
 * screen's own space (0–1, the input's space) until then, so one state serves an overlay and a recording alike.
 */

/** A point on the device's screen, as fractions of it — the space input is sent in (protocol's `Point`). */
export type NormPoint = Point
/** A point in the pixels the caller draws in: the same shape, named apart so the two spaces read apart. */
export type PxPoint = Point

/** Who touched: a person (Manual QA) or a machine (AI agent, Automation, Flow Capture's replays). */
export type TouchTone = 'person' | 'machine'

export const TOUCH_MARK = {
  /** The disc a pointer shows before it presses, and each finger of a pinch while Option is held. */
  hoverR: 14,
  /** A press tightens the disc to this. */
  dotR: 11,
  /** Where a moving finger went down, once it has split from the finger. */
  ringR: 14,
  /** A moving finger's dot, once it has shrunk. */
  endR: 6,
  /** Travel before a press splits into a start ring and a moving dot: under it, the press is a tap. */
  splitPx: 4,
  /** Travel over which the moving dot shrinks from `dotR` to `endR`. */
  shrinkPx: 24,
  /** Travel over which the start ring grows from `dotR` to `ringR`. */
  ringInPx: 6,
  /** A press tightening from the hover disc. */
  growMs: 80,
  /** A tap's release: a ring widening by `rippleGrowPx` as it fades. */
  rippleMs: 350,
  rippleGrowPx: 26,
  /** A swipe or a pinch is held whole this long after the lift, then goes at once — no fade (user: a fade read as lag). */
  holdMs: 200,
  /** A machine's touch shows where it will land this long before it presses, as a person's pointer does. */
  approachMs: 300,
  /** A machine's tap is held this long. */
  tapMs: 110,
  /** A machine's swipe starts moving this long after its press. */
  swipeLeadMs: 60,
  /** A machine's swipe with no duration of its own is drawn over this. */
  swipeMs: 400,
  /** The start ring, faint, so the direction reads at a glance. */
  startAlpha: 0.5,
  /** The line's opacity at its start and at the finger. */
  lineFrom: 0.3,
  lineTo: 0.95,
} as const

/** One finger of a touch: where it went down, where it is, and the farthest it has been from where it went down. */
export interface Finger { start: NormPoint; cur: NormPoint; far: NormPoint }
/** A press, from down to (once lifted) up, on the caller's clock (`performance.now()`). */
export interface Touch { fingers: Finger[]; downAt: number; upAt: number | null }
/** What is on the screen: the hover discs (none, one, or a pinch's two), and the touch being drawn. */
export interface TouchState { hover: NormPoint[]; touch: Touch | null }

export const NO_TOUCH: TouchState = { hover: [], touch: null }

/** A disc (hover, press, a moving finger), a ring (a swipe's start, a tap's release), or the line between. */
export type TouchPart =
  | { kind: 'disc'; at: PxPoint; r: number }
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
  const ringIn = opts.reduced ? 1 : clamp01((far - M.splitPx) / M.ringInPx)
  const parts: TouchPart[] = []
  // From the start's centre, seen through its ring, to under the finger's dot: it shows from the moment they split.
  if (dist(start, cur) > 1) parts.push({ kind: 'line', from: start, to: cur })
  parts.push({ kind: 'ring', at: start, r: M.dotR + (M.ringR - M.dotR) * ringIn, alpha: M.startAlpha })
  parts.push({ kind: 'disc', at: cur, r: endR })
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

/** A touch to draw on a still picture: a tap's point, or a swipe's two ends. */
export type StillTouch = { kind: 'tap'; point: NormPoint } | { kind: 'swipe'; from: NormPoint; to: NormPoint }

/** A still picture's mark: the frame just before the finger lifted — a pressed dot, or a swipe's whole line. */
export function stillParts(mark: StillTouch, toPx: (p: NormPoint) => PxPoint): TouchPart[] {
  const finger: Finger = mark.kind === 'tap'
    ? { start: mark.point, cur: mark.point, far: mark.point }
    : { start: mark.from, cur: mark.to, far: mark.to }
  return touchParts({ hover: [], touch: { fingers: [finger], downAt: 0, upAt: null } }, 0, toPx, { reduced: true })
}

/**
 * A machine's touch, to be played from `at` (the caller's clock when it learned of it). It has no pointer to follow,
 * so the motion is made here: the hover disc where it will land, the press, and for a swipe the finger moving from one
 * end to the other.
 */
export type MachineTouch = { id: number; at: number } & (
  | { kind: 'tap'; point: NormPoint }
  | { kind: 'swipe'; from: NormPoint; to: NormPoint; durationMs?: number }
)

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2)

function swipeMs(m: Extract<MachineTouch, { kind: 'swipe' }>): number {
  return Math.min(1000, Math.max(150, m.durationMs ?? TOUCH_MARK.swipeMs))
}

/** When a machine's touch has nothing left to draw — a moved one's hold, else a tap's ripple. */
export function machineTouchEnd(m: MachineTouch): number {
  const press = m.at + TOUCH_MARK.approachMs
  return m.kind === 'tap'
    ? press + TOUCH_MARK.tapMs + TOUCH_MARK.rippleMs
    : press + TOUCH_MARK.swipeLeadMs + swipeMs(m) + TOUCH_MARK.holdMs
}

/** What a machine's touch shows at `now`. */
export function machineState(m: MachineTouch, now: number): TouchState {
  const press = m.at + TOUCH_MARK.approachMs
  const start = m.kind === 'tap' ? m.point : m.from
  if (now < m.at) return NO_TOUCH
  if (now < press) return { hover: [start], touch: null }
  if (m.kind === 'tap') {
    const up = press + TOUCH_MARK.tapMs
    return { hover: [], touch: { fingers: [{ start, cur: start, far: start }], downAt: press, upAt: now >= up ? up : null } }
  }
  const moveAt = press + TOUCH_MARK.swipeLeadMs
  const ms = swipeMs(m)
  const u = ease(clamp01((now - moveAt) / ms))
  // At the end it is the end itself, not the arithmetic's nearest: the mark sits where the swipe really lifted.
  const cur = u >= 1 ? m.to : { x: m.from.x + (m.to.x - m.from.x) * u, y: m.from.y + (m.to.y - m.from.y) * u }
  const up = moveAt + ms
  return { hover: [], touch: { fingers: [{ start, cur, far: cur }], downAt: press, upAt: now >= up ? up : null } }
}
