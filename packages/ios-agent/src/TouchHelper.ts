import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { createLogger } from '@tapflowio/agent-core'
import { killWithSigkillFallback } from './childProcessKill.js'
import { MIN_CONTACT_MS, type InputChannel } from './InputChannel.js'

const logger = createLogger('ios-agent:touch-helper')

const BINARY = join(import.meta.dirname, '..', 'bin', 'touch-helper')

// At most this many spawns in any window of this length. A rolling window rather than a count
// of consecutive failures: the helper's start-up is expensive (a subprocess, two dlopens, a
// device lookup), so "it failed quickly" cannot be told apart from "it failed slowly" without
// guessing how long start-up takes — and a helper that reliably dies just after that guess would
// reset a consecutive counter forever and churn processes for the life of the agent. A window
// bounds it whatever the lifetime, and it self-clears, so a session that briefly could not start
// a helper is not stuck without input until the device is rebooted.
const RESPAWN_LIMIT = 3
const RESPAWN_WINDOW_MS = 30_000

// The helper announces itself on stderr once it holds its HID client and is about to start
// reading stdin (its `touch-helper ready` line). Measured against a real simulator: 186–247ms after
// spawn (n=5), and a gesture written before it lands *nothing* — the frames are buffered by the
// pipe and then drained in one go, which collapses a swipe into microseconds and iOS reads it as
// no gesture at all. So "the pipe is open" is not the same as "the device will act on this", and
// reporting the first as success is the same lie as #482 in a narrower window.
const READY_MARKER = 'touch-helper ready'
// A helper that wedges *before* announcing would otherwise never be replaced: it is running, so
// nothing asks for a new one, and it is not ready, so every input is refused — honestly, but
// forever. The announcement comes after a device lookup through CoreSimulator, which is where a
// wedge would sit. Measured start-up is 186–247ms, so this is roughly twenty times the worst case
// observed rather than a tight bound.
const READY_DEADLINE_MS = 5_000

// Defined beside the interface both input channels implement, so FoldableInput does not reach into this
// module for it; re-exported because callers and tests have always imported it from here.
export { MIN_CONTACT_MS }

export class TouchHelper implements InputChannel {
  private proc: ChildProcess | null = null
  // The process that received the current gesture's opening frame. Mid-gesture frames are only
  // meaningful to that one, so they are checked against it rather than against liveness alone.
  private gestureProc: ChildProcess | null = null
  private lastX = 0
  private lastY = 0
  private stopped = false
  private ready = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private spawns: number[] = []
  private readyWaiters: Array<(ready: boolean) => void> = []
  // When the current touch went down, and the up held back until it has lasted `MIN_CONTACT_MS`.
  private touchStartedAt = 0
  // A single-finger touch is down in `gestureProc`: set when its open is delivered, cleared by its end, its cancel or a
  // pinch. Not `ownsGesture()`, which stays true after a gesture ended until the next one opens — a cancel written then
  // would reach a helper with nothing down.
  private touchDown = false
  private heldEnd: { timer: ReturnType<typeof setTimeout>; resolve: (sent: boolean) => void } | null = null

  constructor(
    private readonly udid: string,
    private readonly minContactMs: number = MIN_CONTACT_MS,
  ) {}

  start(): void {
    this.stopped = false
    this.spawnHelper()
  }

  stop(): void {
    // A held-back up is answered, not dropped: its caller is waiting on it to ack the tap.
    this.releaseHeldEnd(false)
    this.stopped = true
    this.settleReadyWaiters(false)
    this.clearReadyDeadline()
    killWithSigkillFallback(this.proc)
    this.proc = null
    this.gestureProc = null
  }

  // Whether an input written right now actually reaches the device. Two conditions, and they are
  // deliberately not the same question as `isRunning()`: a helper that is still starting up is
  // very much alive and must not be replaced, but a frame written to it is dropped on the floor.
  isReady(): boolean {
    return this.isRunning() && this.ready
  }

  whenReady(): Promise<boolean> {
    if (this.isReady()) return Promise.resolve(true)
    if (this.stopped) return Promise.resolve(false)
    return new Promise((resolve) => this.readyWaiters.push(resolve))
  }

  private settleReadyWaiters(ready: boolean): void {
    for (const resolve of this.readyWaiters.splice(0)) resolve(ready)
  }

