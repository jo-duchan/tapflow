import type { TouchLanding } from '@tapflowio/protocol'

/**
 * Where a recorded touch went down on iOS (#1214), read from UIKit's own dispatch log rather than from anything injected:
 * every UIKit process logs `Sending UIEvent type: 0; subtype: 0; to window: <CLASS: 0x…>; contextId: 0x…` at default level
 * for each touch event it delivers, and the class is a public argument. Pure functions; `DispatchLog` reads the stream
 * and `IOSAgent` pairs and sends. Measurements behind every rule: ios-agent AGENTS.md, "Where a touch landed".
 */

/** One delivered touch event: when (the Mac's wall clock, ms — the simulator shares it), which process, which window. */
export interface Dispatch {
  at: number
  pid: number
  /** The process's executable on the host (a runtime root or the device's data): its bundle is beside it. */
  image: string
  window: string
}

/** SpringBoard's system-gesture layer: it is sent every touch on the screen, the app's included, so it lands nothing. */
export const SYSTEM_GESTURE_WINDOW = '_UISystemGestureWindow'

const MESSAGE = /^Sending UIEvent type: 0; subtype: 0; to window: <([A-Za-z_][A-Za-z0-9_]*): 0x[0-9a-fA-F]+>; contextId: 0x[0-9a-fA-F]+$/
/** `log stream --style ndjson`'s timestamp: local time, microseconds, an offset without a colon. */
const TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?([+-])(\d\d):?(\d\d)$/

export function parseLogTimestamp(s: string): number | null {
  const m = TIMESTAMP.exec(s)
  if (!m) return null
  const [, y, mo, d, h, mi, sec, frac, sign, oh, om] = m
  const ms = Number(`0.${frac ?? '0'}`) * 1000
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) + ms
  const offset = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === '-' ? -1 : 1)
  const at = local - offset
  return Number.isFinite(at) ? at : null
}

/**
 * One line of the stream, or null for anything else (the stream's own header, stderr, a message this does not know). The
 * system-gesture window is parsed like any other: it proves the stream speaks this format even when nothing lands.
 */
export function parseDispatch(line: string): Dispatch | null {
  if (!line.startsWith('{')) return null
  let v: unknown
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o['eventMessage'] !== 'string' || typeof o['timestamp'] !== 'string') return null
  const m = MESSAGE.exec(o['eventMessage'])
  const at = parseLogTimestamp(o['timestamp'])
  const pid = o['processID']
  const image = o['processImagePath']
  if (!m || at === null || typeof pid !== 'number' || typeof image !== 'string' || !image) return null
  return { at, pid, image, window: m[1]! }
}

export const SPRINGBOARD = 'com.apple.springboard'
export const SPOTLIGHT = 'com.apple.Spotlight'

/**
 * SpringBoard's windows by what they are, measured on iOS 26.5 and 27.0 (their levels in brackets): the home screen
 * (−2) is `home`; the status bar (999/1000), the switcher's status bar over an app (5: a tap at the top of the screen,
 * which the app never sees), Notification Center (1050), Control Center (1080) and a banner (1090) are `system`; a
 * permission alert (2000) is `alert`; the keyboard of a SpringBoard field (App Library search) says nothing by itself.
 * Any other class is unknown — a new iOS may rename these, and unknown is what every touch was before.
 */
const SPRINGBOARD_WINDOWS: Record<string, 'home' | 'system' | 'alert' | 'keyboard'> = {
  SBHomeScreenWindow: 'home',
  SBStatusBarWindow: 'system',
  SBMainSwitcherWindow: 'system',
  SBCoverSheetWindow: 'system',
  SBControlCenterWindow: 'system',
  SBBannerWindow: 'system',
  SBAlertItemWindow: 'alert',
  UIRemoteKeyboardWindow: 'keyboard',
}

export function springBoardSurface(window: string): 'home' | 'system' | 'alert' | 'keyboard' | null {
  return Object.hasOwn(SPRINGBOARD_WINDOWS, window) ? SPRINGBOARD_WINDOWS[window]! : null
}

/** How long a SpringBoard landing names the field its keyboard types into: App Library search, a folder's name. */
export const KEYBOARD_INHERIT_MS = 30_000

