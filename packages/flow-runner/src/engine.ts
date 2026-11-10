import type { UIElement } from '@tapflowio/agent-core'
import type { ChromePayload, LaunchApplied, LaunchOptions, ReachResult } from '@tapflowio/protocol'
import { EXPECTING_STEPS, type Flow, type KeyModifier, type Selector, type Step, type ScrollDirection, type Viewport } from './schema.js'
import { describeAnchor, effectPending, EffectWatch, judgeEffect, type StepExpect } from './effect.js'
import { matchSelector } from './selector.js'
import { suggestSelectors, type SelectorSuggestion } from './suggest.js'
import { DeviceLacksError, EnvironmentStepError, isEnvironmentStepFailure, markEnvironmentFailure, TransientQueryError } from './errors.js'
import {
  InputRefusedError, RelayClosedError, RelayUnavailableError, RequestTimeoutError, SessionEndedError, SessionLeftError,
  SessionUnavailableError,
} from './sessionErrors.js'

/** Failures the session channel builds from what the relay said, which never quote what was typed. */
const SESSION_FAILURES = [
  SessionEndedError, SessionLeftError, SessionUnavailableError, RelayClosedError, RelayUnavailableError, RequestTimeoutError,
]
import { buttonAvailability } from '@tapflowio/protocol/buttons'
import { IME_ACTION, SELECT_ALL, SELECT_ALL_REFUSED, unavailableButton, unavailableButtonMessage } from './platformCheck.js'

/** Two fingers, each `[x, y]` normalized 0-1. */
export type PinchFingers = [[number, number], [number, number]]

