import { createLogger } from '@tapflowio/agent-core'
import { MIN_CONTACT_MS, type InputChannel } from './InputChannel.js'
import type { GuestHelper } from './GuestHelper.js'

const logger = createLogger('ios-agent:foldable-input')

/**
 * A gesture that starts within this fraction of any screen edge carries `FromEdgeTip`, which is what makes
 * SpringBoard treat a swipe as a system gesture (home, app switcher). Measured on the Duo's cover: a home
 * flick works from 7% of the bottom edge and not from 12%, because the system checks the start point
 * itself — so the flag on a touch it does not consider an edge changes nothing, and a tap that carries it
 * stays a tap. The threshold can therefore be generous. It is the same for all four edges, which also makes
 * it independent of how the panel's UI is rotated inside its buffer.
 */
export const EDGE_FRACTION = 0.08

// The keyboard page's modifier usages, in the order the HID modifier bitmap numbers them.
const MODIFIER_USAGES = [0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7] // LCtrl LShift LAlt LMeta RCtrl RShift RAlt RMeta
const KEYBOARD_PAGE = 0x07
const KEY_HOLD_MS = 100 // a keyboard key: the same as a tap's contact, which iOS reads as a press
const BUTTON_HOLD_MS = 250 // a hardware button: DeviceHub holds its buttons a quarter second
// Measured on the Duo: consumer-page Menu goes home, AC Home (0x223) does nothing.
const HOME = [0x0c, 0x40] as const
const POWER = [0x0c, 0x30] as const

interface Gesture {
  screen: string
  edge: boolean
  points: number[]
}

export interface FoldableInputDeps {
  /** The device's guest helper, owned by IOSAgent outside `DeviceState`, or null if there is none. */
  guest: () => GuestHelper | null
  /** The display UUID of the panel the device is showing, or null when it is not known yet. */
  litScreen: () => string | null
  minContactMs?: number
}

/**
 * `InputChannel` for a device with more than one integrated panel, through `guest-helper` inside the
 * simulator. Coordinates arrive normalized to the lit panel's framebuffer — the same space TouchHelper
 * gets — and go to that panel's virtual touchscreen as they are: measured on the unfolded panel, whose UI
 * is turned inside a portrait buffer, buffer coordinates land where they point.
 */
export class FoldableInput implements InputChannel {
  private gesture: Gesture | null = null
  private touchStartedAt = 0
  private stopped = false
  private heldEnd: { timer: ReturnType<typeof setTimeout>; resolve: (sent: boolean) => void } | null = null