export interface LandingContext {
  /** The app under test; absent when the agent does not know it (a restart, a device picked up as it was). */
  target?: string
  /**
   * The app under test is off the screen: its background marker, or no process. Asked only for a SpringBoard alert or
   * keyboard; true when there is no target, since then no app is known to be in front.
   */
  away: boolean
  /** The last SpringBoard landing on this device that was not its keyboard, within `KEYBOARD_INHERIT_MS`. */
  previous?: TouchLanding
}

/**
 * The landing of a touch whose first delivered event went to `window` in the process whose bundle is `bundle`.
 *
 * - The app under test, any window — its own keyboard included: a key lands in the process that shows the keyboard, a
 *   secure field's too (measured on iOS 26.5 and 27.0).
 * - With no app under test known, only SpringBoard and Spotlight are placed: the app's own touches would otherwise read
 *   as another app's, and Capture finds the app by its leading `other` steps.
 * - A SpringBoard alert while the app is away is not one the app raised (an alert over the home screen): `system`.
 * - SpringBoard's keyboard takes the surface of the field it types into — the last SpringBoard landing — and only while
 *   the app is away, so no key typed in the app can ever be placed on the home screen.
 */
export function landingOf(bundle: string, window: string, ctx: LandingContext): TouchLanding | null {
  if (ctx.target && bundle === ctx.target) return { on: 'app' }
  if (bundle === SPRINGBOARD) {
    const surface = springBoardSurface(window)
    if (surface === 'home' || surface === 'system') return { on: surface }
    if (surface === 'alert') return { on: ctx.away ? 'system' : 'alert' }
    if (surface === 'keyboard' && ctx.away && ctx.previous) return { on: ctx.previous.on === 'alert' ? 'system' : ctx.previous.on }
    return null
  }
  if (bundle === SPOTLIGHT) return { on: 'other', id: SPOTLIGHT }
  if (!ctx.target) return null
  return { on: 'other', id: bundle }
}

/** A recorded gesture as the agent delivered it: the down, the up once it was sent, and its first delivered event. */
export interface GestureSpan {
  down: number
  up?: number
  /** The time of the first event delivered for it, once known: how far behind the log was for this gesture. */
  first?: number
}

/**
 * How long a gesture's events may trail it: measured up to 2.06 s on a Mac mini at a load average of 27 (iOS 27.0, a
 * permission alert's button just after the app launched), 4–34 ms on an idle MacBook (iOS 26.5).
 */
export const MAX_DISPATCH_LAG_MS = 3_000

export type Pick =
  | { kind: 'found'; line: Dispatch }
  /** The gesture before may still be delivering into this one's window: placing it could take that gesture's surface. */
  | { kind: 'refused' }
  | { kind: 'none' }

const firstIn = (lines: readonly Dispatch[], from: number, to: number): Dispatch | undefined =>
  lines.find((l) => l.at >= from && l.at < to && l.window !== SYSTEM_GESTURE_WINDOW)

/**
 * The event that says where gesture `i` landed: the earliest one delivered at or after its down and before the next
 * gesture's. A line carries no touch phase, so a gesture's moves and lift log lines too, and a lagging log stamps them
 * after the next gesture went down: an app tap right after a swipe on the home screen would take the swipe's window.
 * So gesture `i` is placed only when the one before it is known to have finished delivering before `i` went down: its
 * lag (first event − down) shorter than the gap from its up to `i`'s down. Unknown lag counts as too long while the gap
 * is inside the longest lag seen. Lines must be in time order.
 */
export function pickDispatch(lines: readonly Dispatch[], spans: readonly GestureSpan[], i: number): Pick {
  const span = spans[i]
  if (!span) return { kind: 'none' }
  const prev = i > 0 ? spans[i - 1] : undefined
  if (prev) {
    const prevFirst = prev.first ?? firstIn(lines, prev.down, span.down)?.at
    const gap = prev.up === undefined ? 0 : span.down - prev.up
    const lag = prevFirst === undefined ? undefined : prevFirst - prev.down
    if (lag === undefined ? gap < MAX_DISPATCH_LAG_MS : lag >= gap) return { kind: 'refused' }
  }
  const next = spans[i + 1]
  const line = firstIn(lines, span.down, next ? next.down : Infinity)
  return line ? { kind: 'found', line } : { kind: 'none' }
}