// Transport-agnostic device surface the engine drives (DIP): the relay-backed
// implementation lives in RelayDriver, tests use fakes, and mcp-server adapts
// its own client. All coordinates are normalized 0-1.
export interface FlowDriver {
  // Optional AbortSignal so a stalled query can't block the poll loop past the step deadline.
  queryUITree(signal?: AbortSignal): Promise<UIElement[]>
  tap(x: number, y: number): Promise<void>
  swipe(from: [number, number], to: [number, number], durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  /** `modifiers` are held while the key is pressed; absent for a plain press. */
  pressKey(code: string, modifiers?: KeyModifier[]): Promise<void>
  openUrl(url: string): Promise<void>
  /**
   * With options, the app is started fresh with them, or the launch fails; they are never dropped (#1047). Resolves to
   * the names applied, which can include the relay's per-app defaults; `void` keeps a driver that predates it valid.
   */
  launchApp(options?: LaunchOptions): Promise<LaunchApplied | void>
  clearState(appId: string): Promise<void>
  /** The screen as image bytes. `Uint8Array` so a browser host can implement it; a Node one returns a `Buffer`. */
  screenshot(signal?: AbortSignal): Promise<Uint8Array>
  pressButton(name: string): Promise<void>
  /** Press at a point, hold it for `durationMs`, release. */
  longPress(x: number, y: number, durationMs: number): Promise<void>
  /** Two fingers from `start` to `end` over `durationMs`, moving in steps rather than jumping. */
  pinch(start: PinchFingers, end: PinchFingers, durationMs: number): Promise<void>
  /**
   * The device's chrome, waiting up to `timeoutMs` for one to arrive; `null` when none did. Optional: only an iOS
   * `pressButton` other than home needs it, and a driver without it runs those flows unchecked, as before.
   */
  chrome?(timeoutMs: number): Promise<ChromePayload | null>
  /**
   * Turn the device to `orientation` and resolve once its chrome says so, sending nothing when it already does.
   * Rejects with a `DeviceLacksError` when the device does not report which way it is held.
   */
  setOrientation(orientation: 'portrait' | 'landscape', timeoutMs: number): Promise<void>
  /**
   * Put the device in its most closed (`folded`) or most open (`unfolded`) posture and resolve once it reports being
   * there. Rejects with a `DeviceLacksError` when the device has no postures.
   */
  setPosture(posture: 'folded' | 'unfolded', timeoutMs: number): Promise<void>
  /**
   * Where touches meant for elements land, judged by the device rather than by a frame's centre (#1125). Points are in
   * the app's interface, as a selector's centre is. Optional: a driver without it taps the centre, and the step says
   * the tap was not checked.
   */
  reach?(targets: UIElement[], signal?: AbortSignal): Promise<ReachResult[]>
}

export interface EngineOptions {
  defaultTimeoutMs?: number
  pollIntervalMs?: number
  /**
   * Capture the screen a passed flow ends on (`lastScreenshot`): the evidence that "passed" means what it says — a
   * login flow that passed shows the screen it logged in to. Off by default, because it costs a screenshot per flow;
   * the CLI turns it on while it is recording the run.
   */
  captureLastScreen?: boolean
  /** Told as each step starts and ends — the run's video marks its timeline with them. Must not throw. */
  /** `label`, on a step's start, is its name as watchers may see it (`activityLabel`). */
  onStep?: (mark: { index: number; name: string; phase: 'start' | 'end'; status?: 'passed' | 'failed'; label?: string }) => void
  /**
   * The device's platform (`ios`, `android`). With it, a flow pressing a button the device lacks is refused before its
   * first step instead of answered with a press that did nothing (`failedBeforeRun`). Without it, nothing is checked.
   */
  platform?: string
  /**
   * The values `inputText: { secret: NAME }` types, by name. Only what the caller chose to give: the CLI the names its
   * `--secret` flags declare, `run_flow` none — a server's own environment holds its relay token, and a flow an agent
   * wrote must not be able to type that into a field it can read back. A flow naming a secret it was not given is
   * refused before its first step. A value is read only when its step runs and appears in no name, label or log.
   */
  secrets?: Readonly<Record<string, string>>
  /**
   * Watch what each touch does (`StepResult.observed`), for Flow Capture's Verify to write into the flow as its `expect`
   * (#1125). Costs a settled read and a confirming read after every touch, so it is for a check a person waits on, not a
   * run.
   */
  observeEffects?: boolean
}

export interface StepResult {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  /** A `tapOn` that matched nothing or several: lines to try instead, from the screen it failed on (B2). Each taps
   *  exactly the element it names on that screen. Absent when nothing on it was close. */
  suggestions?: SelectorSuggestion[]
  /**
   * Whether a touch this step made was checked to reach what it meant to (#1125), on the steps that touch:
   * `verified`, the device said the point reaches the element; `delivered`, a point the flow wrote, which nothing can
   * check; `unchecked`, the device could not judge (`reachNote` says why) and the step touched the element's centre,
   * which something may cover. Absent on a step that touches nothing.
   */
  reach?: 'verified' | 'delivered' | 'unchecked'
  reachNote?: string
  /** On a step with an `expect`: `confirmed`, the screen changed as it did when the flow was made; `failed`, it did not,
   *  and the step failed on it. */
  effect?: 'confirmed' | 'failed'
  /** With `observeEffects`, on a touch step: what the touch was seen to do, `null` when nothing that may be an anchor
   *  changed. Absent when the screen could not be read around it. */
  observed?: StepExpect | null
}

/** What a step that touches learned about its touch, for its `StepResult`. */
interface StepReport {
  reach?: StepResult['reach']
  reachNote?: string
  /** The screen read just before the touch: what its effect is judged against. */
  screen?: UIElement[]
  /** The element a selector touch went to: what tells a dialog it closed from a toast that went on its own. */
  touched?: UIElement
  effect?: StepResult['effect']
  observed?: StepExpect | null
}

export type { SelectorSuggestion }

export interface FlowResult {
  name: string
  file?: string
  status: 'passed' | 'failed'
  steps: StepResult[]
  durationMs: number
  failureMessage?: string
  failureScreenshot?: Uint8Array
  /** The screen a passed flow ended on, when `captureLastScreen` asked for it and it could be taken. */
  lastScreenshot?: Uint8Array
  /** With `observeEffects`, on a flow that touches points: the screen it ran on, for Flow Capture to pin them to. */
  viewport?: Viewport
  /**
   * Which side failed: 'environment' for relay/agent/session-level causes (the CLI
   * exits 2), 'product' for selector, assertion and other failures (exit 1). Present
   * exactly when status is 'failed'. The engine is what classifies, so consumers
   * (CLI, MCP) never branch on prose.
   */
  failureKind?: 'environment' | 'product'
  /**
   * The flow was refused before any step reached the device, because of what the flow asks for — a button this
   * device lacks. Environmental for the exit code, but **the device is not suspect**: a `--parallel` worker leaves a
   * device after an environment failure, and must not leave a healthy one over a flow that could never run on it.
   */
  failedBeforeRun?: true
  /**
   * A step asked for something this device cannot do (`DeviceLacksError`) — a posture on a device that does not
   * fold. Environmental, and like `failedBeforeRun` it does not make the device suspect.
   */
  deviceLacks?: true
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500
const FAILURE_SCREENSHOT_TIMEOUT_MS = 10_000
/** Shorter than a failure's: a passed flow is waited on by the next one, and this is evidence, not diagnosis. */
const LAST_SCREEN_TIMEOUT_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647

// scroll direction = where the user wants to reveal more content, so the
// finger gesture goes the opposite way (scroll down → swipe up).
const SCROLL_GESTURES: Record<ScrollDirection, { from: [number, number]; to: [number, number] }> = {
  down: { from: [0.5, 0.7], to: [0.5, 0.3] },
  up: { from: [0.5, 0.3], to: [0.5, 0.7] },
  right: { from: [0.8, 0.5], to: [0.2, 0.5] },
  left: { from: [0.2, 0.5], to: [0.8, 0.5] },
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const round4 = (n: number): number => Math.round(n * 10000) / 10000

async function captureScreenshot(driver: FlowDriver, timeoutMs: number): Promise<Uint8Array | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      driver.screenshot(controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function describeSelector(sel: Selector): string {
  if (sel.text !== undefined) return `"${sel.text}"`
  const parts: string[] = []
  if (sel.id !== undefined) parts.push(`id="${sel.id}"`)
  if (sel.label !== undefined) parts.push(`label="${sel.label}"`)
  if (sel.role !== undefined) parts.push(`role=${sel.role}`)
  if (sel.index !== undefined) parts.push(`index=${sel.index}`)
  return parts.join(', ')
}

// What a run record and a failure message show. Argument values are shown, since they are what makes this launch
// differ from a plain one; env values never are, because env is where a flow is told to put a secret.
function describeLaunchOptions(opts: LaunchOptions): string {
  const args = Object.entries(opts.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  const env = Object.keys(opts.env ?? {}).map((k) => `${k}=***`)
  return [...args, ...(env.length > 0 ? [`env ${env.join(', ')}`] : [])].join(', ')
}

// The step's own options, then the keys the relay's per-app defaults added (names only: their values are not sent
// back, and a run record must not depend on reading the relay's config to be understood). The relay keeps a step name
// to 500 characters, so a launch with dozens of long keys loses the last of them there.
function describeLaunch(options: LaunchOptions | undefined, applied: LaunchApplied | void): string {
  const own = options ? describeLaunchOptions(options) : ''
  const args = applied ? applied.arguments.filter((k) => !Object.hasOwn(options?.arguments ?? {}, k)) : []
  const env = applied ? applied.env.filter((k) => !Object.hasOwn(options?.env ?? {}, k)) : []
  const config = [...args, ...(env.length > 0 ? [`env ${env.join(', ')}`] : [])].join(', ')
  const parts = [own, config ? `config: ${config}` : ''].filter(Boolean).join('; ')
  return parts ? `launchApp(${parts})` : 'launchApp'
}

function describeStep(step: Step): string {
  switch (step.type) {
    case 'clearState': return step.appId ? `clearState(${step.appId})` : 'clearState'
    case 'launchApp': return describeLaunch(step.options, undefined)
    case 'tapOn': return `tapOn(${describeSelector(step.selector)})`
    case 'tapPoint': return `tapOn([${step.at.join(',')}])`
    case 'inputText': return `inputText("${step.text}"${step.replace ? ', replace' : ''})`
    case 'inputSecret': return `inputText(secret ${step.name}${step.replace ? ', replace' : ''})`
    case 'pressKey': return `pressKey(${withModifiers(step.modifiers, step.code)})`
    case 'imeAction': return 'imeAction'
    case 'swipe': return `swipe(${step.from} → ${step.to})`
    case 'scroll': return step.until ? `scroll(${step.direction} until ${describeSelector(step.until)})` : `scroll(${step.direction})`
    case 'openUrl': return `openUrl(${step.url})`
    case 'assertVisible': return `assertVisible(${describeSelector(step.selector)})`
    case 'assertNotVisible': return `assertNotVisible(${describeSelector(step.selector)})`
    case 'pressButton': return `pressButton(${step.name})`
    case 'longPressOn': return `longPressOn(${describeSelector(step.selector)}, ${step.durationMs}ms)`
    case 'longPressPoint': return `longPressOn([${step.at.join(',')}], ${step.durationMs}ms)`
    case 'pinch': return `pinch(${Array.isArray(step.on) ? `[${step.on.join(',')}]` : describeSelector(step.on)}, ×${step.scale})`
    case 'setOrientation': return `setOrientation(${step.orientation})`
    case 'setPosture': return `setPosture(${step.posture})`
  }
}

/**
 * A step's name as the watchers of a session may see it (A2) — the whole team, live. Unlike `describeStep`, which
 * JUnit, video marks and `run_flow`'s results keep using, it drops what a flow types (`inputText`), the URL it opens
 * (a deep link can carry a token) and a key that types a character. Keep the key rule in step with the relay's
 * `keyForWatchers`.
 */
export function activityLabel(step: Step): string {
  switch (step.type) {
    case 'inputText': return `inputText (${[...step.text].length} chars)`
    case 'inputSecret': return 'inputText (secret)'
    case 'openUrl': return 'openUrl'
    // The modifiers stay: a shortcut names no secret, and the character under it is hidden as before.
    case 'pressKey': return `pressKey(${withModifiers(step.modifiers, typesCharacter(step.code) ? 'character' : step.code)})`
    default: return describeStep(step)
  }
}

function withModifiers(modifiers: readonly string[] | undefined, key: string): string {
  return modifiers?.length ? `${modifiers.join('+')}+${key}` : key
}

function typesCharacter(code: string): boolean {
  return /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal|Comma|Equal|ParenLeft|ParenRight|Hash|Star)|Space|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/.test(code)
    || code.length === 1
}

function normalizeTimeoutMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new EnvironmentStepError(`${label} must be a positive finite duration no greater than ${MAX_TIMER_MS}ms`)
  }
  const rounded = Math.round(value)
  if (rounded <= 0) {
    throw new EnvironmentStepError(`${label} must be at least 1ms (got ${value}ms, which rounds to 0ms)`)
  }
  return rounded
}

export { matchSelector } from './selector.js'

class StepFailure extends Error {
  suggestions?: SelectorSuggestion[]
}

// Query the tree, surfacing a transient failure (foreground race, idle timeout, agent/network blip)
// so the polling caller keeps waiting until its deadline. Permanent failures propagate and fail now.
// The query is bounded by an AbortSignal set to the remaining deadline so a stalled response can't
// block the loop past the step's timeout.
async function queryOrRetry(
  driver: FlowDriver,
  deadline: number,
): Promise<{ tree: UIElement[] } | { transient: TransientQueryError }> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  try {
    return { tree: await driver.queryUITree(signal) }
  } catch (e) {
    if (e instanceof TransientQueryError) {
      if (signal.aborted) cutAtDeadline.add(e)
      return { transient: e }
    }
    throw e
  }
}

/** Queries this runner cut off itself because the step's deadline came, not because anything failed. */
const cutAtDeadline = new WeakSet<TransientQueryError>()

/** A query cut off at the deadline does not replace a real error seen before it. */
function latestError(prev: TransientQueryError | undefined, next: TransientQueryError): TransientQueryError {
  return prev && cutAtDeadline.has(next) ? prev : next
}

function withLastError(base: string, lastError: TransientQueryError | undefined): string {
  return lastError ? `${base} (last query error: ${lastError.message})` : base
}

function queryDeadlineFailure(base: string, lastError: TransientQueryError | undefined): Error {
  const message = withLastError(base, lastError)
  return lastError
    ? new EnvironmentStepError(message, { cause: lastError })
    : new StepFailure(message)
}

// The single place a poll loop gives up at its deadline. A trailing transient
// blip must not turn a product miss into an environment failure: when a tree
// was seen, the element genuinely never matched, so the deadline stays a
// StepFailure (product). Both exits — the direct check and the wait below —
// go through here, since timing decides which one fires and they must agree.
//
// A query this runner cut off at the deadline is left out of a product failure's message: it names nothing that went
// wrong, and read as `last query error: … aborted due to timeout` it sent people after the agent when the selector
// simply never matched. With no tree seen it stays: then the query never answering is the finding.
function deadlineError(base: string, lastError: TransientQueryError | undefined, sawTree: boolean): Error {
  if (!sawTree) return queryDeadlineFailure(base, lastError)
  return new StepFailure(withLastError(base, lastError && cutAtDeadline.has(lastError) ? undefined : lastError))
}

async function waitForNextPoll(deadline: number, pollIntervalMs: number, base: string, lastError: TransientQueryError | undefined, sawTree: boolean): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw deadlineError(base, lastError, sawTree)
  await delay(Math.min(pollIntervalMs, remaining))
  if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
}

