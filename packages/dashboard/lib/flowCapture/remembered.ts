import type { RawStep, ScreenRect } from '@tapflowio/flow-runner/browser'
import { toFramePoint, type InterfaceTurn } from '@tapflowio/protocol/screen'

/** A stop the person went on from with Continue anyway (R6): where it differed, on which step's screen. */
export interface Accepted {
  /** Into `steps`. */
  index: number
  /** That step's recorded picture: what a later step's is held against to tell whether it is the same screen. */
  recordedUrl: string
  areas: ScreenRect[]
  /** Most of the screen differed (R5): that step is not compared again, and nothing is carried from it. */
  mostly: boolean
}

/** What an earlier Continue anyway says about a step: not compared at all, these areas left out, or nothing. */
export type Carried = 'skip' | { areas: ScreenRect[]; from: number } | null

/** Over this share of the picture, areas are not carried to another step's screen: what is left to tell the two screens
 *  apart by is mostly the bars every screen of the app shares, which read alike across different screens (design review
 *  of (c): an orders list with its rows set aside read as its detail page). */
export const MAX_CARRIED_SHARE = 0.25

/**
 * What Continue anyway accepted, for every Match of one capture (R6 revised). An area is carried to a later step only
 * when that step's recorded picture is the accepted step's screen — pixel for pixel outside the areas (`alike`, the
 * check made for the grid's blindness to text, #1171) — and never over the point the step touches, so its target is
 * still compared. At the step it was accepted at, the person's own word holds whatever it covers.
 *
 * Applied only where Match decides to stop, after the mid-transition rule, which judges the screen as compared (design
 * review of (c)). A step let go on this way is not looked at again, nor is the tap before it pressed again.
 */
export class Remembered {
  private accepted: Accepted[] = []
  private verdicts = new Map<string, Promise<boolean>>()
  private start: number | undefined

  constructor(private readonly alike: (a: string, b: string, masks: ScreenRect[], signal?: AbortSignal) => Promise<boolean>) {}

  /** A Match from another start forgets: what was accepted was of the screens the old start led to, and a different
   *  start is the remedy a mostly different screen points at (review of (c)). */
  begin(start: number): void {
    if (this.start !== start) {
      this.accepted = []
      this.verdicts.clear()
    }
    this.start = start
  }

  accept(entry: Accepted): void {
    this.accepted.push(entry)
  }

  async carried(index: number, step: RawStep, recordedUrl: string | null, masks: ScreenRect[], turn: InterfaceTurn | undefined, signal?: AbortSignal): Promise<Carried> {
    const same = this.accepted.filter((e) => e.index === index)
    if (same.some((e) => e.mostly)) return 'skip'
    const areas = same.flatMap((e) => e.areas)
    let from = same.length > 0 ? index : undefined
    const point = touchPointOf(step, turn)
    // Held to the cap together, not entry by entry: three areas of a fifth each leave the same bars to judge by.
    let others = 0
    for (const e of this.accepted) {
      if (e.index === index || e.mostly || !recordedUrl) continue
      const kept = point ? e.areas.filter((a) => !contains(a, point)) : e.areas
      if (kept.length === 0 || others + coverage(kept) > MAX_CARRIED_SHARE) continue
      if (!(await this.verdict(e, index, recordedUrl, masks, signal))) continue
      others += coverage(kept)
      areas.push(...kept)
      from = Math.min(from ?? e.index, e.index)
    }
    return areas.length > 0 && from !== undefined ? { areas, from } : null
  }

  /** Asked once per accepted stop and step: Match compares a step up to twenty times while it waits for the screen. Keyed
   *  by the stop, not its step, since two stops at one step set different areas aside (CodeRabbit on #1177). An answer
   *  cut short by Stop is not kept as one. */
  private verdict(e: Accepted, index: number, recordedUrl: string, masks: ScreenRect[], signal?: AbortSignal): Promise<boolean> {
    const key = `${this.accepted.indexOf(e)}:${index}`
    const known = this.verdicts.get(key)
    if (known) return known
    const asked = this.alike(e.recordedUrl, recordedUrl, [...masks, ...e.areas], signal).catch(() => false)
    this.verdicts.set(key, asked)
    void asked.then(() => { if (signal?.aborted && this.verdicts.get(key) === asked) this.verdicts.delete(key) })
    return asked
  }
}

/** Where the step touches, in the picture's space: turned by `turn` (none for iOS, whose touches are in the portrait
 *  framebuffer the picture is), unless it was made in the frame. */
function touchPointOf(step: RawStep, turn: InterfaceTurn | undefined): [number, number] | null {
  if (step.kind !== 'tap' && step.kind !== 'longPress' && step.kind !== 'swipe' && step.kind !== 'holdDrag') return null
  const p = step.kind === 'tap' || step.kind === 'longPress' ? step.point : step.from
  return step.space === 'frame' ? [p[0], p[1]] : toFramePoint(turn, [p[0], p[1]])
}

const contains = (r: ScreenRect, [x, y]: [number, number]): boolean => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height

const coverage = (areas: ScreenRect[]): number => areas.reduce((sum, a) => sum + a.width * a.height, 0)