  // Whether the helper process exists with an open pipe — the question a *replacement* decision
  // asks. `this.proc` only ever holds a process that execed (`spawnHelper` is the gate), so from
  // here on stdin closing is what death looks like.
  private isRunning(): boolean {
    return this.proc?.stdin?.writable === true
  }

  /**
   * Why a write would be refused right now, for the ack to report.
   *
   * `starting` is the state that had no name: measured 186–247ms after spawn, the pipe is open and
   * frames written to it land nowhere, and a caller that retries a moment later succeeds. Answering
   * "no channel" for it — which is what a bare boolean forced — told the caller to reconnect when it
   * should simply have waited.
   *
   * Safe to read at the ack site rather than inside the write: writes here are synchronous, so
   * nothing can have changed between the two.
   */
  inputState(): 'ready' | 'starting' | 'unavailable' {
    if (this.isReady()) return 'ready'
    return this.isRunning() ? 'starting' : 'unavailable'
  }

  /**
   * Whether a gesture is currently owned by the live process — i.e. whether a continuation frame
   * could land at all.
   *
   * Separate from `inputState()` because the two answer questions decided at different times.
   * Readiness is about now; ownership was decided when the opening frame was written. A gesture whose
   * open was refused (during the start-up window, say) leaves nothing owned, and no amount of waiting
   * makes its terminal frame deliverable — the caller has to open a new gesture. Reading readiness
   * alone at the ack site turned that into "the message is malformed, never retry".
   */
  ownsGesture(): boolean {
    return this.proc !== null && this.proc === this.gestureProc
  }

  touchStart(x: number, y: number): boolean {
    // Opened before the coordinates move on: a held-back up flushed by the open belongs to the last
    // touch and carries its position. The helper releases at its own latch anyway (type 3 ignores the
    // frame's coordinates), but a frame naming another touch's point is one protocol change from a
    // tap on the wrong target.
    const sent = this.openGesture(this.coordFrame(1, x, y))
    this.touchDown = sent
    this.lastX = x
    this.lastY = y
    this.touchStartedAt = Date.now()
    return sent
  }

  touchMove(x: number, y: number): boolean {
    this.lastX = x
    this.lastY = y
    return this.continueGesture(this.coordFrame(2, x, y))
  }

  touchEnd(): boolean {
    this.touchDown = false
    return this.continueGesture(this.coordFrame(3, this.lastX, this.lastY))
  }

  /**
   * Lift the touch as cancelled, so the app does not take it for a tap (#1115). An up held back for the minimum contact
   * is dropped, not sent: the cancel is the last word on that touch. Ownership goes with it, so the `input:touch:end` a
   * leaving client sends next writes nothing. The helper sends an up where it cannot cancel (a mouse-path touch), so a
   * touch is never left down.
   */
  touchCancel(): boolean {
    this.releaseHeldEnd(false)
    if (!this.touchDown) return false
    this.touchDown = false
    const sent = this.continueGesture(this.coordFrame(13, this.lastX, this.lastY))
    this.gestureProc = null
    return sent
  }