/**
 * Where to touch the element `sel` names (#1125): the point the device says reaches it, not its frame's centre, which a
 * tab bar, a floating button or a scrim can cover — measured, a row's centre under a tab bar was the next tab's button,
 * and the tap passed. A reach must agree twice running before it is used: a list still settling from a swipe moves the
 * point between reads. Covered, off screen or not the element read: the selector is resolved again until its timeout,
 * then the step fails saying which. A device that cannot judge gets the centre, and the step says so.
 */
async function touchPoint(
  driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number, report: StepReport,
): Promise<[number, number]> {
  const deadline = Date.now() + normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const centre = (e: UIElement): [number, number] => [round4(e.frame.x + e.frame.width / 2), round4(e.frame.y + e.frame.height / 2)]
  // The read the element was found in is the screen before the touch, which its effect is judged against.
  const seen = (tree: UIElement[]) => { report.screen = tree }
  const blocked = (r: ReachResult): string => r.state === 'reachable' ? `${describeSelector(sel)} kept moving, so no touch could be placed on it`
    : r.state === 'occluded' ? `${describeSelector(sel)} is covered${r.by ? ` by ${r.by}` : ''}: a touch on it would land on that instead`
    : r.state === 'offscreen' ? `${describeSelector(sel)} is not on the screen`
    : `${describeSelector(sel)} was not where the screen was read (${r.state === 'missing' ? r.candidates : 0} near it)`
  let el = await resolveOne(driver, sel, timeoutMs, pollIntervalMs, seen)
  if (!driver.reach) {
    report.reach = 'unchecked'
    report.reachNote = 'this driver cannot ask where a touch lands'
    report.touched = el
    return centre(el)
  }
  let last: [number, number] | undefined
  for (;;) {
    let r: ReachResult | undefined
    try {
      [r] = await driver.reach([el])
    } catch (e) {
      // A blip between here and the agent (a 502 while it reconnects, a 504) is polled past, as a tree read's is; one
      // that lasts to the deadline leaves the device unable to judge, and the touch goes where it went before reach.
      if (!(e instanceof TransientQueryError)) throw e
      if (Date.now() >= deadline) {
        report.reach = 'unchecked'
        report.reachNote = `the device did not say where a touch lands: ${e.message}`
        report.touched = el
        return centre(el)
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
      continue
    }
    if (!r || r.state === 'unknown') {
      report.reach = 'unchecked'
      report.reachNote = r?.reason ?? 'no answer'
      report.touched = el
      return centre(el)
    }
    if (r.state === 'reachable') {
      if (last && Math.abs(last[0] - r.point[0]) < REACH_AGREE && Math.abs(last[1] - r.point[1]) < REACH_AGREE) {
        report.reach = 'verified'
        report.touched = el
        return [round4(r.point[0]), round4(r.point[1])]
      }
      last = r.point
    } else {
      last = undefined
    }
    if (Date.now() >= deadline) throw new StepFailure(blocked(r))
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
    try {
      el = await resolveOne(driver, { ...sel, timeoutMs: Math.max(1, deadline - Date.now()) }, timeoutMs, pollIntervalMs, seen)
    } catch (e) {
      // The read again can run out of what the waiting left it (iOS E2E: a row under a scrim failed as "no element
      // matched … within 0.149s", and as the environment's, since that read saw no tree of its own). The element still
      // on the last screen read is not missing: what stood in the way is, and that is the product's.
      const ranOut = e instanceof StepFailure || (e instanceof EnvironmentStepError && e.cause instanceof TransientQueryError)
      if (ranOut && report.screen && matchSelector(report.screen, sel).length === 1) throw new StepFailure(blocked(r))
      throw e
    }
  }
}

/** One read of the screen within `timeoutMs`, or `undefined`: the effect of a touch is then judged without it. */
async function readScreen(driver: FlowDriver, timeoutMs: number): Promise<UIElement[] | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) return q.tree
    if (Date.now() >= deadline) return undefined
    await delay(Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }
}