  constructor(private readonly deps: FoldableInputDeps) {}

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.releaseHeldEnd(false)
    this.stopped = true
    this.gesture = null
  }

  inputState(): 'ready' | 'starting' | 'unavailable' {
    if (this.stopped) return 'unavailable'
    const state = this.deps.guest()?.inputState() ?? 'unavailable'
    // Ready to write, but not yet told which panel is lit (the first devicectl reading after a boot or an
    // agent restart): a caller should wait a moment, which is what `starting` tells it.
    return state === 'ready' && this.deps.litScreen() === null ? 'starting' : state
  }

  whenReady(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    return this.deps.guest()?.whenReady() ?? Promise.resolve(false)
  }

  ownsGesture(): boolean {
    return this.gesture !== null && (this.deps.guest()?.ownsGesture() ?? false)
  }

  touchStart(x: number, y: number): boolean {
    if (this.heldEnd) this.releaseHeldEnd(this.touchEnd())
    const opened = this.open([x, y], nearEdge(x, y))
    this.touchStartedAt = Date.now()
    return opened !== null && this.deps.guest()!.touch(opened.screen, 'd', x, y, opened.edge)
  }

  touchMove(x: number, y: number): boolean {
    const g = this.gesture
    if (!g) return false
    g.points = [x, y]
    return this.deps.guest()?.touch(g.screen, 'm', x, y, g.edge) ?? false
  }

  touchEnd(): boolean {
    const g = this.gesture
    if (!g) return false
    this.gesture = null
    return this.deps.guest()?.touch(g.screen, 'u', g.points[0], g.points[1], g.edge) ?? false
  }

  /**
   * The guest helper has no cancel, so a cancelled touch is lifted with an up now — what an end does, and never left
   * down (#1115). The end that follows finds no gesture and writes nothing. A held-back up is sent at once instead.
   */
  touchCancel(): boolean {
    if (this.heldEnd) { this.releaseHeldEnd(this.touchEnd()); return true }
    if (this.gesture?.points.length !== 2) return false
    return this.touchEnd()
  }

  /** TouchHelper's minimum contact, for the same reason (a client sends down and up back to back). */
  touchEndAfterMinContact(): Promise<boolean> {
    const wait = this.touchStartedAt + (this.deps.minContactMs ?? MIN_CONTACT_MS) - Date.now()
    if (wait <= 0 || this.stopped) return Promise.resolve(this.touchEnd())
    if (this.heldEnd) this.releaseHeldEnd(this.touchEnd())
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.heldEnd = null
        resolve(this.touchEnd())
      }, wait)
      this.heldEnd = { timer, resolve }
    })
  }

  pinchStart(x1: number, y1: number, x2: number, y2: number): boolean {
    if (this.heldEnd) this.releaseHeldEnd(this.touchEnd())
    // The pinch command carries no edge flag: a two-finger touch is not a system swipe.
    const opened = this.open([x1, y1, x2, y2], false)
    return opened !== null && this.deps.guest()!.pinch(opened.screen, 'd', x1, y1, x2, y2)
  }

  pinchMove(x1: number, y1: number, x2: number, y2: number): boolean {
    const g = this.gesture
    if (!g) return false
    g.points = [x1, y1, x2, y2]
    return this.deps.guest()?.pinch(g.screen, 'm', x1, y1, x2, y2) ?? false
  }

  pinchEnd(): boolean {
    const g = this.gesture
    if (!g) return false
    this.gesture = null
    const [x1, y1, x2, y2] = g.points
    return this.deps.guest()?.pinch(g.screen, 'u', x1, y1, x2, y2) ?? false
  }

  sendKey(usage: number, modifiers = 0): boolean {
    const mods = MODIFIER_USAGES
      .filter((_, bit) => modifiers & (1 << bit))
      .map((u): [number, number] => [KEYBOARD_PAGE, u])
    return this.fire((g) => g.key(KEYBOARD_PAGE, usage, KEY_HOLD_MS, mods), 'key')
  }

  pressButton(usagePage: number, usage: number): boolean {
    return this.fire((g) => g.key(usagePage, usage, BUTTON_HOLD_MS), 'button')
  }

  pressButtonDown(usagePage: number, usage: number): boolean {
    return this.fire((g) => g.keyDown(usagePage, usage), 'button down')
  }

  pressButtonUp(usagePage: number, usage: number): boolean {
    return this.fire((g) => g.keyUp(usagePage, usage), 'button up')
  }

  pressLegacyButton(code: number): boolean {
    const [page, usage] = code === 0 ? HOME : POWER
    return this.fire((g) => g.key(page, usage, BUTTON_HOLD_MS), code === 0 ? 'home' : 'lock')
  }

  /** The panel a new gesture goes to, fixed for the gesture: a fold mid-drag finishes the drag where it began. */
  private open(points: number[], edge: boolean): Gesture | null {
    this.gesture = null
    const guest = this.deps.guest()
    const screen = this.deps.litScreen()
    if (this.stopped || !guest || guest.inputState() !== 'ready' || !screen) return null
    this.gesture = { screen, edge, points }
    return this.gesture
  }

  /**
   * A key or button, acked on the write like TouchHelper's: the helper plays it and answers later, and
   * waiting on that would change what an ack means. A refusal it reports afterwards is logged.
   */
  private fire(send: (g: GuestHelper) => Promise<boolean>, what: string): boolean {
    const guest = this.deps.guest()
    if (this.stopped || !guest || guest.inputState() !== 'ready') return false
    void send(guest).then((ok) => { if (!ok) logger.warn(`guest-helper did not take the ${what}`) })
    return true
  }

  private releaseHeldEnd(sent: boolean): void {
    const held = this.heldEnd
    if (!held) return
    this.heldEnd = null
    clearTimeout(held.timer)
    held.resolve(sent)
  }
}

function nearEdge(x: number, y: number): boolean {
  return Math.min(x, 1 - x, y, 1 - y) < EDGE_FRACTION
}
