import {
  defaultRange, dropRetried, EffectWatch, focusTap, retryCandidates, matchStep, rangeStartKeyboard, rangeStartOrientation, reachQuestions, reachTargetOf, recordedSelector,
  recordedTarget, replayStep, runFlow, scrollDirectionOf, segment, selectorFor, SocketFlowDriver, statusBarRect,
  diffAreas, SCREEN_DIFF_THRESHOLD, withoutAreas, type ScreenCells,
  toFlowSteps, waitForStableScreen, madeMidTransition, type CapturedStep, type Flow, type FlowResult, type KeyModifier, type MatchContext,
  type RawStep, type ScreenRect, type ScrollDirection, type Selector, type Step, type StepExpect, type StepRange,
} from '@tapflowio/flow-runner/browser'
import { chromeOrientation, type InterfaceTurn } from '@tapflowio/protocol/screen'
import type { AndroidChrome, ChromePayload, UIElement } from '@tapflowio/protocol'
import type { CaptureSnapshot } from '@tapflowio/protocol/capture'
import { copy } from './copy'
import { markOf, type StepMark } from './marks'
import type { StepMark as FlowStepMark } from './machine'
import type { DashboardSessionChannel, HeldResetReport } from './channel'
import type { CaptureTap } from './tap'
import { recordedAlike } from './screenCompare'
import type { Carried } from './remembered'

const base = (tap: CaptureTap) => `/api/v1/sessions/${tap.sessionId}/capture`
const SETTLE_TIMEOUT_MS = 15_000
/** What a flow's start is made of: a turn the range was held in goes after them (`matchRange`). */
const STARTS_A_FLOW = new Set<RawStep['kind']>(['clearState', 'install', 'launch'])
/** Renewed at a third of the relay's 30 s lease, so one late timer does not lose it. */
const RENEW_EVERY_MS = 10_000

export class CaptureGone extends Error {}

/** The person's steps so far, frozen for the dialog. `null` when nothing was captured on this device. */
/** The snapshot as the dialog reads it, with the taps found to be retried (P2c) by index into `stepsOf`'s steps. */
export type LoadedSnapshot = CaptureSnapshot & { retried?: number[] }