/**
 * After a touch whose flow says what it brings (#1125): read until the screen shows it, then pass; fail at the timeout
 * naming what is missing. The screen before the touch must have left it something to do — otherwise what the flow
 * expects was there already, and seeing it again proves nothing about the touch.
 */
async function confirmEffect(driver: FlowDriver, expect: StepExpect, report: StepReport, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  report.effect = 'failed'
  if (report.screen && !effectPending(expect, report.screen)) {
    const already = [
      ...(expect.appear ?? []).map((a) => `${describeAnchor(a)} was showing`),
      ...(expect.gone ?? []).map((a) => `${describeAnchor(a)} was gone`),
    ]
    throw new StepFailure(`the screen already looked as this touch leaves it (${already.join(', ')}), so nothing shows the touch did anything — the screen before it is not the one the flow was made on`)
  }
  const deadline = Date.now() + timeoutMs
  let verdict = judgeEffect(expect, [])
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      verdict = judgeEffect(expect, q.tree)
      if (verdict.met) {
        report.effect = 'confirmed'
        return
      }
    }
    if (Date.now() >= deadline) break
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }
  if (verdict.met) return
  throw new StepFailure(`the touch was sent, but ${describeAnchor(verdict.missing)} ${verdict.kind === 'appear' ? 'did not appear' : 'did not go away'} within ${timeoutMs / 1000}s, as it did when the flow was made`)
}

/** How long after the screen settles a touch's effect is read again: what is gone by then was not its effect. */
const OBSERVE_CONFIRM_MS = 1_500

async function observeTouch(
  driver: FlowDriver, before: UIElement[] | undefined, timeoutMs: number, pollIntervalMs: number,
  watch: EffectWatch, opts: { hidden: string[]; touched?: UIElement },
): Promise<StepExpect | null | undefined> {
  if (!before) return undefined
  try {
    const read = (signal: AbortSignal) => driver.queryUITree(signal).then((elements) => ({ elements }))
    const after = await waitForStableScreen(read, { timeoutMs, pollIntervalMs })
    if (!after) return undefined
    await delay(OBSERVE_CONFIRM_MS)
    const confirm = await readScreen(driver, timeoutMs)
    if (!confirm) return undefined
    return watch.observe(before, after.elements, confirm, opts)
  } catch {
    // Watching is for the person verifying; a read that fails here says nothing about the step, which the next one reads.
    return undefined
  }
}

async function resolveOne(
  driver: FlowDriver,
  sel: Selector,
  timeoutMs: number,
  pollIntervalMs: number,
  seen?: (tree: UIElement[]) => void,
): Promise<UIElement> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  // The last screen seen, for suggestions if the step fails on it. A failure with no tree behind it is the
  // environment's, and has nothing to suggest from.
  let lastTree: UIElement[] | null = null
  try {
    for (;;) {
      const q = await queryOrRetry(driver, deadline)
      if ('tree' in q) {
        sawTree = true
        lastTree = q.tree
        seen?.(q.tree)
        lastError = undefined // a successful query clears any earlier transient error
        const matches = matchSelector(q.tree, sel)
        if (matches.length === 1) return matches[0]
        if (matches.length > 1) {
          const described = matches.slice(0, 5).map((m) => `${m.role} "${m.role === 'input' || m.secure === true ? '' : m.label}"${m.identifier ? ` id=${m.identifier}` : ''}${m.placeholder ? ` placeholder="${m.placeholder}"` : ''}`).join(' | ')
          throw new StepFailure(`${matches.length} elements match ${describeSelector(sel)} — add an index or a more specific role/label (candidates: ${described})`)
        }
      } else {
        lastError = latestError(lastError, q.transient)
      }
      const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
      if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
      await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
    }
  } catch (e) {
    if (e instanceof StepFailure && lastTree) {
      const suggestions = suggestSelectors(lastTree, sel)
      if (suggestions.length > 0) e.suggestions = suggestions
    }
    throw e
  }
}

async function waitVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length > 0) return
    } else {
      lastError = latestError(lastError, q.transient)
    }
    const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
  }
}

