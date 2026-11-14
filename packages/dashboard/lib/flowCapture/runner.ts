import {
  defaultRange, EffectWatch, focusTap, matchStep, rangeStartKeyboard, rangeStartOrientation, reachQuestions, reachTargetOf, replayStep, runFlow,
  segment, SocketFlowDriver, statusBarRect,
  toFlowSteps, waitForStableScreen, type CapturedStep, type Flow, type FlowResult, type KeyModifier, type MatchContext,
  type RawStep, type ScreenRect, type StepExpect, type StepRange,
} from '@tapflowio/flow-runner/browser'
import { chromeOrientation, type InterfaceTurn } from '@tapflowio/protocol/screen'
import type { AndroidChrome, ChromePayload, UIElement } from '@tapflowio/protocol'
import type { CaptureSnapshot } from '@tapflowio/protocol/capture'
import { copy } from './copy'
import { markOf, type StepMark } from './marks'
import type { StepMark as FlowStepMark } from './machine'
import type { DashboardSessionChannel, HeldResetReport } from './channel'
import type { CaptureTap } from './tap'

const base = (tap: CaptureTap) => `/api/v1/sessions/${tap.sessionId}/capture`
const SETTLE_TIMEOUT_MS = 15_000
/** What a flow's start is made of: a turn the range was held in goes after them (`matchRange`). */
const STARTS_A_FLOW = new Set<RawStep['kind']>(['clearState', 'install', 'launch'])
/** Renewed at a third of the relay's 30 s lease, so one late timer does not lose it. */
const RENEW_EVERY_MS = 10_000

export class CaptureGone extends Error {}