  /**
   * `touchEnd`, once the touch has lasted `MIN_CONTACT_MS`. What a terminal frame from a client goes
   * through; the answer is the same `touchEnd` gives, so an ack keeps meaning what it meant.
   */
  touchEndAfterMinContact(): Promise<boolean> {
    const wait = this.touchStartedAt + this.minContactMs - Date.now()
    if (wait <= 0 || this.stopped) return Promise.resolve(this.touchEnd())
    // A second up for the same touch replaces nothing: answer the earlier one now, as a fresh up would.
    if (this.heldEnd) this.releaseHeldEnd(this.touchEnd())
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.heldEnd = null
        resolve(this.touchEnd())
      }, wait)
      this.heldEnd = { timer, resolve }
    })
  }

  private releaseHeldEnd(sent: boolean): void {
    const held = this.heldEnd
    if (!held) return
    this.heldEnd = null
    clearTimeout(held.timer)
    held.resolve(sent)
  }

  pressButton(usagePage: number, usage: number): boolean {
    return this.sendSelfContained(this.buttonFrame(4, usagePage, usage))
  }

  // Real-time button hold: down + up sent as separate frames so the hold lasts as long as
  // the user holds the button in the dashboard (e.g. Action button long-press). type 4 above
  // remains the fixed short-press path.
  pressButtonDown(usagePage: number, usage: number): boolean {
    return this.sendSelfContained(this.buttonFrame(10, usagePage, usage))
  }

  // Self-contained despite being the tail of a pair: the helper keeps no record of which
  // buttons are down (`touch-helper.swift` sends one op per frame), so a fresh process serves
  // this exactly as the old one would have. Refusing it would be worse — a `down` that reached
  // a live helper could then never be released.
  pressButtonUp(usagePage: number, usage: number): boolean {
    return this.sendSelfContained(this.buttonFrame(11, usagePage, usage))
  }

  // Legacy path for home (code=0) and lock (code=1) buttons
  pressLegacyButton(code: number): boolean {
    return this.sendSelfContained(this.buttonFrame(5, code, 0))
  }

  pinchStart(x1: number, y1: number, x2: number, y2: number): boolean {
    this.touchDown = false
    return this.openGesture(this.twoFingerFrame(6, x1, y1, x2, y2))
  }

  pinchMove(x1: number, y1: number, x2: number, y2: number): boolean {
    return this.continueGesture(this.twoFingerFrame(7, x1, y1, x2, y2))
  }

  pinchEnd(): boolean {
    return this.continueGesture(this.twoFingerFrame(8, 0, 0, 0, 0))
  }

  // HID keyboard — type 9 frame: [9][modifiers][pad x3][usage:u32BE]
  // modifiers: USB HID modifier bitmap (0x01=LeftCtrl, 0x02=LeftShift, 0x04=LeftAlt, 0x08=LeftMeta, …)
  // usage: keyboard usage code from HID Keyboard/Keypad page (0x07)
  sendKey(usage: number, modifiers = 0): boolean {
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(9, 0)
    buf.writeUInt8(modifiers, 1)
    buf.writeUInt8(0, 2)
    buf.writeUInt8(0, 3)
    buf.writeUInt8(0, 4)
    buf.writeUInt32BE(usage, 5)
    return this.sendSelfContained(buf)
  }

  private coordFrame(type: number, x: number, y: number): Buffer {
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(type, 0)
    buf.writeFloatBE(x, 1)
    buf.writeFloatBE(y, 5)
    return buf
  }

  private buttonFrame(type: number, a: number, b: number): Buffer {
    const buf = Buffer.allocUnsafe(9)
    buf.writeUInt8(type, 0)
    buf.writeUInt32BE(a, 1)
    buf.writeUInt32BE(b, 5)
    return buf
  }

  private twoFingerFrame(type: number, x1: number, y1: number, x2: number, y2: number): Buffer {
    const buf = Buffer.allocUnsafe(17)
    buf.writeUInt8(type, 0)
    buf.writeFloatBE(x1, 1)
    buf.writeFloatBE(y1, 5)
    buf.writeFloatBE(x2, 9)
    buf.writeFloatBE(y2, 13)
    return buf
  }

  // Frames that carry their whole payload: a dead helper is replaced before the frame goes out,
  // so input recovers rather than staying dead for the rest of the session (#482).
  private sendSelfContained(buf: Buffer): boolean {
    // `isRunning`, not `isReady`: replacing a helper that is merely still starting up would spawn
    // a second one, burn the window budget, and make the wait longer rather than shorter.
    if (!this.isRunning()) this.respawn()
    return this.send(buf)
  }

  // A gesture's opening frame. Self-contained, and it records which process is serving the
  // gesture so the frames that follow can be held to it.
  private openGesture(buf: Buffer): boolean {
    // A new gesture while the last touch's up is still held back: that up goes first, now, so the two
    // cannot overlap — a down written over an open touch moves it rather than taps, and an up landing
    // inside a pinch lifts a finger the pinch is using.
    if (this.heldEnd) this.releaseHeldEnd(this.touchEnd())
    const sent = this.sendSelfContained(buf)
    // Only a *delivered* open owns the gesture. Recording unconditionally looks equivalent and is
    // not: during the start-up window the open is refused while `this.proc` is a healthy process
    // that becomes ready ~200ms later, so identity would then pass and the rest of the gesture
    // would reach a process that never received the down — a release at (0,0) reported as
    // delivered, which is the exact defect this guard exists to prevent.
    this.gestureProc = sent ? this.proc : null
    return sent
  }

  // Everything after the opening frame. These are meaningless to any other process: types 3 and
  // 8 inject coordinate latches the helper accumulated (`lastX/lastY`, `pinchLast*`) — a pinch
  // end's own coordinates are all zero for exactly that reason — and a type 2 or 7 move with no
  // preceding down is not the gesture the tester made.
  //
  // Checking liveness is not enough. Replacement is eager, so by the time a terminal frame
  // arrives after a mid-gesture death there is usually a healthy process to write to, and a
  // fresh one has those latches at zero: the tap would be released at (0,0) and reported as
  // delivered. Identity is what the guard has to be about.
  private continueGesture(buf: Buffer): boolean {
    if (this.proc === null || this.proc !== this.gestureProc) return false
    return this.send(buf)
  }

  private send(buf: Buffer): boolean {
    if (!this.isReady()) return false
    // A `false` from write() is backpressure: node buffers the frame and flushes it when the
    // pipe drains, so it does not mean the input was dropped.
    this.proc?.stdin?.write(buf)
    return true
  }

  private armReadyDeadline(proc: ChildProcess): void {
    this.clearReadyDeadline()
    const timer = setTimeout(() => {
      if (this.proc !== proc || this.ready) return
      logger.error(`no readiness announcement within ${READY_DEADLINE_MS}ms — replacing the helper`)
      killWithSigkillFallback(proc)
      // Through the same path as a real death, so the replacement is subject to the same window.
      this.handleDeath(proc)
    }, READY_DEADLINE_MS)
    timer.unref?.()
    this.readyTimer = timer
  }

  private clearReadyDeadline(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null }
  }

  private respawn(): void {
    if (this.stopped) return
    const now = Date.now()
    this.spawns = this.spawns.filter((t) => now - t < RESPAWN_WINDOW_MS)
    if (this.spawns.length >= RESPAWN_LIMIT) return
    this.spawnHelper()
  }

  private spawnHelper(): void {
    const proc = spawn(BINARY, [this.udid], { stdio: ['pipe', 'ignore', 'pipe'] })
    this.spawns.push(Date.now())
    this.ready = false

    // The one place that decides whether a spawn counts as a helper, and it has to decide
    // synchronously: the frame that triggered this spawn is written immediately after.
    //
    // A pid is the only signal available that early. When the exec fails — binary missing, no
    // execute bit, wrong architecture (#464) — libuv still hands back an open stdin pipe and
    // reports the failure on a LATER tick. Measured against a real spawn of a nonexistent path,
    // `stdin.writable` is `true` on a process that does not exist, and `stdin.write()` returning
    // `false` is indistinguishable from ordinary backpressure on a healthy helper. A pid is
    // assigned only once the exec succeeded.
    if (proc.pid === undefined) {
      proc.on('error', (e) => logger.error(`spawn error: ${e.message}`))
      this.proc = null
      return
    }

    this.proc = proc
    this.armReadyDeadline(proc)
    // Cap what is retained: the marker is short, and a helper that never announces itself can
    // still emit warnings indefinitely.
    let tail = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString()
      // Guarded on identity so a superseded process's late announcement cannot mark a newer one
      // ready.
      if (!this.ready && this.proc === proc) {
        const seen = tail + msg
        if (seen.includes(READY_MARKER)) {
          this.ready = true
          tail = ''
          this.clearReadyDeadline()
          this.settleReadyWaiters(true)
        // Retain only enough to rejoin a marker split across two chunks.
        } else tail = seen.slice(-READY_MARKER.length)
      }
      // print all lines, even debug: lines, until we're confident it's working
      logger.error(msg.trim())
    })
    proc.on('exit', (code) => {
      logger.error(`exited with code ${code ?? 'null'}`)
      this.handleDeath(proc)
    })
    proc.on('error', (e) => {
      logger.error(`spawn error: ${e.message}`)
      this.handleDeath(proc)
    })
  }

  // Replace the helper as soon as it dies rather than on the next input. Waiting would make
  // the first tap after a death pay the whole start-up cost (xcode-select, two dlopens, a
  // device lookup), and that tap is the one the tester is watching.
  private handleDeath(proc: ChildProcess): void {
    if (this.proc !== proc) return // superseded by a newer spawn, or stop() already cleared it
    this.clearReadyDeadline()
    this.proc = null
    this.respawn()
  }
}