async function waitNotVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length === 0) return
    } else {
      // A transient failure means we can't confirm the element is gone — keep polling, don't return.
      lastError = latestError(lastError, q.transient)
    }
    const base = `element ${describeSelector(sel)} is still visible after ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
  }
}

/**
 * After `launchApp`, wait for the app's first screen before the next step. A coordinate step sent before that —
 * `scroll`, `swipe`, `inputText`, `pressKey` — is acknowledged by the agent and dropped by the app, so it passed
 * while doing nothing and the flow failed one step later under the wrong name (seen on iOS: `scroll` right after
 * `launchApp`, 5 of 5). Selector steps never had this problem: they poll.
 *
 * **Ready is the tree's structure holding still for `SETTLE_MS`**, not the first tree that reads. An app that draws
 * its own splash answers with the splash first — measured on a Flutter iOS app: one element, then the real screen
 * 45–270 ms later — so a single read cannot tell the two apart. The structure is each element's role, label and
 * identifier, in order: frames are left out because an animating screen moves them forever. An empty tree is a
 * structure like any other, so a game, a canvas or a WebView-only screen is ready once it has read empty for a
 * second, instead of waiting out the timeout.
 *
 * It rests on what the agents promise (see `DeviceAgent.queryUITree`): a read fails until the launched app's UI is
 * up (iOS), or the launch reply already waited for the first frame (Android). An agent that answered an empty tree
 * before then would read as settled.
 *
 * **Best effort: it never fails the step.** A screen whose labels keep changing (a carousel, a running clock) never
 * holds still, so no new read starts once `SETTLE_CAP_MS` has passed since the first successful read; the one in
 * flight still counts. A query that fails is the next
 * step's to report, as it was before. A splash that holds still for longer than `SETTLE_MS` still reads as ready.
 */
async function waitForScreen(driver: FlowDriver, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  try {
    await waitForStableScreen((signal) => driver.queryUITree(signal).then((elements) => ({ elements })), { timeoutMs, pollIntervalMs })
  } catch {
    // Not this step's to report, permanent errors included. `launchApp` never read the tree before, so failing
    // here would fail flows that use no selector on any agent whose tree is unusable — one predating the frame
    // clipping answers `invalid response shape`, permanently. A session that is really gone fails the next step,
    // which names it the same way.
  }
}

/**
 * Read the screen until its structure — each element's role, label and identifier — has held still for a second, capped
 * 3 s after the first successful read, and answer the last read: what `launchApp` waits for, and what Flow Capture's
 * replay reads before each step (#1125), so the host matches against a settled screen without reading it once more (an
 * emulator dump takes ~2.5 s). `undefined` when no read succeeded before `timeoutMs`. A `TransientQueryError` is polled
 * past; anything else is thrown.
 */
export async function waitForStableScreen<T extends { elements: UIElement[] }>(
  read: (signal: AbortSignal) => Promise<T>,
  { timeoutMs, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: { timeoutMs: number; pollIntervalMs?: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let shape: string | undefined
  // When this structure was first read. Not the previous read's time: iOS reads land ~550 ms apart, so requiring
  // SETTLE_MS between two consecutive reads would never be met there.
  let shapeSince = 0
  let settleBy = deadline
  for (;;) {
    const started = Date.now()
    // Bounded by the step's deadline, not the cap: the cap only decides whether to start another read. Cutting a
    // read at the cap would abort every confirming read on a device whose dump takes close to it (~2.5 s on an
    // emulator), and a screen that holds still would always wait the full cap there.
    const signal = AbortSignal.timeout(Math.max(1, deadline - started))
    let got: T | undefined
    try {
      got = await read(signal)
    } catch (e) {
      // A failed read neither confirms nor resets: on iOS it means "not up yet", and on Android one costs a dump.
      if (!(e instanceof TransientQueryError)) throw e
    }
    const now = Date.now()
    if (got) {
      last = got
      if (shape === undefined) settleBy = Math.min(deadline, now + SETTLE_CAP_MS)
      const next = screenShape(got.elements)
      if (next !== shape) {
        shape = next
        shapeSince = now
      } else if (now - shapeSince >= SETTLE_MS) {
        return last
      }
    }
    if (now >= settleBy) return last
    // The poll interval counts from the read's start: an Android dump alone takes ~2.5 s.
    await delay(Math.min(Math.max(0, pollIntervalMs - (now - started)), settleBy - now))
  }
}

// A dump takes ~2.5 s on an emulator, so the default step timeout would allow about three swipes; a list is longer than
// that. The end of the list stops it sooner (below), so the wider default costs time only when the element is missing.
const SCROLL_UNTIL_MS = 30_000
// Two, not one: a swipe sent while the screen is still changing can be acknowledged and dropped (see `waitForScreen`),
// and one unchanged read after it would end the step at the top of a list that scrolls fine.
const SCROLL_END_READS = 2

// Both agents clip a frame to the screen and drop what is wholly off it, so an element cut by the edge the list
// scrolls in from reaches that edge exactly. Such a sliver is not arrived: under a translucent bar its center is the
// bar's. Keyed by the scroll direction, which names where new content enters (scroll down → from the bottom).
const CLEAR_OF_ENTERING_EDGE: Record<ScrollDirection, (f: UIElement['frame']) => boolean> = {
  down: (f) => f.y + f.height < 1,
  up: (f) => f.y > 0,
  right: (f) => f.x + f.width < 1,
  left: (f) => f.x > 0,
}

// Cut at both ends of the scroll axis: an element larger than the screen, whose clipped frame reads the same wherever
// the list is — so its staying put says nothing about having arrived.
const SPANS_SCROLL_AXIS: Record<ScrollDirection, (f: UIElement['frame']) => boolean> = {
  down: (f) => f.y <= 0 && f.y + f.height >= 1,
  up: (f) => f.y <= 0 && f.y + f.height >= 1,
  right: (f) => f.x <= 0 && f.x + f.width >= 1,
  left: (f) => f.x <= 0 && f.x + f.width >= 1,
}

/** How long `scrollUntil` waits for the list it flung to stop under the element it found. */
const SETTLE_MATCH_MS = 2_000
/** How near two reach answers must be to count as the same point: under one thousandth of the screen. */
const REACH_AGREE = 0.001

/**
 * The element `scrollUntil` found, read again until it is where it was the read before: the last swipe's fling is
 * still carrying the list when it comes into view. A tap read off a moving list lands a row further on, and on iOS a
 * tap on a scrolling list only stops it — the step after passed with nothing tapped (iOS E2E, `tapOn("Row 17")`).
 * Bounded; past the bound, or on a failed read, the step goes on as before.
 */
async function settleMatch(driver: FlowDriver, sel: Selector, tree: UIElement[], deadline: number, pollIntervalMs: number): Promise<void> {
  const at = (t: UIElement[]) => JSON.stringify(matchSelector(t, sel).map((m) => [Math.round(m.frame.x * 1000), Math.round(m.frame.y * 1000)]))
  const until = Math.min(deadline, Date.now() + SETTLE_MATCH_MS)
  let last = at(tree)
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, until - Date.now()))))
    const q = await queryOrRetry(driver, until).catch(() => undefined)
    if (!q || !('tree' in q)) return
    const now = at(q.tree)
    if (now === last) return
    last = now
  }
}

/**
 * Whether one of `matches` is fully in view: the device reaches it at its centre. `true` where the device cannot judge,
 * since a frame in from the screen's edge is then all there is to go on — which is how it stopped before reach.
 */
async function inView(driver: FlowDriver, matches: UIElement[]): Promise<boolean> {
  if (!driver.reach) return true
  let results: ReachResult[]
  try {
    results = await driver.reach(matches)
  } catch (e) {
    // A blip on the way to the agent is a device that cannot judge this time: stop on the frame, as before reach.
    if (e instanceof TransientQueryError) return true
    throw e
  }
  return results.some((r) => r.state === 'unknown' || (r.state === 'reachable' && r.atCentre))
}

/** What the end-of-list check compares: the structure and where it is, since one long text scrolls by moving alone. */
function scrolledShape(tree: UIElement[]): string {
  return JSON.stringify(tree.map((e) => [e.role, e.label, e.identifier ?? '', Math.round(e.frame.x * 100), Math.round(e.frame.y * 100)]))
}

/**
 * Swipe the way `scroll` does until an element matching `sel` is on screen. How far one swipe goes differs from run to
 * run (a fling's length depends on its speed and the platform), so a flow that means "the row is now in view" says
 * that rather than a number of swipes. Reads before the first swipe, so an element already in view costs none. At the
 * end of the list — the screen stops changing — any match on screen is taken, cut or not; none fails as the product's,
 * as does the selector's timeout.
 *
 * No selector suggestions on failure, for `assertVisible`'s reason (see `suggest.ts`): a `tapOn` line offered in place
 * of a check that something is there would turn a regression green.
 */
async function scrollUntil(driver: FlowDriver, direction: ScrollDirection, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? Math.max(timeoutMs, SCROLL_UNTIL_MS), 'selector timeout')
  const deadline = Date.now() + waitMs
  const gesture = SCROLL_GESTURES[direction]
  const clear = CLEAR_OF_ENTERING_EDGE[direction]
  const spans = SPANS_SCROLL_AXIS[direction]
  let lastError: TransientQueryError | undefined
  let sawTree = false
  let shape: string | undefined
  // A screen read without the element is followed by one swipe and a failed read by none, so between any two screens
  // read lies exactly one swipe: a screen equal to the last one is a swipe that moved nothing.
  let unchanged = 0
  // A match that stays where it is across swipes cannot be brought further in, even while something else on the screen
  // keeps changing (a clock, a spinner) and so keeps the screen from ever reading unchanged.
  let matchShape: string | undefined
  let matchStill = 0
  let swiped = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    // Swipe only after a screen was read and the element was not on it: a failed read says nothing about where the
    // list is, and a blind swipe could carry the element past.
    let read = false
    if ('tree' in q) {
      sawTree = true
      read = true
      lastError = undefined
      const matches = matchSelector(q.tree, sel)
      // In from the edge is not in view when a bar covers it there: a row under a tab bar is inside the screen and its
      // centre is the tab (#1125). So where the device can judge, it must reach the element at its centre.
      if (matches.some((m) => clear(m.frame)) && await inView(driver, matches.filter((m) => clear(m.frame)))) {
        return swiped ? settleMatch(driver, sel, q.tree, deadline, pollIntervalMs) : undefined
      }
      const pinned = matches.filter((m) => !spans(m.frame))
      const at = pinned.length > 0 ? scrolledShape(pinned) : undefined
      matchStill = at !== undefined && at === matchShape ? matchStill + 1 : 0
      matchShape = at
      if (matchStill >= SCROLL_END_READS) return
      const next = scrolledShape(q.tree)
      unchanged = next === shape ? unchanged + 1 : 0
      shape = next
      if (unchanged >= SCROLL_END_READS) {
        if (matches.length > 0) return
        throw new StepFailure(`scrolled ${direction} to the end without ${describeSelector(sel)} coming on screen`)
      }
    } else {
      lastError = latestError(lastError, q.transient)
    }
    const base = `no element matched ${describeSelector(sel)} on screen after scrolling ${direction} for ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
    if (read) { await driver.swipe(gesture.from, gesture.to, 300); swiped = true }
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
  }
}