export async function loadSnapshot(
  tap: CaptureTap, alike: (a: string, b: string, masks: ScreenRect[]) => Promise<boolean> = recordedAlike,
): Promise<LoadedSnapshot | null> {
  // The pictures of the last steps go up after the steps themselves: wait for them, or the newest tiles are blank.
  await tap.flushThumbnails?.()
  const res = await fetch(`${base(tap)}/snapshot`, { method: 'POST', credentials: 'include' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not read the captured steps (${res.status})`)
  const snapshot = await res.json() as CaptureSnapshot
  return { ...snapshot, retried: await retriedTaps(tap, snapshot, alike) }
}

/**
 * The taps made again on the same element whose recorded screen did not change between the two (P2c): the first did
 * nothing, and replayed it would act where the recording's did not. Judged before Range, so the range and its strip
 * show them out. The clock in the status bar is not compared. No pictures, no verdict: the tap stays.
 */
async function retriedTaps(tap: CaptureTap, snapshot: CaptureSnapshot, alike: (a: string, b: string, masks: ScreenRect[]) => Promise<boolean>): Promise<number[]> {
  const steps = segment(snapshot.entries)
  const pictured = new Set(snapshot.thumbnails ?? [])
  const url = (s: RawStep) => (s.thumbnailKey && pictured.has(s.thumbnailKey) ? `${base(tap)}/snapshot/thumbnails/${encodeURIComponent(s.thumbnailKey)}` : null)
  const masks = [statusBarRect(tap.platform, 0)].filter((m): m is ScreenRect => m !== undefined)
  const out: number[] = []
  // The status bar is masked where it is on an upright screen: a turned one is not judged, and the tap stays.
  const chromes = snapshot.entries.filter((e) => e.kind === 'chrome')
  const upright = (at: number) => {
    const last = chromes.filter((e) => e.at <= at).at(-1)
    return last !== undefined && chromeOrientation((last as { chrome: unknown }).chrome as never) === 'portrait'
  }
  for (const [first, again] of retryCandidates(steps)) {
    if (!upright(steps[first]!.at) || !upright(steps[again]!.at)) continue
    const a = url(steps[first]!), b = url(steps[again]!)
    if (a && b && await alike(a, b, masks).catch(() => false)) out.push(first)
  }
  return out
}

export function stepsOf(snapshot: LoadedSnapshot): { steps: RawStep[]; range: StepRange } {
  const steps = dropRetried(segment(snapshot.entries), snapshot.retried ?? [])
  return { steps, range: defaultRange(steps) }
}

/** The keyboard language the range was recorded from, for the replay to start in (#1135). */
export function keyboardOf(snapshot: CaptureSnapshot, steps: readonly RawStep[], range: StepRange): string | undefined {
  const first = steps[range.start]
  return first ? rangeStartKeyboard(snapshot.entries, first.at) : undefined
}

/** Whether the person typed on the on-screen keyboard in the range, for the dialog's advice to type on their own. */
export function typedOnScreenKeyboard(steps: readonly RawStep[], range: StepRange): boolean {
  return steps.slice(range.start, range.end).some((s) => s.kind === 'keyboardKey' || ('keyboard' in s && s.keyboard === 'unknown'))
}

/**
 * Put the device's keyboard in the replay's starting language, now or once it can be (#1135). iOS sets it at once, and
 * takes it at the app's next launch, which the replay does after this. Android can switch only a keyboard that is up,
 * so it is set before the first step that types — the field tapped before it brought the keyboard up.
 */
class KeyboardAlignment {
  private pending = true

  constructor(private readonly channel: DashboardSessionChannel, private readonly sessionId: string, private readonly keyboard: string | undefined) {}

  /** Asks again only while the answer was that the keyboard is down; any other answer is final. */
  async align(): Promise<void> {
    if (!this.pending) return
    this.pending = (await this.channel.setKeyboard(this.sessionId, this.keyboard)) === 'keyboard-hidden'
  }
}

/** The steps a keyboard's language changes: what types, and the keys on it. */
const TYPES_ON_KEYBOARD = new Set<RawStep['kind']>(['text', 'type', 'paste', 'key', 'keyboardKey', 'imeAction'])

/**
 * The relay's pause on recording, held while the dialog replays or verifies: what reaches the device then is not the
 * person, and recorded it would be mixed into their capture. A 30 s lease the relay drops on its own, so a tab that
 * dies does not leave the person unrecorded. Renewed on a timer and before every step; `ensure` refuses to go on once
 * it may have lapsed, because a hidden tab's timers can run a minute late.
 */
export class PauseLease {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastOk = 0
  private ttlMs = 30_000
  private held = false
  /** Stopped for good: the dialog ended. Nothing renews after it, so a late timer cannot pause recording again. */
  private stopped = false
  private readonly inflight = new Set<Promise<boolean>>()

  constructor(private readonly tap: CaptureTap) {}

  private renew(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    const p = this.put().finally(() => this.inflight.delete(p))
    this.inflight.add(p)
    return p
  }

  private async put(): Promise<boolean> {
    const res = await fetch(`${base(this.tap)}/pause`, { method: 'PUT', credentials: 'include' }).catch(() => null)
    if (!res?.ok) return false
    const body = await res.json().catch(() => ({})) as { ttlMs?: number }
    if (typeof body.ttlMs === 'number') this.ttlMs = body.ttlMs
    this.lastOk = Date.now()
    return true
  }

  async start(): Promise<void> {
    if (this.stopped) throw new CaptureGone(copy.errors.captureEnded)
    this.held = true
    const ok = await this.renew()
    // Stopped while the first renewal was out: no timer, or it would pause recording for a dialog that is gone.
    if (!ok || this.stopped) throw new CaptureGone(copy.errors.captureEnded)
    this.timer ??= setInterval(() => { void this.renew() }, RENEW_EVERY_MS)
  }

  /** Before each step: renewed now, and refused if the last renewal is older than the lease. */
  async ensure(): Promise<void> {
    const ok = await this.renew()
    if (this.stopped) throw new CaptureGone(copy.errors.captureEnded)
    if (!ok && Date.now() - this.lastOk > this.ttlMs) throw new CaptureGone(copy.errors.pauseLost)
  }

  /** Renewed without waiting, for a run that has no step to wait in (verification's start marks). */
  touch(): void { void this.renew() }

  /**
   * For good. Gives the pause back only if this lease asked for it (another tab of the same person may hold it), and
   * only after every renewal already sent has landed, so none of them pauses recording again after the release.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.all(this.inflight)
    if (!this.held) return
    this.held = false
    await fetch(`${base(this.tap)}/pause`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  }
}

/** The chrome the channel holds now: it follows the relay, unlike the viewer's snapshot. */
async function chromeNow(channel: DashboardSessionChannel, tap: CaptureTap): Promise<ChromePayload | null> {
  return channel.chrome(tap.sessionId, 1)
}

function frameTurnOf(chrome: ChromePayload | null): 0 | 90 | 180 | 270 | undefined {
  // Android body mode sends points in the frame's space; its `streamRotation` is the turn from that frame to the screen.
  if (!chrome || 'framePng' in chrome) return undefined
  return (chrome as AndroidChrome).streamRotation
}

/** How long Match waits before judging that a replayed tap did nothing (`tapDidNothing`). */
export const RETRY_LOOK_AGAIN_MS = 1_500

/**
 * How long a screen that does not look like the recording's is looked at again before Match stops on it, and how often.
 * The screen can still be on its way: a login's answer drawn after its spinner, a splash before the first screen (wdio
 * native-demo-app, iOS 26.5: the first frame looked at after a stop already matched, within ~1 s, at every such stop).
 * Polled: the viewer draws into a canvas and says nothing when a frame lands, and a screen that has settled sends none.
 * Matched against the recording rather than waited until still, which would stop on a splash that holds still.
 */
export const LOOK_AGAIN = { forMs: 3_000, everyMs: 150 }

const TYPING = new Set<RawStep['kind']>(['text', 'type', 'paste', 'key'])
/** Steps whose picture is the screen they left: what typing or a keyboard's action did is the point of looking, and the
 *  screen before it shows a field still empty. A tap keeps the screen before, which shows what it is about to touch. */
const SHOWN_AFTER = new Set<RawStep['kind']>([...TYPING, 'imeAction'])

export interface MatchHooks {
  /** `inserted`: a step the replay added (a tap on the field typed into), not one of the range's, so not counted. */
  onStep: (step: CapturedStep, screenshot?: string, inserted?: boolean) => void
  /** Where a step is about to touch, for drawing on the device as it does (the MCP watch view's marks). */
  onTouch?: (mark: StepMark) => void
  /** What the device reset did before the replay, or `null` when its agent could not reset it (`resetDevice`). */
  onReset?: (report: HeldResetReport | null) => void
  /** The screen a step is about to act on against the one it was recorded on (1b-3b), `masks` left out of both: what it
   *  measured when they differ, `null` when they look alike. Rejects when they cannot be compared: no reason to stop at
   *  the first look, and no match when looking again. */
  compare?: (step: RawStep, masks: ScreenRect[]) => Promise<ScreenDivergence | null>
  /** The screen a touch left, by its index into the matched steps (1b-3c): Edit's "after this tap". Not on the steps,
   *  which have gone to the dialog by then, and which Edit what matched takes as they are. */
  onAfter?: (index: number, after: AfterTouch) => void
  /** What a touch was seen to do, by its index into the matched steps, as soon as it is known. */
  onObserved?: (index: number, observed: StepExpect | null) => void
  /** What an earlier Continue anyway says about the step at `index` into the steps (`Remembered`): asked only once it
   *  differs, and applied only to whether Match stops there. `turn` places its touch in the picture. */
  carried?: (index: number, step: RawStep, masks: ScreenRect[], turn: InterfaceTurn | undefined) => Promise<Carried>
  /** They differ, at `index` into the steps: resolves when the person goes on, rejects when the run is stopped. */
  onDiverged?: (index: number, divergence: ScreenDivergence) => Promise<void>
  /**
   * Whether the tap `prev` did nothing on the replay where it did something when recorded (P2c): the replay's screen
   * before it (`shotBefore`) and now (`shotNow`) not a cell different, and the recording's before it and before `next`
   * different. Asked only when the step after it looks different; `true` replays the tap once more before stopping. An
   * app now and then lets a tap go by (a Food Truck menu item, sessions af948002 and ff5d3d3c), as it did the person's
   * once. A second press is made only where the first changed nothing on the screen a moment later
   * (`RETRY_LOOK_AGAIN_MS`) and nothing in the tree Match watched (`observed`): an effect neither shows — a request
   * whose answer the screen never draws — could still be made twice, the price of not stopping on a tap that slipped.
   */
  tapDidNothing?: (prev: RawStep, next: RawStep, shotBefore: Uint8Array, shotNow: Uint8Array, masks: ScreenRect[], signal: AbortSignal) => Promise<boolean>
  /** `LOOK_AGAIN`, shortened by tests. */
  lookAgain?: { forMs: number; everyMs: number }
  signal: AbortSignal
}

/** The screen right after a touch: its tree (as the app draws it, turned by `interfaceTurn` from the picture) and its
 *  picture, an object URL. */
export interface AfterTouch {
  tree: UIElement[]
  interfaceTurn?: InterfaceTurn
  screenshot?: string
}

/** What the comparison measured, and the picture it measured: shown beside the recording's. */
export interface ScreenDivergence {
  diff: number
  /** The device's frame as it was compared, an object URL. */
  nowUrl: string
  masks: ScreenRect[]
  /** Where they differ (`diffAreas`), as fractions of the picture: drawn as boxes. */
  areas: ScreenRect[]
  /** Most of the screen differs (`MOSTLY_DIFFERENT`): said as one, not boxed place by place. Measured before any carried
   *  area is set aside, which would shrink what it is measured over. */
  mostly: boolean
  /** The grid it was measured on: judged again without carried areas. Not for the dialog's state. */
  cells: ScreenCells
  /** Areas an earlier Continue anyway set aside here: how many, and the step (into `steps`) first accepted from. */
  carried?: { count: number; from: number }
}

/** Steps that act on the screen in front of them: each is compared with its recording before it is replayed. A command
 *  (launch, URL, network), a turn and a button make their own screen — except Back, which goes wherever the screen it
 *  is pressed on leads; a key on the soft keyboard is never replayed. */
const COMPARED = new Set<RawStep['kind']>(['tap', 'longPress', 'swipe', 'holdDrag', 'pinch', 'imeAction', 'text', 'key', 'paste', 'type'])
export const compared = (raw: RawStep): boolean => !raw.dropped && (COMPARED.has(raw.kind) || (raw.kind === 'button' && raw.name === 'back'))

/**
 * A tap the app named when it was recorded (record-time observation), as Match replays it: on that element, through the
 * engine's own `tapOn` — and, when the screen does not show it, after `scroll { until }` the way the swipes before it
 * went. `target` is the element on the screen now, or `null` when it has to be scrolled to.
 */
interface NamedTap { selector: Selector; target: UIElement | null; direction?: ScrollDirection }

const OPPOSITE: Record<ScrollDirection, ScrollDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' }

/**
 * `undefined` when the tap is replayed at its point as before: no report named it, the app is drawn turned (the
 * tree's frames are not the touch's), the element cannot be named alone, or it is off the screen with no swipe before
 * it to say which way it lies.
 */
function namedTap(raw: RawStep, tree: UIElement[], previous: RawStep | undefined, turns: Pick<MatchContext, 'interfaceTurn' | 'frameTurn'>): NamedTap | undefined {
  if (raw.kind !== 'tap' || raw.dropped || raw.outcome === 'refused' || turns.interfaceTurn) return undefined
  const direction = (previous ? scrollDirectionOf(previous, turns) : null) ?? undefined
  // An iOS tree keeps rows a list has scrolled past: one whose centre is off the screen is searched for, as one the
  // tree does not hold is — `tapOn` alone would only fail it as off screen.
  const target = recordedTarget(tree, raw.touched)
  if (target && onScreen(target)) {
    const selector = selectorFor(tree, target)
    return selector ? { selector, target, ...(direction ? { direction } : {}) } : undefined
  }
  const selector = recordedSelector(raw.touched)
  return selector && direction ? { selector, target: null, direction } : undefined
}

const onScreen = (e: UIElement): boolean => {
  const x = e.frame.x + e.frame.width / 2
  const y = e.frame.y + e.frame.height / 2
  return x >= 0 && x <= 1 && y >= 0 && y <= 1
}

/** The step the replay sends before `slice[offset]`, past those left out (`dropped`). */
function previousSent(slice: RawStep[], offset: number): RawStep | undefined {
  for (let i = offset - 1; i >= 0; i--) if (!slice[i]!.dropped) return slice[i]
  return undefined
}

/** Whether `slice[offset]` is a swipe whose next sent step is a tap the app named: that tap is found by its element,
 *  so how far this swipe carried the list is not compared — a fling's length differs between any two runs. */
function swipeBeforeNamedTap(slice: RawStep[], offset: number, frameTurn?: 0 | 90 | 180 | 270): boolean {
  // One `scroll` cannot make (slanted, off the middle) leaves a tap whose element is not on the screen to its point
  // (`namedTap`), with no search to stand in for the picture.
  // On the screen, as `namedTap` reads it: an Android body mode swipe is in the frame's space (`frameTurnOf`).
  if (slice[offset]?.kind !== 'swipe' || scrollDirectionOf(slice[offset]!, frameTurn !== undefined ? { frameTurn } : {}) === null) return false
  for (let i = offset + 1; i < slice.length; i++) {
    const s = slice[i]!
    if (s.dropped) continue
    return s.kind === 'tap' && recordedSelector(s.touched) !== null
  }
  return false
}

/**
 * The start `tapflow flow run` gives a flow, on the device the session holds (#1139): the app as freshly installed, the
 * keychain, privacy grants, clipboard and simulated location reset, the network back online and the device upright.
 * An agent that cannot do it gets the app's data cleared, as before, and `null` says the rest was not.
 */
export async function resetDevice(channel: DashboardSessionChannel, sessionId: string, bundleId: string | null): Promise<HeldResetReport | null> {
  const report = await channel.runReset(sessionId, bundleId ? [bundleId] : [])
  if (report !== undefined) return report
  if (bundleId) await channel.clearState(sessionId, bundleId)
  return null
}

/**
 * Replay `range` of `steps` on the device from a clean start and match each against the screen it was replayed on.
 * The start is the flow's own: the device reset as a run's is (`resetDevice`), turned the way it was held, the app
 * launched when the range does not begin with a launch. Each step waits for the screen to settle and is matched against that read.
 * An install in the range is not replayed (below).
 */
export async function matchRange(
  tap: CaptureTap, channel: DashboardSessionChannel, lease: PauseLease,
  steps: RawStep[], range: StepRange, bundleId: string | null, hooks: MatchHooks, keyboard?: string,
): Promise<CapturedStep[]> {
  const sessionId = tap.sessionId
  const slice = steps.slice(range.start, range.end)
  await lease.start()
  // Apart from the report: `onReset?.(await …)` skips the reset itself when nobody listens.
  const reset = await resetDevice(channel, sessionId, bundleId)
  hooks.onReset?.(reset)
  hooks.signal.throwIfAborted()
  const alignment = new KeyboardAlignment(channel, sessionId, keyboard)
  await alignment.align()
  const orientation = rangeStartOrientation(steps, range)
  if (orientation) await channel.setOrientation(sessionId, orientation, 10_000)
  if (slice[0]?.kind !== 'launch') await channel.launchApp(sessionId, tap.buildId)

  const read = (signal: AbortSignal) => channel.queryUITreeWithTurn(sessionId, signal)
  // The engine Verify runs, for the taps the app named: found and tapped as `flow run` would.
  const driver = new AligningDriver(channel, sessionId, tap.buildId, alignment, hooks.onTouch, hooks.signal)
  // Whether the element was tapped, and whether a search ran — taken as having moved the screen away from the read
  // before it, since the engine does not say whether it swiped: a search that found it in place costs that tap's
  // after-screen, never a wrong one.
  const attempt = async (steps: Step[]): Promise<boolean> => {
    const result = await runFlow({ name: 'match', steps }, driver, { platform: tap.platform })
    hooks.signal.throwIfAborted()
    // A session that ended is the run's to report, not a tap to fall back from.
    if (result.status === 'failed' && result.failureKind === 'environment') throw new Error(result.failureMessage ?? 'The session ended.')
    return result.status === 'passed'
  }
  const runNamed = async (named: NamedTap): Promise<{ tapped: boolean; scrolled: boolean }> => {
    const tapIt: Step = { type: 'tapOn', selector: named.selector }
    if (named.target && await attempt([tapIt])) return { tapped: true, scrolled: false }
    // On the screen but not reached (a tab bar over the row): with a swipe before it to say which way, the search
    // brings it out from under what covers it rather than falling back to the point. An element the device never
    // reaches however the list moves would be searched to both ends of the list first; none is known, and Stop ends it.
    if (!named.direction) return { tapped: false, scrolled: false }
    // Back the other way only here: this replay sent the recorded swipe, and a fling longer than the recording's
    // carries the element past. The exported flow needs no such retry: where `toFlowSteps` turns the swipe into
    // `scroll { until }`, the scroll takes the swipe's place and starts where the swipe started, where the person's
    // direction is right; where it does not, the swipe and the tap are exported as they are. Verify runs that flow
    // before Export either way, so a wrong direction fails visibly there.
    for (const direction of [named.direction!, OPPOSITE[named.direction!]]) {
      if (await attempt([{ type: 'scroll', direction, until: named.selector }, tapIt])) return { tapped: true, scrolled: true }
    }
    return { tapped: false, scrolled: true }
  }
  const matched: CapturedStep[] = []
  // What each touch did, seen from the screen before it to the screen the next step is read on (#1125). Kept beside the
  // steps rather than on them, since those went to the dialog already; Export writes only what Verify sees too.
  const effects = new EffectWatch()
  const observed = new Map<CapturedStep, StepExpect | null>()
  let watching: { step: CapturedStep; index: number; before: UIElement[]; touched?: UIElement } | undefined
  // The watch closed last, kept so a tap pressed again can be watched again.
  let lastClosed: typeof watching
  // The screen the touch left, read before anything else happens on it: what Edit shows as "after this tap", where the
  // person picks what the touch should bring (1b-3c). The next step's own picture is not it — a typing step's is the
  // screen after the typing — so it is taken here, once, with the tree it is read with.
  const closeWatch = async (after: { elements: UIElement[]; interfaceTurn?: InterfaceTurn } | null | undefined) => {
    const closing = watching
    watching = undefined
    lastClosed = closing
    if (!closing || !after) return
    const seen = effects.observe(closing.before, after.elements, after.elements, closing.touched ? { touched: closing.touched } : {})
    observed.set(closing.step, seen)
    // Told now, not only with the steps the run returns: Edit what matched after a stop takes the steps as they came, and
    // its review must not offer a tap Match saw change the screen (review of P2c).
    hooks.onObserved?.(closing.index, seen)
    if (!hooks.onAfter) return
    const shot = await channel.screenshot(sessionId, hooks.signal).catch(() => null)
    hooks.onAfter(closing.index, {
      tree: after.elements,
      ...(after.interfaceTurn !== undefined ? { interfaceTurn: after.interfaceTurn } : {}),
      ...(shot ? { screenshot: URL.createObjectURL(new Blob([shot as BlobPart], { type: 'image/jpeg' })) } : {}),
    })
  }
  // The turn goes into the flow too: the reset, Verify and a run all start upright, so a range held sideways would
  // replay its first steps on a screen laid out the other way (design review of #1139). After the clear and launch the
  // range may open with, so the flow does not read as starting without a launch and get a second one.
  let turnPending = orientation === 'landscape'
  // The step after a turn the replay put in, or after an install it left out, begins on a screen the recording did not:
  // not compared.
  let unlike = false
  // The tap just replayed, with the screen it was replayed on: tapped once more when the next step looks different and
  // it did nothing (`tapDidNothing`). Once per tap.
  // `closed`: its watch, kept when a tap left unsent came between, whose own iteration closed nothing (CodeRabbit, #1176).
  let lastTap: { raw: RawStep; step: CapturedStep; named?: NamedTap; shot: Uint8Array; closed?: typeof watching } | undefined
  for (const [offset, raw] of slice.entries()) {
    hooks.signal.throwIfAborted()
    let skipCompare = unlike
    unlike = false
    if (turnPending && !STARTS_A_FLOW.has(raw.kind)) {
      turnPending = false
      skipCompare = true
      const turn: RawStep = { at: raw.at, endAt: raw.at, outcome: 'landed', messages: [], kind: 'rotate', to: { orientation: 'landscape' } }
      const step = matchStep(turn, { tree: [], postures: tap.postures().postures, platform: tap.platform })
      matched.push(step)
      hooks.onStep(step, undefined, true)
    }
    // Not sent again: the flow has no install (its run installs and resets), so a replay of one would uninstall the app
    // just launched and match every step after it on a home screen the flow never sees. Matched as it is, it is skipped.
    if (raw.kind === 'install') {
      const step = matchStep(raw, { tree: [], postures: tap.postures().postures, platform: tap.platform })
      matched.push(step)
      hooks.onStep(step)
      unlike = true
      continue
    }
    await lease.ensure()
    // A launch makes its own screen, so nothing on the one before it is acted on or compared: it is read only when a
    // touch is waiting for the screen it left. After the reset the app is not running, and that read went unanswered
    // until its 15 s deadline, every Match (measured, Sample SwiftUI on iOS 26.5).
    let before = raw.kind === 'launch' && !watching ? undefined : await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
    await closeWatch(before)
    const closedAtTop = lastClosed
    // Typing into a field the person focused before the range began: tapped first, and the tap goes into the flow.
    // The tree's frames are the app as drawn, which an iOS tap is not when the app is turned: then it is left as it was.
    const focusFirst = async (): Promise<RawStep | undefined> => {
      const tapIt = before && !before.interfaceTurn ? focusTap(raw, before.elements) : undefined
      if (!tapIt) return undefined
      const focusShot = await channel.screenshot(sessionId, hooks.signal).catch(() => null)
      const focusMark = markOf(tapIt)
      if (focusMark) hooks.onTouch?.(focusMark)
      await replayStep(channel, sessionId, tapIt, hooks.signal)
      const tapped = matchStep(tapIt, { tree: before!.elements, postures: tap.postures().postures, platform: tap.platform })
      matched.push(tapped)
      hooks.onStep(tapped, focusShot ? URL.createObjectURL(new Blob([focusShot as BlobPart], { type: 'image/jpeg' })) : undefined, true)
      before = await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
      return tapIt
    }
    let focus = await focusFirst()
    // The swipe before a named tap says which way to scroll for it: an iOS point is in the app's turn, an Android body
    // mode one in the frame's (`frameTurnOf`), which went unread until Android reported touches (P4).
    // The chrome the channel holds, not the viewer's last render: a turn reported since is not drawn yet (CodeRabbit).
    const namedTurns = async (b: NonNullable<typeof before>) => {
      const previous = previousSent(slice, offset)
      const frameTurn = previous?.kind === 'swipe' && previous.space === 'frame' ? frameTurnOf(await chromeNow(channel, tap)) : undefined
      return { ...(b.interfaceTurn !== undefined ? { interfaceTurn: b.interfaceTurn } : {}), ...(frameTurn !== undefined ? { frameTurn } : {}) }
    }
    let named = before ? namedTap(raw, before.elements, previousSent(slice, offset), await namedTurns(before)) : undefined
    // After the focus tap and its settle: a typed step's picture was taken at its first key, with the field focused.
    // A tap the app named is judged by finding that element, not by the picture: the list under it may sit elsewhere.
    // A focus tap went in since: pressed again now, the tap would take the field's focus away.
    const prevTap = focus ? undefined : lastTap
    lastTap = undefined
    // The screen came to match only after it was looked at again: what was read of it before is of a screen since gone.
    let cameLate = false
    // A tap made while the screen the tap before it brought was still coming (`madeMidTransition`), looking unlike its
    // recording: its picture is of the screen before that tap acted, which the replay never sees. Not a stop.
    let midTransition = false
    // The app did nothing with it when it was recorded: not sent, as nothing came of it then — sent now it would land
    // on the screen the tap before it brought. Matched all the same, so the review of taps the app ignored offers it
    // (`noResponseTaps`), left out by default.
    const actedWhenRecorded = 'touched' in raw ? raw.touched?.acted : undefined
    // Not before typing: the review never offers a tap right before typing (`noResponseTaps`), so one left unsent there
    // would stay in the flow for Verify to send where Match did not. Sent, and marked, like one nothing says about.
    const leftUnsent = async (): Promise<boolean> => {
      if (actedWhenRecorded !== false) return false
      // Past a keyboard toggle, which has no step: the review looks past it too (`noResponseTaps`; CodeRabbit, #1176).
      const next = slice.slice(offset + 1).find((s) => !s.dropped && s.kind !== 'keyboardToggle')
      if (next && (TYPING.has(next.kind) || next.kind === 'keyboardKey')) return false
      const step = matchStep(raw, { tree: before?.elements ?? [], postures: tap.postures().postures, platform: tap.platform })
      matched.push(step)
      hooks.onStep(step)
      // The tap before it is still the one the next step may press again (`retriedTap`): nothing was sent between.
      lastTap = prevTap && { ...prevTap, closed: prevTap.closed ?? (closedAtTop?.step === prevTap.step ? closedAtTop : undefined) }
      return true
    }
    // Read again once a late screen has come. The touch before this step was watched to the screen read while it was
    // late (a spinner where an alert came): watched again to the one that came, so Edit's "after this tap" and what the
    // tap should bring are the alert. Not past a focus tap, which acted on the screen since.
    const rereadLate = async (): Promise<void> => {
      cameLate = false
      before = (await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })) ?? before
      if (closedAtTop && !focus) {
        watching = closedAtTop
        await closeWatch(before)
      }
    }
    const compareNow = async (): Promise<void> => {
      if (!hooks.compare || !hooks.onDiverged) return
      const turn = before?.interfaceTurn ?? frameTurnOf(tap.chrome())
      const masks = [statusBarRect(tap.platform, turn), raw.keyboardRect].filter((m): m is ScreenRect => m !== undefined)
      // A picture that cannot be read is no reason to stop: the step is replayed as before the comparison existed.
      const first = await hooks.compare(raw, masks).catch(() => null)
      hooks.signal.throwIfAborted()
      if (!first) return
      if (madeMidTransition(raw, previousSent(slice, offset))) {
        URL.revokeObjectURL(first.nowUrl)
        midTransition = true
        return
      }
      // What Continue anyway set aside, applied after the mid-transition rule above, which judges the screen as compared
      // (design review of (c)). A step it lets go on is not looked at again and its tap before is not pressed again: the
      // person said those areas do not matter. Asked once per step. An iOS touch is in the portrait framebuffer, the
      // picture's own space; any other is turned into it as the status bar is.
      let carry: Carried | undefined
      const judged = async (d: ScreenDivergence | null): Promise<ScreenDivergence | null> => {
        if (!d || !hooks.carried) return d
        try {
          if (carry === undefined) carry = await hooks.carried(range.start + offset, raw, masks, tap.platform === 'ios' ? undefined : turn).catch(() => null)
          hooks.signal.throwIfAborted()
        } catch (e) {
          URL.revokeObjectURL(d.nowUrl)
          throw e
        }
        // A screen mostly different now is not the one the person accepted areas of (pre-PR review of (c)).
        if (!carry || (d.mostly && carry !== 'skip')) return d
        const rest = carry === 'skip' ? null : withoutAreas(d.cells, carry.areas)
        if (carry === 'skip' || !rest || rest.share <= SCREEN_DIFF_THRESHOLD) {
          URL.revokeObjectURL(d.nowUrl)
          return null
        }
        return { ...d, cells: rest, areas: diffAreas(rest), masks: [...d.masks, ...carry.areas], carried: { count: carry.areas.length, from: carry.from } }
      }
      let differs = await judged(first)
      if (!differs) return
      const look = hooks.lookAgain ?? LOOK_AGAIN
      const until = Date.now() + look.forMs
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, look.everyMs))
        // A look that fails is not a match: one failed fetch among twenty would otherwise end a real stop.
        const looked = await hooks.compare(raw, masks).catch(() => undefined)
        if (hooks.signal.aborted) {
          URL.revokeObjectURL(differs.nowUrl)
          if (looked) URL.revokeObjectURL(looked.nowUrl)
          hooks.signal.throwIfAborted()
        }
        if (looked === undefined) continue
        URL.revokeObjectURL(differs.nowUrl)
        const again = await judged(looked)
        if (!again) { cameLate = true; return }
        differs = again
      }
      const retry = prevTap ? await retriedTap(prevTap, masks, look.forMs > 0) : 'not-asked'
      // Waited for a late effect without pressing again: the screen may have come right in the meantime.
      if (retry === 'waited') {
        const now = await judged(await hooks.compare(raw, masks).catch(() => null))
        hooks.signal.throwIfAborted()
        URL.revokeObjectURL(differs.nowUrl)
        if (now) await hooks.onDiverged(range.start + offset, now)
        return
      }
      if (retry === 'pressed' && prevTap) {
        URL.revokeObjectURL(differs.nowUrl)
        before = (await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })) ?? before
        // What the tap did is what the second press did: watched again, so Edit's "after this tap" and the expectations
        // a flow gets are the screen it made. The current step is still replayed as it was chosen before (named or not).
        const reopen = lastClosed?.step === prevTap.step ? lastClosed : prevTap.closed
        if (reopen) {
          watching = reopen
          await closeWatch(before)
        }
        const still = await judged(await hooks.compare(raw, masks).catch(() => null))
        hooks.signal.throwIfAborted()
        if (still) await hooks.onDiverged(range.start + offset, still)
        return
      }
      await hooks.onDiverged(range.start + offset, differs)
    }
    // The tap before this step, replayed once more when it did nothing on the replay and something when recorded.
    // `pressed`: tapped again; `waited`: looked again a moment later and did not; `not-asked`: neither.
    const retriedTap = async (prev: NonNullable<typeof lastTap>, masks: ScreenRect[], looked: boolean): Promise<'pressed' | 'waited' | 'not-asked'> => {
      if (!hooks.tapDidNothing) return 'not-asked'
      // The tree saw it do something (Match's own watch of it): an effect the picture may not show, never pressed again.
      const seen = observed.get(prev.step)
      if (seen && ((seen.appear?.length ?? 0) > 0 || (seen.gone?.length ?? 0) > 0)) return 'not-asked'
      // An effect can come late (a request's answer drawn after the screen read as settled): judged on a picture taken
      // a moment later, so a tap that did act is not pressed twice. Measured: the open-menu screen holds 0 cells apart
      // for 5 s, so the wait costs nothing in the case this is for. Not again after `LOOK_AGAIN`, which already waited.
      if (!looked) await new Promise((resolve) => setTimeout(resolve, RETRY_LOOK_AGAIN_MS))
      hooks.signal.throwIfAborted()
      const now = await channel.screenshot(sessionId, hooks.signal).catch(() => null)
      if (!now || !(await hooks.tapDidNothing(prev.raw, raw, prev.shot, now, masks, hooks.signal).catch(() => false))) {
        hooks.signal.throwIfAborted()
        return 'waited'
      }
      hooks.signal.throwIfAborted()
      // Named: on its element again, or not at all — the point is what a named tap is there not to trust.
      if (prev.named) return (await attempt([{ type: 'tapOn', selector: prev.named.selector }])) ? 'pressed' : 'waited'
      const mark = markOf(prev.raw)
      if (mark) hooks.onTouch?.(mark)
      await replayStep(channel, sessionId, prev.raw, hooks.signal)
      return 'pressed'
    }
    // A turned app replays its taps at their points (`namedTap`), so the swipe before one is compared as any other.
    const swipeTurn = raw.kind === 'swipe' && raw.space === 'frame' ? frameTurnOf(await chromeNow(channel, tap)) : undefined
    if (compared(raw) && !skipCompare && !named && (!!before?.interfaceTurn || !swipeBeforeNamedTap(slice, offset, swipeTurn))) await compareNow()
    // Read while the screen was late, the tree may not hold what the person tapped (an alert's OK under a spinner): read
    // again, and named from that, the tap goes to its element rather than to a point on a screen that has moved.
    if (midTransition && await leftUnsent()) continue
    if (cameLate) {
      await rereadLate()
      // A field read while the screen was late (a splash before the form) may only now be there to focus.
      focus ??= await focusFirst()
      named = before ? namedTap(raw, before.elements, previousSent(slice, offset), await namedTurns(before)) : undefined
    }
    const shoot = () => channel.screenshot(sessionId, hooks.signal).catch(() => null)
    // A password is pictured before it is typed: after, Android shows its last character for a moment.
    const after = SHOWN_AFTER.has(raw.kind) && !(raw.kind === 'text' && (raw.fieldRead === 'secure' || raw.askValue))
    let shot = after ? null : await shoot()
    const chrome = await chromeNow(channel, tap)
    const turns = {
      ...(before?.interfaceTurn !== undefined ? { interfaceTurn: before.interfaceTurn } : {}),
      ...(frameTurnOf(chrome) !== undefined ? { frameTurn: frameTurnOf(chrome) } : {}),
    }
    // Asked of the screen the step is about to act on, which is the one it is matched against (#1125). A device that
    // cannot answer leaves the step to the tree's frames, as before reach; the next read reports a session that ended.
    // A tap the app named is placed by the engine on its element, not at the recorded point.
    const ask = async (on: UIElement[]) => {
      const qs = reachQuestions(raw, { tree: on, ...turns })
      const answers = qs.length > 0 ? await channel.reach(sessionId, qs.map(reachTargetOf), hooks.signal).catch(() => undefined) : undefined
      return { questions: qs, reach: answers }
    }
    let { questions, reach } = named ? { questions: [] as UIElement[], reach: undefined } : await ask(before?.elements ?? [])
    // A touch the reads could not place may be a key, typed by the keyboard's language like the others.
    if (TYPES_ON_KEYBOARD.has(raw.kind) || ('keyboard' in raw && raw.keyboard === 'unknown')) await alignment.align()
    // Nothing to type into, and no field to tap: say what to do about it rather than what the device refused.
    const unfocused = raw.kind === 'text' && !focus && !!before && !before.elements.some((e) => e.focused)
    if (named) {
      const { tapped, scrolled } = await runNamed(named)
      if (tapped) {
        const step: CapturedStep = { raw, step: { type: 'tapOn', selector: named.selector }, tree: before!.elements }
        matched.push(step)
        // What it did is read against the screen it was tapped on, which a scroll before it has moved from `before`.
        if (!scrolled) watching = { step, index: matched.length - 1, before: before!.elements, touched: named.target! }
        // Not after a search: the screen it was tapped on is not the one pictured before the search.
        if (!scrolled && shot) lastTap = { raw, step, named, shot }
        hooks.onStep(step, shot ? URL.createObjectURL(new Blob([shot as BlobPart], { type: 'image/jpeg' })) : undefined)
        continue
      }
      // Not found either way: the picture is what is left to judge by, and the point is replayed as recorded — on the
      // screen the search left, read again, and asked of the device as any other tap is.
      // A read that fails keeps the screen from before the search: an older tree is still a tree to match against.
      if (scrolled) {
        before = (await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })) ?? before
        shot = await shoot()
      }
      if (!skipCompare) await compareNow()
      if (midTransition && await leftUnsent()) continue
      if (cameLate) {
        await rereadLate()
        if (!after) shot = await shoot()
      }
      ;({ questions, reach } = await ask(before?.elements ?? []))
    }
    const mark = markOf(raw)
    if (mark) hooks.onTouch?.(mark)
    await replayStep(channel, sessionId, raw, hooks.signal).catch((e: unknown) => {
      throw unfocused ? new Error(copy.typedBeforeRange, { cause: e }) : e
    })
    const ctx: MatchContext = {
      tree: before?.elements ?? [],
      ...turns,
      ...(reach ? { reach } : {}),
      postures: tap.postures().postures,
      platform: tap.platform,
    }
    if (SHOWN_AFTER.has(raw.kind)) {
      const settled = await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
      if (settled && TYPING.has(raw.kind)) ctx.treeAfter = settled.elements
      if (after) shot = await shoot()
    }
    if (raw.kind === 'rotate') {
      const turned = await chromeNow(channel, tap)
      const o = turned ? chromeOrientation(turned) : undefined
      if (o) ctx.orientationAfter = o
    }
    const matchedStep = matchStep(raw, ctx)
    // What it did when it was recorded is not known: kept, and marked for the person to judge in Edit.
    const step: CapturedStep = midTransition && actedWhenRecorded !== true && !matchedStep.fragile
      ? { ...matchedStep, fragile: 'mid-transition' }
      : matchedStep
    matched.push(step)
    if ((raw.kind === 'tap' || raw.kind === 'longPress') && before) {
      watching = { step, index: matched.length - 1, before: before.elements, ...(questions[0] ? { touched: questions[0] } : {}) }
    }
    if (raw.kind === 'tap' && shot) lastTap = { raw, step, shot }
    hooks.onStep(step, shot ? URL.createObjectURL(new Blob([shot as BlobPart], { type: 'image/jpeg' })) : undefined)
  }
  // The last touch has no next step to read after it.
  if (watching) await closeWatch(await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS }))
  // A Stop pressed during those last reads, which do not watch the signal, is a stop, not a run that finished.
  hooks.signal.throwIfAborted()
  return matched.map((m) => (observed.has(m) ? { ...m, observed: observed.get(m)! } : m))
}

export { toFlowSteps }

/** Run the edited flow on the device with the engine `tapflow flow run` uses. No run record: a check, not a run. */
export async function verifyFlow(
  tap: CaptureTap, channel: DashboardSessionChannel, lease: PauseLease, flow: Omit<Flow, 'file'>,
  secrets: Record<string, string>, onStep: (mark: FlowStepMark) => void, keyboard?: string, onTouch?: (mark: StepMark) => void,
  onReset?: (report: HeldResetReport | null) => void,
): Promise<FlowResult> {
  await lease.start()
  // From where a run starts, as Match did: the flow's own `clearState` cannot reach the keychain or the turn (#1139).
  const reset = await resetDevice(channel, tap.sessionId, flow.appId ?? null)
  onReset?.(reset)
  const alignment = new KeyboardAlignment(channel, tap.sessionId, keyboard)
  await alignment.align()
  const driver = new AligningDriver(channel, tap.sessionId, tap.buildId, alignment, onTouch)
  return runFlow(flow, driver, {
    secrets,
    platform: tap.platform,
    // What each touch does, for Export to write beside it (#1125): a run then fails when the touch stops doing it.
    observeEffects: true,
    onStep: (mark) => {
      if (mark.phase === 'start') lease.touch()
      onStep({ index: mark.index, name: mark.name, phase: mark.phase, ...(mark.status ? { status: mark.status } : {}) })
    },
  })
}

/** The engine's driver with the keyboard aligned before the first step that types, as `matchRange` does. */
class AligningDriver extends SocketFlowDriver {
  constructor(
    channel: DashboardSessionChannel, sessionId: string, buildId: number, private readonly alignment: KeyboardAlignment,
    private readonly onTouch?: (mark: StepMark) => void,
    /** Match's Stop. The engine takes no signal, but it reads and touches through here on every poll, so a run stops at
     *  its next one rather than when a 30 s scroll search gives up (review of P2b). */
    private readonly signal?: AbortSignal,
  ) {
    super(channel, sessionId, buildId)
  }

  override queryUITree(signal?: AbortSignal) {
    this.signal?.throwIfAborted()
    return super.queryUITree(this.either(signal))
  }

  override reach(targets: UIElement[], signal?: AbortSignal) {
    this.signal?.throwIfAborted()
    return super.reach(targets, this.either(signal))
  }

  // The failure picture the engine takes after a stopped step, too.
  override screenshot(signal?: AbortSignal) {
    this.signal?.throwIfAborted()
    return super.screenshot(this.either(signal))
  }

  /** A read in flight ends at Stop as well as at the engine's own deadline. */
  private either(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (!this.signal || !signal) return signal ?? this.signal
    return AbortSignal.any([signal, this.signal])
  }

  // The flow's own points, before the driver turns them for the device: the mirror shows the device upright.
  override tap(x: number, y: number): Promise<void> {
    this.signal?.throwIfAborted()
    this.onTouch?.({ kind: 'tap', x, y })
    return super.tap(x, y)
  }

  override longPress(x: number, y: number, durationMs: number): Promise<void> {
    this.onTouch?.({ kind: 'tap', x, y })
    return super.longPress(x, y, durationMs)
  }

  // `holdMs` passed on: `scroll { until }`'s search drags through here in Match and Verify, and a swipe that dropped it
  // flung the list past the element as before.
  override swipe(from: [number, number], to: [number, number], durationMs: number, holdMs?: number) {
    this.signal?.throwIfAborted()
    this.onTouch?.({ kind: 'swipe', from, to })
    return super.swipe(from, to, durationMs, holdMs)
  }

  override async inputText(text: string): Promise<void> {
    await this.alignment.align()
    return super.inputText(text)
  }

  override async pressKey(code: string, modifiers?: KeyModifier[]): Promise<void> {
    await this.alignment.align()
    return modifiers ? super.pressKey(code, modifiers) : super.pressKey(code)
  }
}

/**
 * What one opening of the dialog holds that is not React state: the run in progress, and the screenshot URLs it made.
 * A class, so the dialog and its session share it by reference without mutating a prop.
 */
export class DialogRun {
  private controller: AbortController | null = null
  private readonly urls = new Set<string>()

  /** A new run, stopping any before it. */
  begin(): AbortSignal {
    this.controller?.abort()
    this.controller = new AbortController()
    return this.controller.signal
  }

  abort(): void { this.controller?.abort() }

  /** Whether `signal` is this run's, not one a later `begin` stopped: an answer from a stopped run is not this one's. */
  isCurrent(signal: AbortSignal): boolean { return this.controller?.signal === signal }

  private decision: (() => void) | null = null

  /** Wait for the person to go on past a step that looked different (1b-3b). Rejects when the run is stopped, which is
   *  what Back to Range and Edit what matched do: the replay must not stay parked behind a screen nobody is on. */
  decide(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason as Error); return }
      const stopped = () => { this.decision = null; reject(signal.reason as Error) }
      signal.addEventListener('abort', stopped, { once: true })
      this.decision = () => { signal.removeEventListener('abort', stopped); this.decision = null; resolve() }
    })
  }

  /** Continue anyway. */
  goOn(): void { this.decision?.() }

  keep(url: string): void { this.urls.add(url) }

  release(): void {
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}
