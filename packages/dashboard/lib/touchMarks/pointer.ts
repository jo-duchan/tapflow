import { toPinchFingers } from '@/lib/coordinate-transform'
import type { NormPoint } from './model'
import { TouchMarkStore } from './store'

/**
 * A person's pointer on the QA viewer, as touch marks: the one place that turns pointer events into what is drawn, so
 * iOS and Android draw the same thing from the same events. The viewers still decide what is sent to the device; this
 * only follows.
 *
 * Points are in the screen as it is shown (0–1). A pinch is the pointer and its mirror through the screen's centre,
 * as the viewers send one (`toPinchFingers`).
 */
export class PointerTouchMarks {
  readonly store = new TouchMarkStore()
  /** Where the pointer is over the screen, or null off it. */
  private at: NormPoint | null = null
  /** Option is held: the hover shows a pinch's two fingers, before anything is pressed. */
  private guide = false
  /** The press under way is a pinch. */
  private pinching = false

  /** The pointer moved with nothing pressed (null: it is off the screen). */
  hover(p: NormPoint | null): void {
    this.at = p
    this.showHover()
  }

  /** Option went down or up. The guide shows at once where the pointer already is — no move needed. */
  option(held: boolean): void {
    if (this.guide === held) return
    this.guide = held
    this.showHover()
  }

  /** A press: one finger, or a pinch's two. */
  press(p: NormPoint, pinch: boolean): void {
    this.at = p
    this.pinching = pinch
    this.store.down(this.fingers(p))
  }

  /** The pressed pointer moved. */
  drag(p: NormPoint): void {
    this.at = p
    this.store.move(this.fingers(p))
  }

  /** The press ended — lifted, cancelled, or a pinch ended by letting go of Option. */
  lift(): void {
    this.store.up()
    this.pinching = false
    this.showHover()
  }

  /** The pointer left the screen. A touch being drawn plays out. */
  leave(): void {
    this.at = null
    this.store.leave()
  }

  private fingers(p: NormPoint): NormPoint[] {
    return this.pinching ? mirrored(p) : [p]
  }

  private showHover(): void {
    this.store.hover(this.at ? (this.guide ? mirrored(this.at) : [this.at]) : [])
  }
}

/** A pinch's two fingers, as the viewers send them: the pointer, and its mirror through the screen's centre. */
function mirrored(p: NormPoint): NormPoint[] {
  const { f0, f1 } = toPinchFingers(p)
  return [f0, f1]
}