const SETTLE_MS = 1000
const SETTLE_CAP_MS = 3 * SETTLE_MS

// JSON, not a joined string: a label containing the separator would make two different screens equal.
function screenShape(tree: UIElement[]): string {
  return JSON.stringify(tree.map((e) => [e.role, e.label, e.identifier ?? '']))
}

// Fingers keep this far inside the screen's edge; an edge pixel is often the system's own gesture area.
const PINCH_EDGE = 0.02
// The wider of the two spacings, as a half-width. Spread out further and a recogniser gains nothing.
const PINCH_WIDE_HALF = 0.3
// The narrower one may not close past this: two touches that near can be read as one.
const PINCH_NARROW_HALF = 0.02

/**
 * Two fingers mirrored about `center` whose spacing changes by exactly `scale`. The scale is what the flow means, so it
 * is kept; the spacing is what adapts — the axis with more room, as wide as that room allows up to
 * `PINCH_WIDE_HALF`. `null` when even that cannot fit the narrower spacing, which only a center at a corner reaches.
 */
function pinchFingers(center: [number, number], scale: number): { start: PinchFingers; end: PinchFingers } | null {
  const [cx, cy] = center
  const roomX = Math.min(cx - PINCH_EDGE, 1 - PINCH_EDGE - cx)
  const roomY = Math.min(cy - PINCH_EDGE, 1 - PINCH_EDGE - cy)
  const alongX = roomX >= roomY
  const wide = Math.min(PINCH_WIDE_HALF, alongX ? roomX : roomY)
  const narrow = wide / Math.max(scale, 1 / scale)
  if (narrow < PINCH_NARROW_HALF) return null
  const fingers = (half: number): PinchFingers => alongX
    ? [[round4(cx - half), cy], [round4(cx + half), cy]]
    : [[cx, round4(cy - half)], [cx, round4(cy + half)]]
  return scale > 1 ? { start: fingers(narrow), end: fingers(wide) } : { start: fingers(wide), end: fingers(narrow) }
}

