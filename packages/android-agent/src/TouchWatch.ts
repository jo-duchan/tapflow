import type { CaptureTouched, TouchObservation } from '@tapflowio/protocol'
import { performance } from 'perf_hooks'
import { AFTER_NS, judgeTouch, parseFramestats, parseHit, seenAt } from './touchObservation.js'

export interface TouchWatchDeps {
  /** The field server's `hit` at a point (fractions of the screen as drawn); `writtenAt` on `now`'s clock. */
  hit: (serial: string, x: number, y: number) => Promise<{ answer: string; writtenAt: number } | null>
  framestats: (serial: string, pkg: string) => Promise<string>
  ping: (serial: string) => Promise<void>
  /** Keep the field server's UiAutomation connection while this watch lives, or let it go. */
  hold: (serial: string, on: boolean) => Promise<void>
  send: (msg: CaptureTouched) => void
  /** Monotonic milliseconds, the clock `hit`'s `writtenAt` is on. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  keepAliveMs?: number
}

const MS = 1_000_000
/** A hit read after the up reached the app, or after a long press could have fired (ViewConfiguration's 400 ms), may
 *  have read the screen the touch changed (design review, Revision 1 §5): such a touch gets no report. Through a held
 *  connection a hit is read in p50 14 ms, p90 16 ms (measured 2026-11-18). */
const LONG_PRESS_MS = 400
/** Past this distance (a fraction of the screen) a touch moved: a swipe or a drag. ~ViewConfiguration's touch slop. */
const TAP_SLOP = 0.02
/** A tap this soon after a tap at about the same spot is its repeat (ViewConfiguration's double-tap timeout). */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 0.1
/** Under the field server's 60 s idle exit. */
const KEEP_ALIVE_MS = 30_000
/** After the verdict window, before the frames are read: a frame completing at its edge is in the dump. */
const SETTLE_MS = 50

interface Gesture {
  downAt: number
  upAt?: number
  /** As drawn (what the hit takes and the slop is measured in), and in the device's portrait space (the report's). */
  x: number
  y: number
  point: { x: number; y: number }
  moved: number
  hit: Promise<{ answer: string; writtenAt: number } | null>
  tapCount: number
  previousTapUpAt?: number
  swipeEndAt?: number
}

/**
 * One recorded device's touches, observed from outside the app (Flow Capture P4): each touch-down asks what it hit just
 * after it was sent, and once the app has had its 0.8 s to answer, one framestats read says whether a list was still
 * gliding under it and whether the app drew in answer. Sent as one `capture:touched` per gesture — iOS sends the
 * verdict as a second one; here it is known no earlier than the rest. Only touches on the app under test are reported
 * (the topmost window there is its own), so the launcher's and a permission dialog's are not, as on iOS.
 */
export class TouchWatch {
  private current: Gesture | null = null
  private last: { tap: boolean; upAt: number; x: number; y: number; tapCount: number } | null = null
  /** Device CLOCK_MONOTONIC ns minus `now`'s ns, the smallest seen: the one-way delay at its least. */
  private offsetNs: number | undefined
  private pid: number | undefined
  private seq = 0
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly keepAlive: ReturnType<typeof setInterval>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly deps: TouchWatchDeps,
    private readonly serial: string,
    /** The app under test's package, as the agent last installed or launched it; none means no reports. */
    private readonly appPackage: () => string | undefined,
  ) {
    this.now = deps.now ?? (() => performance.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    void deps.hold(serial, true).catch(() => {})
    this.keepAlive = setInterval(() => { void deps.ping(serial).catch(() => {}) }, deps.keepAliveMs ?? KEEP_ALIVE_MS)
    this.keepAlive.unref?.()
  }

  down(x: number, y: number, point: { x: number; y: number }): void {
    if (this.stopped) return
    const downAt = this.now()
    const last = this.last
    const repeat = last?.tap && downAt - last.upAt <= DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_SLOP
    this.current = {
      downAt, x, y, point, moved: 0,
      // Asked after the down was sent, never on its path; queued with the device's other UiAutomation requests.
      hit: this.deps.hit(this.serial, x, y).catch(() => null),
      tapCount: repeat ? last.tapCount + 1 : 1,
      ...(last?.tap ? { previousTapUpAt: last.upAt } : {}),
      ...(last && !last.tap ? { swipeEndAt: last.upAt } : {}),
    }
  }

  move(x: number, y: number): void {
    const g = this.current
    if (g) g.moved = Math.max(g.moved, Math.hypot(x - g.x, y - g.y))
  }

  up(sessionId: string, requestId: string): void {
    const g = this.current
    this.current = null
    if (!g || this.stopped) return
    g.upAt = this.now()
    const tap = g.moved <= TAP_SLOP
    this.last = { tap, upAt: g.upAt, x: g.x, y: g.y, tapCount: tap ? g.tapCount : 0 }
    // One at a time, in the order the touches ended: a touch's `seq` is its place among them.
    this.tail = this.tail.then(() => this.report(sessionId, requestId, g, !tap)).catch(() => {})
  }

  /** A gesture the client abandoned (#1115): nothing was touched. */
  cancel(): void {
    this.current = null
  }

  stop(): void {
    this.stopped = true
    this.current = null
    clearInterval(this.keepAlive)
    void this.deps.hold(this.serial, false).catch(() => {})
  }

  /** For tests: resolves once every report begun so far is sent or given up. */
  settled(): Promise<void> {
    return this.tail
  }

  private async report(sessionId: string, requestId: string, g: Gesture, moved: boolean): Promise<void> {
    const res = await g.hit
    const hit = parseHit(res?.answer)
    if (!res || !hit || this.stopped) return
    const sample = hit.rx - res.writtenAt * MS
    this.offsetNs = this.offsetNs === undefined ? sample : Math.min(this.offsetNs, sample)
    const device = (ms: number) => Math.round(ms * MS + this.offsetNs!)
    const downNs = device(g.downAt), upNs = device(g.upAt!)
    if (hit.done === undefined || hit.done > Math.min(downNs + LONG_PRESS_MS * MS, upNs)) return
    const pkg = this.appPackage()
    if (!pkg) return
    const seen = seenAt(hit, pkg)
    if (!seen || seen.kind !== 'app') return
    const wait = g.upAt! + AFTER_NS / MS + SETTLE_MS - this.now()
    if (wait > 0) await this.sleep(wait)
    if (this.stopped) return
    const frames = parseFramestats(await this.deps.framestats(this.serial, pkg).catch(() => ''))
    const { moving, acted } = judgeTouch({
      frames, downNs, upNs, moved, seen,
      ...(g.swipeEndAt !== undefined ? { swipeEndNs: device(g.swipeEndAt) } : {}),
      ...(g.previousTapUpAt !== undefined ? { previousTapUpNs: device(g.previousTapUpAt) } : {}),
    })
    // Counted in the app's process, as iOS counts: a new process starts again at 1.
    let seq: number | undefined
    if (frames) {
      if (frames.pid !== this.pid) { this.pid = frames.pid; this.seq = 0 }
      seq = ++this.seq
    }
    const observation: TouchObservation = {
      point: g.point,
      moving,
      ...seen.observation,
      ...(moved ? {} : { tapCount: g.tapCount }),
      ...(seq !== undefined ? { seq } : {}),
      ...(acted !== undefined ? { acted } : {}),
    }
    this.deps.send({ type: 'capture:touched', sessionId, requestId, observation })
  }
}
