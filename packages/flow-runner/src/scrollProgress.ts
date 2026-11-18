import type { UIElement } from '@tapflowio/agent-core'

/**
 * Whether a drag moved a list, read from two trees (`scroll { until }`, #1190). The tree carries no scroll offset, so
 * this is judged from what moved and what changed, and an answer that two reads cannot give is `ambiguous`: the
 * search then reads once more without a gesture and learns which parts of the screen change by themselves.
 *
 * - `moved`: an element both reads hold, the same one (role, identifier and label), travelled the way the finger did.
 *   That is the only evidence of movement there is; everything else is a change to explain.
 * - `still`: nothing changed, or everything that changed is inside a part of the screen seen changing by itself (a
 *   clock, a countdown). An element that travelled against the finger (a pager snapping back, a list's rubber band)
 *   made no progress.
 * - `ambiguous`: something changed and nothing travelled with the finger — content replaced in place (a paged list
 *   reusing its rows, rows moved by exactly the gap between them under a fixed header) or text that changes by itself.
 *   Two reads cannot tell them apart; a third, with no gesture before it, can.
 *
 * Wrong in the `still` direction costs the search an early fling or an early end, which is what skips an element, so
 * every rule here leans to `ambiguous` and the read settles it. What no read can settle: identical unlabelled cells
 * moved by exactly a cell (a snapping grid) give identical trees, and read as still.
 */
export type Progress = 'moved' | 'still' | 'ambiguous'

type Frame = UIElement['frame']
export type Axis = 'x' | 'y'

// A hundredth of the screen: below it, a frame is where it was (the agents' frames jitter by a pixel or two).
const TOL = 0.01

const identity = (e: UIElement): string => JSON.stringify([e.role, e.identifier ?? '', e.label])

interface Shift { dx: number; dy: number }

/**
 * Elements of the same identity in both reads, paired up: a shift when there are as many of them in both and every
 * pair moved by the same amount, otherwise their frames as changes. A label shared by rows whose count changed (one of
 * three "2 min ago" turned "3 min ago") is a change, not a movement.
 */
function compare(before: UIElement[], after: UIElement[]): { shifts: Shift[]; changed: Frame[] } {
  const group = (tree: UIElement[]) => {
    const out = new Map<string, UIElement[]>()
    for (const e of tree) {
      const k = identity(e)
      const bucket = out.get(k)
      if (bucket) bucket.push(e)
      else out.set(k, [e])
    }
    return out
  }
  const was = group(before)
  const now = group(after)
  const shifts: Shift[] = []
  const changed: Frame[] = []
  const order = (a: UIElement, b: UIElement) => a.frame.y - b.frame.y || a.frame.x - b.frame.x
  for (const [k, then] of was) {
    const next = now.get(k)
    if (!next || next.length !== then.length) {
      changed.push(...then.map((e) => e.frame), ...(next ?? []).map((e) => e.frame))
      continue
    }
    const a = [...then].sort(order)
    const b = [...next].sort(order)
    const dx = b[0]!.frame.x - a[0]!.frame.x
    const dy = b[0]!.frame.y - a[0]!.frame.y
    const together = a.every((e, i) => Math.abs(b[i]!.frame.x - e.frame.x - dx) < TOL && Math.abs(b[i]!.frame.y - e.frame.y - dy) < TOL)
    if (together) shifts.push({ dx, dy })
    else changed.push(...a.map((e) => e.frame), ...b.map((e) => e.frame))
  }
  for (const [k, next] of now) if (!was.has(k)) changed.push(...next.map((e) => e.frame))
  return { shifts, changed }
}

/** Inside a learned frame, not merely touching it: a full-screen page swapped for the next one overlaps a clock too. */
function explained(frame: Frame, volatile: readonly Frame[]): boolean {
  return volatile.some((v) => frame.x >= v.x - TOL && frame.y >= v.y - TOL
    && frame.x + frame.width <= v.x + v.width + TOL && frame.y + frame.height <= v.y + v.height + TOL)
}

/**
 * What one gesture did, from the read before it to the read after it. `sign` is the way the finger moved along `axis`
 * (content follows the finger): -1 for a drag up or left.
 */
export function progress(before: UIElement[], after: UIElement[], axis: Axis, sign: number, volatile: readonly Frame[]): Progress {
  const { shifts, changed } = compare(before, after)
  const cross: Axis = axis === 'y' ? 'x' : 'y'
  const along = (s: Shift) => (axis === 'y' ? s.dy : s.dx)
  const across = (s: Shift) => (cross === 'y' ? s.dy : s.dx)
  if (shifts.some((s) => Math.sign(along(s)) === sign && Math.abs(along(s)) >= TOL && Math.abs(across(s)) < TOL)) return 'moved'
  // Across the axis is a change to explain (a carousel's slide in a vertical list), never progress.
  const sideways = shifts.some((s) => Math.abs(across(s)) >= TOL)
  if (!sideways && changed.every((f) => explained(f, volatile))) return 'still'
  return 'ambiguous'
}

/**
 * What changed between two reads with no gesture between them: the frames, or undefined when anything travelled (the
 * screen is still settling, and what moved there is the last gesture, not a clock).
 */
export function selfChange(before: UIElement[], after: UIElement[]): Frame[] | undefined {
  const { shifts, changed } = compare(before, after)
  return shifts.some((s) => Math.abs(s.dx) >= TOL || Math.abs(s.dy) >= TOL) ? undefined : changed
}

/**
 * The frames of `second` that also changed in `first`, in the same place: what changes by itself. Once is not enough,
 * since content a gesture brought finishes arriving by itself too (a page shown as "Loading…" and then filled in, a
 * cross-fade, a description set after an image loads); it changes once and stops. A clock changes again (#1190).
 */
export function changedTwice(first: readonly Frame[], second: readonly Frame[]): Frame[] {
  const same = (a: Frame, b: Frame) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL
    && Math.abs(a.width - b.width) < TOL && Math.abs(a.height - b.height) < TOL
  return second.filter((f) => first.some((g) => same(f, g)))
}