// Resolves to what a launch applied; every other step to nothing.
async function executeStep(
  step: Step, flow: Flow, driver: FlowDriver, timeoutMs: number, pollIntervalMs: number,
  secrets: EngineOptions['secrets'], report: StepReport,
): Promise<LaunchApplied | void> {
  switch (step.type) {
    case 'clearState': {
      // `parseFlow` rejects the bare form without a flow-level appId, but `runFlow` is exported and does not
      // parse — an embedder can hand it a `Flow` built by hand, and `flow.appId!` used to launder that into
      // `app:clear-state` with `payload: {}` on the wire for the device to answer 'bundleId missing'. Refuse
      // here instead, where the cause is still nameable. Empty string too: `''` type-checks all the way down.
      const appId = step.appId ?? flow.appId
      if (!appId) throw new StepFailure('clearState has no app id — set it on the step or as the flow-level "appId"')
      await driver.clearState(appId)
      return
    }
    case 'launchApp': {
      const applied = await driver.launchApp(step.options)
      // Never throws: an app that dies on a default fails the next step, and this one's name already says which.
      await waitForScreen(driver, timeoutMs, pollIntervalMs)
      return applied
    }
    case 'tapOn': {
      const [x, y] = await touchPoint(driver, step.selector, timeoutMs, pollIntervalMs, report)
      return driver.tap(x, y)
    }
    case 'tapPoint': report.reach = 'delivered'; return driver.tap(step.at[0], step.at[1])
    case 'inputText':
      // Selected first, so the text takes the field's place: pasting over a selection replaces it, and a Backspace is
      // not needed — one in an empty chip or code field deletes a chip or moves focus back (#1135).
      if (step.replace) await selectAll(driver)
      return driver.inputText(step.text)
    case 'inputSecret': {
      const value = secretValue(secrets, step.name)
      // Checked before the run; this is for a caller that ran a flow without going through `runFlow`'s check.
      if (value === undefined) throw new EnvironmentStepError(`the secret ${step.name} was not given to this run`)
      // Outside the guard below: the select-all names no text, and its refusal says what the device lacks.
      if (step.replace) await selectAll(driver)
      try {
        return await driver.inputText(value)
      } catch (e) {
        // A driver's failure may quote what it typed (adb's did, in argv): said again here with the name only, and
        // classified as the original was. What the relay said about the session is kept: those messages are built by
        // the channel and carry no text. An agent's refusal is not, since an older agent's could quote it.
        const cause = e instanceof InputRefusedError ? ` (${e.reason})`
          : SESSION_FAILURES.some((C) => e instanceof C) ? `: ${(e as Error).message}` : ''
        const failure = new Error(`typing the secret ${step.name} failed${cause}`)
        throw isEnvironmentStepFailure(e) ? markEnvironmentFailure(failure) : failure
      }
    }
    // A plain press passes no second argument, so a driver written before modifiers sees the call it always did.
    case 'pressKey': return step.modifiers ? driver.pressKey(step.code, step.modifiers) : driver.pressKey(step.code)
    // A key code tapflow names, not a key (protocol `InputKey`): each agent presses the field's action its own way.
    case 'imeAction': return driver.pressKey(IME_ACTION)
    case 'swipe': return driver.swipe(step.from, step.to, step.durationMs)
    case 'scroll': {
      if (step.until) return scrollUntil(driver, step.direction, step.until, timeoutMs, pollIntervalMs)
      const g = SCROLL_GESTURES[step.direction]
      return driver.swipe(g.from, g.to, 300)
    }
    case 'openUrl': return driver.openUrl(step.url)
    case 'assertVisible': return waitVisible(driver, step.selector, timeoutMs, pollIntervalMs)
    case 'assertNotVisible': return waitNotVisible(driver, step.selector, timeoutMs, pollIntervalMs)
    case 'pressButton': return driver.pressButton(step.name)
    case 'longPressOn': {
      const [x, y] = await touchPoint(driver, step.selector, timeoutMs, pollIntervalMs, report)
      return driver.longPress(x, y, step.durationMs)
    }
    case 'longPressPoint': report.reach = 'delivered'; return driver.longPress(step.at[0], step.at[1], step.durationMs)
    case 'pinch': {
      let center: [number, number]
      if (Array.isArray(step.on)) {
        center = step.on
        report.reach = 'delivered'
      } else {
        center = await touchPoint(driver, step.on, timeoutMs, pollIntervalMs, report)
      }
      const path = pinchFingers(center, step.scale)
      if (!path) throw new StepFailure(`the pinch center [${center.join(', ')}] is too close to the edge of the screen to fit two fingers changing their spacing ×${step.scale} — pinch on a point further in`)
      return driver.pinch(path.start, path.end, step.durationMs)
    }
    case 'setOrientation': return driver.setOrientation(step.orientation, timeoutMs)
    case 'setPosture': return driver.setPosture(step.posture, timeoutMs)
  }
}

/** The first `inputText: { secret }` step naming a secret `secrets` does not hold, or `null`. A caller checks it before
 *  choosing or preparing a device, so a run that cannot type one costs no boot; the engine checks it again. */
export function missingSecret(flow: Flow, secrets: Readonly<Record<string, string>> | undefined): { index: number; name: string } | null {
  const index = flow.steps.findIndex((s) => s.type === 'inputSecret' && secretValue(secrets, s.name) === undefined)
  return index < 0 ? null : { index, name: (flow.steps[index] as Extract<Step, { type: 'inputSecret' }>).name }
}

/** A secret's value, or `undefined` when it was not given. Own properties only: a name like `constructor` would
 *  otherwise read Object's. And only a non-empty string: a JS caller can pass `{ PASSWORD: process.env.PASSWORD }`
 *  with the variable unset, and typing nothing would fail later as the app's fault — the CLI's rule for its own map. */
