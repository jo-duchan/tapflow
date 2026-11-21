import { NO_TOUCH, TOUCH_MARK, machineState, machineTouchEnd, type MachineTouch, type NormPoint, type PxPoint, type TouchState } from './model'

const now = () => performance.now()
/** Distance in the screen's own fractions: right only on a square screen, so it stands in until the drawing measures. */
const inFractions = (a: NormPoint, b: NormPoint) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * What is touching the screen right now, held outside React: a pointer moves at the display's rate, and a re-render
 * per move would redraw a whole viewer for a disc. The canvas layer reads it every frame it draws, and so does a
 * recording's composer, so the overlay and the video show the same thing.
 *
 * Fed either by a person's pointer (`hover`/`down`/`move`/`up`/`leave`) or by a machine's touch (`play`), which it
 * then plays on its own clock.
 */
export class TouchMarkStore {
  private state: TouchState = NO_TOUCH
  private script: MachineTouch | null = null
  private readonly listeners = new Set<() => void>()
  private away: (a: NormPoint, b: NormPoint) => number = inFractions

  /** What to draw at `t`. */
  stateAt(t: number): TouchState {
    return this.script ? machineState(this.script, t) : this.state
  }

  /**
   * Whether something still moves on its own at `t` and needs frames: a press tightening, a release playing out, a
   * machine's touch. A press held still does not — a move wakes the layer itself.
   */
  animating(t: number): boolean {
    if (this.script) return t < machineTouchEnd(this.script)
    const touch = this.state.touch
    if (!touch) return false
    return touch.upAt !== null || t - touch.downAt < TOUCH_MARK.growMs
  }

  /**
   * Measure the farthest point in the pixels it is drawn in. A tap or a swipe is judged by the farthest point's travel in
   * pixels, and on a screen that is not square the farthest in fractions can be the nearer in pixels: 0.009 across a
   * 400 px width is 3.6 px, 0.006 down an 800 px height is 4.8 px (review, CodeRabbit). Any uniform scale of these
   * pixels — a recording's — keeps the same order.
   */
  measureIn(toPx: (p: NormPoint) => PxPoint): void {
    this.away = (a, b) => { const p = toPx(a); const q = toPx(b); return Math.hypot(p.x - q.x, p.y - q.y) }
  }

  /** Called when the state changes; the layer then draws, and keeps drawing while `animating`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Where the pointer is, with nothing pressed: one disc, or a pinch's two while Option is held, or none. */
  hover(points: NormPoint[]): void {
    this.set({ ...this.state, hover: points })
  }

  /** A press, of one finger or a pinch's two. */
  down(points: NormPoint[], at = now()): void {
    this.set({ hover: points, touch: { fingers: points.map((p) => ({ start: p, cur: p, far: p })), downAt: at, upAt: null } })
  }

  /** The pressed fingers moved. The hover follows, so the disc is under the pointer once the touch is drawn out. */
  move(points: NormPoint[]): void {
    const touch = this.state.touch
    if (!touch || touch.upAt !== null) return
    const fingers = touch.fingers.map((f, i) => {
      const p = points[i] ?? f.cur
      return { start: f.start, cur: p, far: this.away(p, f.start) > this.away(f.far, f.start) ? p : f.far }
    })
    this.set({ hover: points, touch: { ...touch, fingers } })
  }

  /** The fingers lifted. */
  up(at = now()): void {
    const touch = this.state.touch
    if (!touch || touch.upAt !== null) return
    this.set({ ...this.state, touch: { ...touch, upAt: at } })
  }

  /** The pointer left the screen: no hover disc. A touch being drawn plays out. */
  leave(): void {
    if (this.state.hover.length > 0) this.set({ ...this.state, hover: [] })
  }

  /** A machine's touch, played from its `at`. Replaces whatever was being drawn: a replay is watched for its latest step. */
  play(touch: MachineTouch): void {
    this.script = touch
    this.notify()
  }

  /** Nothing on the screen. */
  clear(): void {
    this.script = null
    this.set(NO_TOUCH)
  }

  /**
   * Drops a touch the drawing found finished, so `animating` stops asking for frames. Only the drawing can tell —
   * whether a touch moved, and so how long it lasts, is a question of pixels. Not a change anything redraws for.
   */
  dropFinished(): void {
    if (this.state.touch?.upAt != null) this.state = { ...this.state, touch: null }
  }

  private set(state: TouchState): void {
    this.state = state
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}
