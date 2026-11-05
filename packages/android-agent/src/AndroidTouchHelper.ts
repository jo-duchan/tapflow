import type { AdbWrapper } from './AdbWrapper.js'
import { createLogger } from '@tapflowio/agent-core'
import type { InputOutcome } from './inputOutcome.js'
import type { AndroidButtonName } from '@tapflowio/protocol/buttons'

const logger = createLogger('android-agent:touch')

// Below every platform long-press threshold (Android's is 400–500 ms), so a quick tap stays `input tap`, which has
// no duration, and anything held longer keeps the time it was held.
const HELD_TOUCH_MS = 250

// Keyed by protocol's `ANDROID_BUTTONS`, which flow-runner reads to refuse a flow before it runs: a name added here
// and not there would be refused by a flow it works for, and the type makes the two lists one.
const BUTTON_KEY_MAP: Record<AndroidButtonName, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recent_apps: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  lock: 'KEYCODE_POWER', // cross-platform alias — Android's lock is the power key
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
}

/**
 * The adb fallback pointer path, used when neither video backend has a control channel — and, for
 * buttons, on every backend.
 *
 * Terminal methods **resolve with an outcome rather than rejecting.** `AndroidAgent`'s public
 * `DeviceAgent.touchEnd()` discards what this returns, so a rejection there would be an unhandled
 * rejection (fatal by default on Node 22). An outcome is safe to ignore.
 *
 * Deliberately **unbounded**: a wedged guest means the ack never arrives and the caller falls back
 * to its own timeout, which is what happens today. Racing a timer instead would not help — the adb
 * child cannot be killed (see `bounded()` in AndroidAgent: killing `input` mid-write can leave the
 * guest worse off), so a timeout would answer failure while the input was still on its way, invite
 * a retry, and land the input twice. One child per input the user actually made is the honest
 * ceiling.
 */
export class AndroidTouchHelper {
  private screenSize: { width: number; height: number } | null = null
  private startX = 0
  private startY = 0
  private lastX = 0
  private lastY = 0
  private touching = false
  private startedAt = 0

  constructor(
    private readonly adb: AdbWrapper,
    private readonly serial: string,
  ) {}

  start(): void {}
  // Forgets an open gesture (#487). `touching` was cleared only by `touchEnd`, so a helper torn down
  // mid-gesture kept it — and answered the next end it received with a tap at the abandoned position.
  stop(): void { this.touching = false }

  // Memoised on the *promise*, not on the result: resolving-only caching lets every terminal frame
  // that arrives before the first lookup returns spawn its own `wm size` child, which is the extra
  // child the "one per input" ceiling does not account for.
  private sizePromise: Promise<{ width: number; height: number }> | null = null

  private getScreenSize(): Promise<{ width: number; height: number }> {
    if (!this.sizePromise) {
      this.sizePromise = this.adb.getScreenSize(this.serial)
        .catch((e: unknown) => { this.sizePromise = null; throw e })
    }
    return this.sizePromise
  }

  touchStart(x: number, y: number): void {
    this.touching = true
    this.startedAt = Date.now()
    this.startX = x; this.startY = y
    this.lastX = x;  this.lastY = y
  }

  touchMove(x: number, y: number): void {
    this.lastX = x; this.lastY = y
  }

  // The whole gesture is dispatched here — start/move only accumulate — so this is where the
  // outcome comes from. The first call also pays a `wm size` round trip (cached after).
  async touchEnd(): Promise<InputOutcome> {
    // Not `channel-down`: the adb path is fine, there was simply nothing to complete. Reachable
    // from the viewer, which sends `input:touch:end` on pointerup and pointercancel without
    // checking that a pointerdown reached the video element.
    if (!this.touching) return 'no-gesture'
    this.touching = false
    // Snapshot all four coordinates, not just the tap/swipe verdict: a gesture opened while the size
    // lookup is in flight overwrites the fields, and the pending dispatch would then land at the new
    // gesture's position while answering for the old one.
    const [sx, sy, ex, ey] = [this.startX, this.startY, this.lastX, this.lastY]
    const isTap = Math.abs(ex - sx) < 0.01 && Math.abs(ey - sy) < 0.01
    const heldMs = Date.now() - this.startedAt
    try {
      const { width, height } = await this.getScreenSize()
      if (isTap && heldMs >= HELD_TOUCH_MS) {
        // `input tap` has no duration, so a held touch sent as one is a tap — a long press answered `delivered`
        // while the app saw a tap. A swipe that does not move is adb's long press, and it lasts as long as the
        // touch was held. The hold is replayed after the end arrived, so the ack comes that much later.
        const x = String(Math.round(sx * width)), y = String(Math.round(sy * height))
        await this.adb.sendInput(this.serial, 'swipe', x, y, x, y, String(heldMs))
      } else if (isTap) {
        await this.adb.sendInput(this.serial, 'tap', String(Math.round(sx * width)), String(Math.round(sy * height)))
      } else {
        const x0 = Math.round(sx * width), y0 = Math.round(sy * height)
        const x1 = Math.round(ex * width), y1 = Math.round(ey * height)
        await this.adb.sendInput(this.serial, 'swipe', String(x0), String(y0), String(x1), String(y1), '300')
      }
      return 'delivered'
    } catch (e) {
      logger.error(`touch dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }

  // Pinch is not implemented on this path, and saying so is the point: it used to accept the frames
  // and answer success while nothing reached the device at all. Implementing it over `adb input` is
  // a separate piece of work.
  pinchStart(_x1: number, _y1: number, _x2: number, _y2: number): InputOutcome { return 'unsupported' }
  pinchMove(_x1: number, _y1: number, _x2: number, _y2: number): InputOutcome { return 'unsupported' }
  pinchEnd(): InputOutcome { return 'unsupported' }

  async pressButton(name: string): Promise<InputOutcome> {
    // Not "the device has no such button" — this map is ours, so an unmapped name means we do not
    // support it. iOS answers success for its own unmapped case because there the button genuinely
    // does not exist on the device; see inputOutcome.ts.
    // `Object.hasOwn`: `name` comes off the wire, so a prototype member would otherwise resolve to
    // a function and be dispatched as a keycode — answering `failed` where `unsupported` is true.
    if (!Object.hasOwn(BUTTON_KEY_MAP, name)) { logger.error(`Unknown button: ${name}`); return 'unsupported' }
    const keyCode = BUTTON_KEY_MAP[name as AndroidButtonName]
    try {
      await this.adb.sendKeyEvent(this.serial, keyCode)
      return 'delivered'
    } catch (e) {
      logger.error(`button dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }
}