function secretValue(secrets: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  const value: unknown = secrets && Object.hasOwn(secrets, name) ? secrets[name] : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function missingSecretMessage(name: string): string {
  return `the secret ${name} was not given to this run (tapflow flow run --secret ${name}, with ${name} set in the environment; run_flow takes none)`
}

/**
 * A flow refused before its first step: the step that could not run is `failed`, every other `skipped`, and nothing
 * reached the device. Exported so the CLI can refuse a flow the same way before a device is even chosen.
 */
export function refusedFlow(flow: Flow, index: number, message: string, options: { beforeRun: boolean }): FlowResult {
  const failed = describeStep(flow.steps[index]!)
  return {
    name: flow.name,
    ...(flow.file !== undefined ? { file: flow.file } : {}),
    status: 'failed',
    steps: flow.steps.map((step, i) => i === index
      ? { index: i, name: failed, status: 'failed', durationMs: 0, message }
      : { index: i, name: describeStep(step), status: 'skipped', durationMs: 0 }),
    durationMs: 0,
    failureMessage: `${failed}: ${message}`,
    failureKind: 'environment',
    ...(options.beforeRun ? { failedBeforeRun: true as const } : {}),
  }
}

/** Select what the focused field holds, so the text typed next replaces it (`SELECT_ALL`). */
async function selectAll(driver: FlowDriver): Promise<void> {
  try {
    await driver.pressKey(SELECT_ALL.code, [...SELECT_ALL.modifiers])
  } catch (e) {
    if (e instanceof InputRefusedError && e.reason === 'unsupported') throw markEnvironmentFailure(new Error(SELECT_ALL_REFUSED))
    throw e
  }
}

/** The refusal for a button this device lacks, or `null` to run. See `unavailableButton`. */
async function refuseButtons(flow: Flow, driver: FlowDriver, platform: string, timeoutMs: number): Promise<FlowResult | null> {
  let verdict = unavailableButton(flow, platform)
  if (verdict === 'needs-chrome') {
    if (!driver.chrome) return null
    // The step that could not be checked, not merely the first press: a `home` before it was never in question.
    const index = flow.steps.findIndex((s) => s.type === 'pressButton' && buttonAvailability(platform, s.name) === 'unknown')
    // The device's fault rather than the flow's, so neither refusal below is marked `beforeRun`: a device that never
    // describes itself, or whose session went while it was asked, may be one to leave. Returned rather than thrown, so
    // the run records this flow and goes on to the next, as a step's failure would.
    let chrome
    try {
      chrome = await driver.chrome(timeoutMs)
    } catch (e) {
      return refusedFlow(flow, index, `whether the device can press this could not be checked: ${e instanceof Error ? e.message : String(e)}`, { beforeRun: false })
    }
    if (chrome === null) {
      return refusedFlow(flow, index, `the device did not report its buttons within ${timeoutMs / 1000}s, so whether it can press this cannot be checked`, { beforeRun: false })
    }
    verdict = unavailableButton(flow, platform, chrome)
  }
  if (verdict === null || verdict === 'needs-chrome') return null
  return refusedFlow(flow, verdict.index, unavailableButtonMessage(verdict, platform), { beforeRun: true })
}

/** The screen a chrome describes, the shorter side first so a turn does not change it: iOS in points, Android in pixels. */
export function viewportOf(chrome: ChromePayload | null | undefined): Viewport | undefined {
  if (!chrome) return undefined
  const [w, h] = 'framePng' in chrome ? [chrome.logicalWidth, chrome.logicalHeight] : [chrome.screenWidth, chrome.screenHeight]
  if (!w || !h || w <= 0 || h <= 0) return undefined
  return { width: Math.min(w, h), height: Math.max(w, h) }
}

const sameViewport = (a: Viewport, b: Viewport): boolean =>
  Math.abs(Math.min(a.width, a.height) - b.width) < 0.5 && Math.abs(Math.max(a.width, a.height) - b.height) < 0.5

/** The first step that touches a point the flow wrote, which lands where that fraction of the screen is, or -1. */
function firstPointStep(flow: Flow): number {
  return flow.steps.findIndex((s) => s.type === 'tapPoint' || s.type === 'longPressPoint' || s.type === 'swipe'
    || (s.type === 'pinch' && Array.isArray(s.on)))
}

export async function runFlow(flow: Flow, driver: FlowDriver, options: EngineOptions = {}): Promise<FlowResult> {
  const timeoutMs = normalizeTimeoutMs(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'default timeout')
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const missing = missingSecret(flow, options.secrets)
  if (missing) return refusedFlow(flow, missing.index, missingSecretMessage(missing.name), { beforeRun: true })
  if (options.platform !== undefined) {
    const refused = await refuseButtons(flow, driver, options.platform, timeoutMs)
    if (refused) return refused
  }
  // A flow whose points were made on another screen is refused before it touches anything (#1125): the point would land
  // on whatever that screen's layout puts there. A device that cannot say its size is not refused — nothing to compare.
  const pointAt = firstPointStep(flow)
  let viewport: Viewport | undefined
  if (pointAt >= 0 && driver.chrome && (flow.viewport !== undefined || options.observeEffects === true)) {
    viewport = viewportOf(await driver.chrome(timeoutMs).catch(() => null))
    if (flow.viewport && viewport && !sameViewport(flow.viewport, viewport)) {
      const size = (v: Viewport) => `${v.width}×${v.height}`
      return refusedFlow(flow, pointAt, `this flow touches points made on a ${size(flow.viewport)} screen, and this device's is ${size(viewport)}: a point lands on whatever this screen shows there, so it is not run here`, { beforeRun: true })
    }
  }
  const started = Date.now()
  const steps: StepResult[] = []
  let failureMessage: string | undefined
  let failureKind: 'environment' | 'product' | undefined
  let deviceLacks = false
  let failureScreenshot: Uint8Array | undefined
  // What earlier touches brought, kept across steps that changed nothing — a toast outlives a step or two (review of #1125).
  const effects = new EffectWatch()

  for (const [index, step] of flow.steps.entries()) {
    const started = describeStep(step)
    if (failureMessage !== undefined) {
      steps.push({ index, name: started, status: 'skipped', durationMs: 0 })
      continue
    }
    const stepStart = Date.now()
    options.onStep?.({ index, name: started, phase: 'start', label: activityLabel(step) })
    const report: StepReport = {}
    const touched = () => ({
      ...(report.reach ? { reach: report.reach } : {}), ...(report.reachNote ? { reachNote: report.reachNote } : {}),
      ...(report.effect ? { effect: report.effect } : {}), ...(report.observed !== undefined ? { observed: report.observed } : {}),
    })
    const expect = EXPECTING_STEPS.has(step.type) ? (step as { expect?: StepExpect }).expect : undefined
    const watch = EXPECTING_STEPS.has(step.type) && (expect !== undefined || options.observeEffects === true)
    try {
      // A point is touched without reading the screen, so its effect needs a read of its own first.
      if (watch && (step.type === 'tapPoint' || step.type === 'longPressPoint')) report.screen = await readScreen(driver, timeoutMs)
      const applied = await executeStep(step, flow, driver, timeoutMs, pollIntervalMs, options.secrets, report)
      if (expect) await confirmEffect(driver, expect, report, timeoutMs, pollIntervalMs)
      if (watch && options.observeEffects) {
        report.observed = await observeTouch(driver, report.screen, timeoutMs, pollIntervalMs, effects, {
          hidden: Object.values(options.secrets ?? {}),
          ...(report.touched ? { touched: report.touched } : {}),
        })
      }
      // Known only once the launch answers, so the start mark carries the name without the relay's defaults.
      const name = step.type === 'launchApp' && applied ? describeLaunch(step.options, applied) : started
      steps.push({ index, name, status: 'passed', durationMs: Date.now() - stepStart, ...touched() })
      options.onStep?.({ index, name, phase: 'end', status: 'passed' })
    } catch (e) {
      const name = started
      const message = e instanceof Error ? e.message : String(e)
      failureMessage = `${name}: ${message}`
      if (failureKind === undefined) failureKind = isEnvironmentStepFailure(e) ? 'environment' : 'product'
      if (e instanceof DeviceLacksError) deviceLacks = true
      const suggestions = e instanceof StepFailure ? e.suggestions : undefined
      steps.push({ index, name, status: 'failed', durationMs: Date.now() - stepStart, message, ...(suggestions ? { suggestions } : {}), ...touched() })
      options.onStep?.({ index, name, phase: 'end', status: 'failed' })
      failureScreenshot = await captureScreenshot(driver, FAILURE_SCREENSHOT_TIMEOUT_MS)
    }
  }

  const result: FlowResult = {
    name: flow.name,
    status: failureMessage === undefined ? 'passed' : 'failed',
    steps,
    // Before the last-screen capture: it is evidence taken after the flow, not part of how long the flow took.
    durationMs: Date.now() - started,
  }
  if (failureMessage === undefined && options.captureLastScreen) {
    const shot = await captureScreenshot(driver, LAST_SCREEN_TIMEOUT_MS)
    if (shot !== undefined) result.lastScreenshot = shot
  }
  if (flow.file !== undefined) result.file = flow.file
  if (options.observeEffects && viewport) result.viewport = viewport
  if (failureMessage !== undefined) result.failureMessage = failureMessage
  if (failureKind !== undefined) result.failureKind = failureKind
  if (deviceLacks) result.deviceLacks = true
  if (failureScreenshot !== undefined) result.failureScreenshot = failureScreenshot
  return result
}