/** The person's steps so far, frozen for the dialog. `null` when nothing was captured on this device. */
export async function loadSnapshot(tap: CaptureTap): Promise<CaptureSnapshot | null> {
  // The pictures of the last steps go up after the steps themselves: wait for them, or the newest tiles are blank.
  await tap.flushThumbnails?.()
  const res = await fetch(`${base(tap)}/snapshot`, { method: 'POST', credentials: 'include' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not read the captured steps (${res.status})`)
  return await res.json() as CaptureSnapshot
}

export function stepsOf(snapshot: CaptureSnapshot): { steps: RawStep[]; range: StepRange } {
  const steps = segment(snapshot.entries)
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
   *  measured when they differ, `null` when they look alike or cannot be compared. */
  compare?: (step: RawStep, masks: ScreenRect[]) => Promise<ScreenDivergence | null>
  /** The screen a touch left, by its index into the matched steps (1b-3c): Edit's "after this tap". Not on the steps,
   *  which have gone to the dialog by then, and which Edit what matched takes as they are. */
  onAfter?: (index: number, after: AfterTouch) => void
  /** They differ, at `index` into the steps: resolves when the person goes on, rejects when the run is stopped. */
  onDiverged?: (index: number, divergence: ScreenDivergence) => Promise<void>
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
}

/** Steps that act on the screen in front of them: each is compared with its recording before it is replayed. A command
 *  (launch, URL, network), a turn and a button make their own screen — except Back, which goes wherever the screen it
 *  is pressed on leads; a key on the soft keyboard is never replayed. */
const COMPARED = new Set<RawStep['kind']>(['tap', 'longPress', 'swipe', 'holdDrag', 'pinch', 'imeAction', 'text', 'key', 'paste', 'type'])
const compared = (raw: RawStep): boolean => COMPARED.has(raw.kind) || (raw.kind === 'button' && raw.name === 'back')

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
  const matched: CapturedStep[] = []
  // What each touch did, seen from the screen before it to the screen the next step is read on (#1125). Kept beside the
  // steps rather than on them, since those went to the dialog already; Export writes only what Verify sees too.
  const effects = new EffectWatch()
  const observed = new Map<CapturedStep, StepExpect | null>()
  let watching: { step: CapturedStep; index: number; before: UIElement[]; touched?: UIElement } | undefined
  // The screen the touch left, read before anything else happens on it: what Edit shows as "after this tap", where the
  // person picks what the touch should bring (1b-3c). The next step's own picture is not it — a typing step's is the
  // screen after the typing — so it is taken here, once, with the tree it is read with.
  const closeWatch = async (after: { elements: UIElement[]; interfaceTurn?: InterfaceTurn } | null | undefined) => {
    const closing = watching
    watching = undefined
    if (!closing || !after) return
    observed.set(closing.step, effects.observe(closing.before, after.elements, after.elements, closing.touched ? { touched: closing.touched } : {}))
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
    // Typing into a field the person focused before the range began: tapped first, and the tap goes into the flow.
    // The tree's frames are the app as drawn, which an iOS tap is not when the app is turned: then it is left as it was.
    const focus = before && !before.interfaceTurn ? focusTap(raw, before.elements) : undefined
    if (focus) {
      const focusShot = await channel.screenshot(sessionId, hooks.signal).catch(() => null)
      const focusMark = markOf(focus)
      if (focusMark) hooks.onTouch?.(focusMark)
      await replayStep(channel, sessionId, focus, hooks.signal)
      const tapped = matchStep(focus, { tree: before!.elements, postures: tap.postures().postures, platform: tap.platform })
      matched.push(tapped)
      hooks.onStep(tapped, focusShot ? URL.createObjectURL(new Blob([focusShot as BlobPart], { type: 'image/jpeg' })) : undefined, true)
      before = await waitForStableScreen(read, { timeoutMs: SETTLE_TIMEOUT_MS })
    }
    // After the focus tap and its settle: a typed step's picture was taken at its first key, with the field focused.
    if (hooks.compare && hooks.onDiverged && compared(raw) && !skipCompare) {
      const turn = before?.interfaceTurn ?? frameTurnOf(tap.chrome())
      const masks = [statusBarRect(tap.platform, turn), raw.keyboardRect].filter((m): m is ScreenRect => m !== undefined)
      // A picture that cannot be read is no reason to stop: the step is replayed as before the comparison existed.
      const differs = await hooks.compare(raw, masks).catch(() => null)
      hooks.signal.throwIfAborted()
      if (differs) await hooks.onDiverged(range.start + offset, differs)
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
    const questions = reachQuestions(raw, { tree: before?.elements ?? [], ...turns })
    const reach = questions.length > 0
      ? await channel.reach(sessionId, questions.map(reachTargetOf), hooks.signal).catch(() => undefined)
      : undefined
    // A touch the reads could not place may be a key, typed by the keyboard's language like the others.
    if (TYPES_ON_KEYBOARD.has(raw.kind) || ('keyboard' in raw && raw.keyboard === 'unknown')) await alignment.align()
    // Nothing to type into, and no field to tap: say what to do about it rather than what the device refused.
    const unfocused = raw.kind === 'text' && !focus && !!before && !before.elements.some((e) => e.focused)
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
    const step = matchStep(raw, ctx)
    matched.push(step)
    if ((raw.kind === 'tap' || raw.kind === 'longPress') && before) {
      watching = { step, index: matched.length - 1, before: before.elements, ...(questions[0] ? { touched: questions[0] } : {}) }
    }
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
  ) {
    super(channel, sessionId, buildId)
  }

  // The flow's own points, before the driver turns them for the device: the mirror shows the device upright.
  override tap(x: number, y: number): Promise<void> {
    this.onTouch?.({ kind: 'tap', x, y })
    return super.tap(x, y)
  }

  override longPress(x: number, y: number, durationMs: number): Promise<void> {
    this.onTouch?.({ kind: 'tap', x, y })
    return super.longPress(x, y, durationMs)
  }

  override swipe(from: [number, number], to: [number, number], durationMs: number) {
    this.onTouch?.({ kind: 'swipe', from, to })
    return super.swipe(from, to, durationMs)
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
