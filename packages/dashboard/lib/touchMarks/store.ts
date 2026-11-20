import { NO_TOUCH, machineState, machineTouchEnd, type MachineTouch, type NormPoint, type TouchState } from './model'

const now = () => performance.now()
/** Distance in the screen's own fractions: only compares which of two points is farther, so the aspect is moot. */
const away = (a: NormPoint, b: NormPoint) => Math.hypot(a.x - b.x, a.y - b.y)

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

  /** What to draw at `t`. */
  stateAt(t: number): TouchState {
    return this.script ? machineState(this.script, t) : this.state
  }

  /** Whether something still moves on its own at `t` — a press, a release, a machine's touch — and needs frames. */
  animating(t: number): boolean {
    if (this.script) return t < machineTouchEnd(this.script)
    return this.state.touch !== null
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
      return { start: f.start, cur: p, far: away(p, f.start) > away(f.far, f.start) ? p : f.far }
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
