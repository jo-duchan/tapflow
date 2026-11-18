import type { CaptureTouched, TouchObservation } from '@tapflowio/protocol'
import { performance } from 'perf_hooks'
import { createLogger } from '@tapflowio/agent-core'
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

const logger = createLogger('android-agent:touch-watch')
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
/** A release faster than this (fractions of the screen a second, over its last 100 ms) is a fling, which can leave a
 *  list gliding: ViewConfiguration's minimum fling velocity, 50 dp/s, about 0.12 of a phone's width a second (411 dp).
 *  A person's swipe in the dashboard slows before the lift (0.23–0.33 measured on three that left the Compose list
 *  gliding), so a stricter bar missed every one. A spinner after a pull to refresh is told apart by the frames instead
 *  (`judgeTouch`). */
const FLING_SPEED = 0.12
const FLING_WINDOW_MS = 100
const OFFSET_SAMPLES = 16
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
  /** The down and the latest moves, for the release's speed. */
  moves: Array<{ x: number; y: number; at: number }>
  hit: Promise<{ answer: string; writtenAt: number } | null>
  tapCount: number
  /** The app under test when the finger went down: a launch while its report waits does not make it another app's. */
  pkg: string | undefined
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
  private last: { tap: boolean; fling: boolean; upAt: number; x: number; y: number; tapCount: number } | null = null
  /** Device CLOCK_MONOTONIC ns minus `now`'s ns, the smallest of the last few: the one-way delay at its least. Recent
   *  ones only, so a device clock that drifts ahead of the host's (a real device's crystal, 20–50 ppm) is followed. */
  private readonly offsets: number[] = []
  private pid: number | undefined
  private seq = 0
  /** A touch in the app may have gone uncounted (its hit late, its frames unread): `seq` is unknown until a new process.
   *  iOS counts every touch-down, reported or not, and a first tap counted as second reads as the one that opened the
   *  app (`openedTheApp`). */
  private lost = false
  private seqUnknown = false
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
      downAt, x, y, point, moved: 0, moves: [{ x, y, at: downAt }],
      // Asked after the down was sent, never on its path; queued with the device's other UiAutomation requests.
      hit: this.deps.hit(this.serial, x, y).catch(() => null),
      tapCount: repeat ? last.tapCount + 1 : 1,
      pkg: this.appPackage(),
      ...(last?.tap ? { previousTapUpAt: last.upAt } : {}),
      ...(last?.fling ? { swipeEndAt: last.upAt } : {}),
    }
  }

  move(x: number, y: number): void {
    const g = this.current
    if (!g) return
    g.moved = Math.max(g.moved, Math.hypot(x - g.x, y - g.y))
    const at = this.now()
    g.moves.push({ x, y, at })
    while (g.moves.length > 2 && g.moves[1]!.at <= at - FLING_WINDOW_MS) g.moves.shift()
  }

  up(sessionId: string, requestId: string): void {
    const g = this.current
    this.current = null
    if (!g || this.stopped) return
    g.upAt = this.now()
    const tap = g.moved <= TAP_SLOP
    const first = g.moves[0], end = g.moves.at(-1)
    const span = first && end ? Math.max(g.upAt - first.at, 1) : 0
    const fling = !tap && span > 0 && Math.hypot(end!.x - first!.x, end!.y - first!.y) / (span / 1000) >= FLING_SPEED
    this.last = { tap, fling, upAt: g.upAt, x: g.x, y: g.y, tapCount: tap ? g.tapCount : 0 }
    // One at a time, in the order the touches ended: a touch's `seq` is its place among them.
    this.tail = this.tail.then(() => this.report(sessionId, requestId, g, !tap)).catch(() => {})
  }

  /** A gesture the client abandoned (#1115): no report, but the app saw its down, which iOS counts (`seq`). */
  cancel(): void {
    // In turn with the reports before it, whose counts it must not touch; and only for a down the app saw, not one on
    // the launcher before the app was opened.
    const g = this.current
    this.current = null
    if (!g) return
    this.tail = this.tail.then(async () => {
      const hit = parseHit((await g.hit)?.answer)
      const seen = hit && g.pkg ? seenAt(hit, g.pkg) : null
      if (seen?.kind !== 'elsewhere') this.lost = true
    })
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
    if (this.stopped) return
    if (!res || !hit) { this.lost = true; return }
    this.offsets.push(hit.rx - res.writtenAt * MS)
    if (this.offsets.length > OFFSET_SAMPLES) this.offsets.shift()
    const offsetNs = Math.min(...this.offsets)
    const device = (ms: number) => Math.round(ms * MS + offsetNs)
    const downNs = device(g.downAt), upNs = device(g.upAt!)
    if (hit.done === undefined || hit.done > Math.min(downNs + LONG_PRESS_MS * MS, upNs)) { this.lost = true; return }
    const pkg = g.pkg
    if (!pkg) return
    const seen = seenAt(hit, pkg)
    // Known to be elsewhere (the launcher, another app): not the app's touch, so nothing is lost by it.
    if (seen?.kind === 'elsewhere') return
    if (!seen) { this.lost = true; return }
    const wait = g.upAt! + AFTER_NS / MS + SETTLE_MS - this.now()
    if (wait > 0) await this.sleep(wait)
    if (this.stopped) return
    const read = parseFramestats(await this.deps.framestats(this.serial, pkg).catch(() => ''))
    // Up to 3 s for the read: a reboot or a relay loss in it stopped this watch.
    if (this.stopped) return
    // A process that drew nothing before the down started after it: the touch was the one before's (the app restarted
    // in between), so its frames, its verdicts and its count are not this touch's (CodeRabbit on #1187). Nothing drawn
    // at all is that too. A full ring cannot say, since its oldest frame is not the process's first: the count is lost.
    const startedAfter = read !== null && this.pid !== undefined && read.pid !== this.pid && (read.completed[0] ?? Infinity) > downNs
    const replaced = startedAfter && read.since === 0
    if (startedAfter && !replaced) this.lost = true
    const frames = startedAfter ? null : read
    const { moving, acted } = judgeTouch({
      frames, downNs, upNs, moved, seen,
      ...(g.swipeEndAt !== undefined ? { swipeEndNs: device(g.swipeEndAt) } : {}),
      ...(g.previousTapUpAt !== undefined ? { previousTapUpNs: device(g.previousTapUpAt) } : {}),
    })
    // `TAPFLOW_TOUCH_DEBUG=1`: what each verdict was read from, in ms around the down, never what was touched.
    if (process.env.TAPFLOW_TOUCH_DEBUG === '1' && frames) {
      const rel = frames.completed.map((t) => Math.round((t - downNs) / MS)).filter((t) => t > -400 && t < 1_500)
      logger.info(`touch ${requestId}: moving=${moving} acted=${acted} moved=${moved} scrollable=${seen.scrollable} takes=${seen.takes}`
        + ` sinceFling=${g.swipeEndAt !== undefined ? Math.round(g.downAt - g.swipeEndAt) : '-'}ms held=${Math.round(g.upAt! - g.downAt)}ms`
        + ` ring=${Math.round((frames.since - downNs) / MS)}ms frames=${rel.join(',')}`)
    }
    // Counted in the app's process, as iOS counts: a new process starts again at 1.
    let seq: number | undefined
    if (startedAfter) { /* neither process's count */ }
    else if (!frames) this.lost = true
    else {
      // A touch lost before this one may have been this process's first: its count starts unknown.
      if (frames.pid !== this.pid) { this.pid = frames.pid; this.seq = 0; this.seqUnknown = this.lost }
      else if (this.lost) this.seqUnknown = true
      this.lost = false
      this.seq++
      if (!this.seqUnknown) seq = this.seq
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
