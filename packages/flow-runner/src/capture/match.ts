import type { DevicePosture, PointSpace, UIElement } from '@tapflowio/protocol'
import type { InterfaceTurn } from '@tapflowio/protocol/screen'
import type { ScrollDirection, Selector, Step } from '../schema.js'
import { matchSelector } from '../selector.js'
import { selectorFor } from '../suggest.js'
import { modifierNames } from './keys.js'
import { LONG_PRESS_MS, type Point, type RawStep } from './segment.js'

/** What the screen was when a step was replayed: the host reads it just before sending the step, and once after. */
export interface MatchContext {
  /** The tree read just before the step was sent again. */
  tree: UIElement[]
  /** Read just after it. Typing is judged by both reads: an Enter or a Tab can move the focus it typed into. */
  treeAfter?: UIElement[]
  /** The app's turn from the read before (`UiTreeResponse.interfaceTurn`, iOS). The dashboard sends iOS points in the
   *  portrait framebuffer, and a flow's points are in the app as drawn. */
  interfaceTurn?: InterfaceTurn
  /** The device's `AndroidChrome.streamRotation`, read when the screen had settled: the turn from the video frame to
   *  the screen Android draws, for a point sent in the frame's space (Android body mode). The chrome recorded beside
   *  the step lags a turn by up to 3.6 s and must not be used for this. */
  frameTurn?: 0 | 90 | 180 | 270
  /** The device's orientation once a rotate step has settled (`chromeOrientation` of its chrome). */
  orientationAfter?: 'portrait' | 'landscape' | 'upside-down'
  /** The device's postures, most closed first (`device:postures`). */
  postures?: DevicePosture[]
  platform?: string
}

export type SkipReason =
  | 'refused' | 'hold-drag' | 'held-button' | 'too-long' | 'no-pinch'
  /** Android types through `adb input text`, which takes printable ASCII only. */
  | 'paste-not-typeable'
  | 'orientation-unknown' | 'posture-between'
  /** The run installs and resets the app itself (`--build`, and the reset it does by default). */
  | 'install'
  | 'network' | 'cut' | 'keyboard'

export type FragileReason =
  /** Tapped where the tree names no element. */
  | 'no-element'
  /** The element under the point could not be named so that a selector finds it alone. */
  | 'no-selector'
  /** Tapping the element's centre would not tap what the person did: a bigger element, or one partly covered. */
  | 'not-centre'
  /** A swipe replays its two ends at the speed it was made, not what it brought on screen. */
  | 'swipe'
  /** Typed with Caps Lock in force (`capsLock` on the text step): the text is a US-layout guess at what the device typed. */
  | 'caps-lock'

export interface CapturedStep {
  raw: RawStep
  /** `null`: the step cannot be said in a flow, for `skipped`. */
  step: Step | null
  skipped?: SkipReason
  fragile?: FragileReason
  /** Typed into a field that hides its text, or one whose kind could not be read: kept out of the flow as a secret. */
  secret?: { value: string; known: boolean }
  /** Turned into a step that says what the person meant (`scroll { until }`). */
  auto?: true
  /** The tree the step was matched against, kept for the scroll rule in `toFlowSteps`. */
  tree?: UIElement[]
}

const MAX_GESTURE_MS = 60_000
const MIN_SCALE = 0.1
const MAX_SCALE = 10
/** A scale this close to 1 moved the fingers, not the content. */
const PINCH_DEAD_ZONE = 0.05

/** A point carried by a quarter turn clockwise — the inverse of `toFramePoint`, and the turn from Android's video
 *  frame to its screen (the dashboard's `turnPoint`). */
function turned([x, y]: Point, turn: 0 | 90 | 180 | 270 | undefined): Point {
  switch (turn) {
    case 90: return [1 - y, x]
    case 180: return [1 - x, 1 - y]
    case 270: return [y, 1 - x]
    default: return [x, y]
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** A recorded point on the screen as the app draws it — the space of the tree and of a flow. */
export function toScreen(point: Point, space: PointSpace | undefined, ctx: Pick<MatchContext, 'interfaceTurn' | 'frameTurn'>): Point {
  const p = space === 'frame' ? turned(point, ctx.frameTurn) : turned(point, ctx.interfaceTurn)
  return [round4(p[0]), round4(p[1])]
}

const contains = (e: UIElement, [x, y]: Point): boolean =>
  e.frame.width > 0 && e.frame.height > 0
  && x >= e.frame.x && x <= e.frame.x + e.frame.width && y >= e.frame.y && y <= e.frame.y + e.frame.height

/** The element a point lands on: the smallest that contains it, the tree being a flat list of frames. Ties go to the
 *  later element, which is drawn over the earlier. */
export function hitTest(tree: readonly UIElement[], point: Point): UIElement | null {
  let best: UIElement | null = null
  for (const e of tree) {
    if (!contains(e, point)) continue
    if (!best || e.frame.width * e.frame.height <= best.frame.width * best.frame.height) best = e
  }
  return best
}

const centre = (e: UIElement): Point => [e.frame.x + e.frame.width / 2, e.frame.y + e.frame.height / 2]

/** A selector for what is at `point`, or why the point has to be kept. The engine taps an element's centre, so a
 *  selector is used only when that centre lands on the same element the person's point did. */
function target(tree: UIElement[], point: Point): { selector: Selector } | { fragile: FragileReason } {
  const hit = hitTest(tree, point)
  if (!hit) return { fragile: 'no-element' }
  if (hitTest(tree, centre(hit)) !== hit) return { fragile: 'not-centre' }
  const selector = selectorFor(tree, hit)
  return selector ? { selector } : { fragile: 'no-selector' }
}

/** Where typing went: the field with text focus. */
const focusedIn = (tree: readonly UIElement[] | undefined): UIElement | undefined => tree?.find((e) => e.focused === true)

/** Typed text may be written down only when the field it went into is known not to hide it — before and after. */
function typedSecretly(ctx: MatchContext): boolean {
  const before = focusedIn(ctx.tree)
  if (before?.secure !== false) return true
  if (ctx.treeAfter === undefined) return false
  const after = focusedIn(ctx.treeAfter)
  return after !== undefined && after.secure !== false
}

/** Whether a field hiding the text is known to (`secure: true`), rather than unknown. */
const knownSecret = (ctx: MatchContext): boolean => focusedIn(ctx.tree)?.secure === true

function typed(raw: RawStep, text: string, ctx: MatchContext): CapturedStep {
  // A secret's value is the same guess, so it is marked too.
  const guess = raw.kind === 'text' && raw.capsLock ? { fragile: 'caps-lock' as const } : {}
  if (typedSecretly(ctx)) return { raw, step: null, secret: { value: text, known: knownSecret(ctx) }, ...guess }
  return { raw, step: { type: 'inputText', text }, ...guess }
}

/**
 * One recorded action as a flow step, against the screen it was replayed on. Pure: the host replays, reads, and
 * calls this; nothing here touches a device.
 */
export function matchStep(raw: RawStep, ctx: MatchContext): CapturedStep {
  if (raw.outcome === 'refused') return { raw, step: null, skipped: 'refused' }
  switch (raw.kind) {
    case 'tap': {
      const p = toScreen(raw.point, raw.space, ctx)
      const t = target(ctx.tree, p)
      return 'selector' in t
        ? { raw, step: { type: 'tapOn', selector: t.selector }, tree: ctx.tree }
        : { raw, step: { type: 'tapPoint', at: p }, fragile: t.fragile, tree: ctx.tree }
    }
    case 'longPress': {
      if (raw.durationMs > MAX_GESTURE_MS) return { raw, step: null, skipped: 'too-long' }
      const p = toScreen(raw.point, raw.space, ctx)
      const t = target(ctx.tree, p)
      return 'selector' in t
        ? { raw, step: { type: 'longPressOn', selector: t.selector, durationMs: raw.durationMs } }
        : { raw, step: { type: 'longPressPoint', at: p, durationMs: raw.durationMs }, fragile: t.fragile }
    }
    case 'swipe':
      return {
        raw,
        step: { type: 'swipe', from: toScreen(raw.from, raw.space, ctx), to: toScreen(raw.to, raw.space, ctx), durationMs: Math.max(1, raw.durationMs) },
        fragile: 'swipe',
        tree: ctx.tree,
      }
    case 'holdDrag': return { raw, step: null, skipped: 'hold-drag' }
    case 'pinch': {
      const start = raw.start.map((f) => toScreen(f, raw.space, ctx)) as [Point, Point]
      const end = raw.end.map((f) => toScreen(f, raw.space, ctx)) as [Point, Point]
      const from = Math.hypot(start[0][0] - start[1][0], start[0][1] - start[1][1])
      const to = Math.hypot(end[0][0] - end[1][0], end[0][1] - end[1][1])
      const scale = from > 0 ? to / from : 1
      if (Math.abs(scale - 1) < PINCH_DEAD_ZONE) return { raw, step: null, skipped: 'no-pinch' }
      if (raw.durationMs > MAX_GESTURE_MS) return { raw, step: null, skipped: 'too-long' }
      const mid: Point = [round4((start[0][0] + start[1][0]) / 2), round4((start[0][1] + start[1][1]) / 2)]
      const t = target(ctx.tree, mid)
      return {
        raw,
        step: {
          type: 'pinch',
          on: 'selector' in t ? t.selector : mid,
          scale: Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) * 100) / 100,
          durationMs: Math.max(1, raw.durationMs),
        },
        ...('fragile' in t ? { fragile: t.fragile } : {}),
      }
    }
    case 'text': return typed(raw, raw.text, ctx)
    case 'type': return typed(raw, raw.text, ctx)
    case 'paste':
      if (ctx.platform === 'android' && !/^[\x20-\x7e]*$/.test(raw.text)) return { raw, step: null, skipped: 'paste-not-typeable' }
      return typed(raw, raw.text, ctx)
    case 'key': {
      const modifiers = modifierNames(raw.modifiers)
      return { raw, step: modifiers.length > 0 ? { type: 'pressKey', code: raw.code, modifiers } : { type: 'pressKey', code: raw.code } }
    }
    case 'button':
      if (raw.heldMs !== undefined && raw.heldMs >= LONG_PRESS_MS) return { raw, step: null, skipped: 'held-button' }
      return { raw, step: { type: 'pressButton', name: raw.name } }
    case 'rotate': {
      const to = raw.to && 'orientation' in raw.to ? raw.to.orientation : ctx.orientationAfter
      if (to !== 'portrait' && to !== 'landscape') return { raw, step: null, skipped: 'orientation-unknown' }
      return { raw, step: { type: 'setOrientation', orientation: to } }
    }
    case 'posture': {
      const ids = ctx.postures?.map((p) => p.id) ?? []
      if (ids.length >= 2 && raw.postureId === ids[0]) return { raw, step: { type: 'setPosture', posture: 'folded' } }
      if (ids.length >= 2 && raw.postureId === ids[ids.length - 1]) return { raw, step: { type: 'setPosture', posture: 'unfolded' } }
      return { raw, step: null, skipped: 'posture-between' }
    }
    case 'launch': {
      const msg = raw.messages[0]!.msg
      const options = msg.type === 'app:launch'
        ? { ...(msg.arguments ? { arguments: msg.arguments } : {}), ...(msg.env ? { env: msg.env } : {}) }
        : {}
      return { raw, step: Object.keys(options).length > 0 ? { type: 'launchApp', options } : { type: 'launchApp' } }
    }
    case 'clearState': return { raw, step: { type: 'clearState', appId: raw.bundleId } }
    case 'openUrl': return { raw, step: { type: 'openUrl', url: raw.url } }
    case 'install': return { raw, step: null, skipped: 'install' }
    case 'network': return { raw, step: null, skipped: 'network' }
    case 'cut': return { raw, step: null, skipped: 'cut' }
    case 'keyboardToggle': return { raw, step: null, skipped: 'keyboard' }
  }
}

/** Axis-parallel, and across the middle of the screen where `scroll` makes its own swipe. */
function scrollDirection(from: Point, to: Point): ScrollDirection | null {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.abs(dy) > Math.abs(dx) * 4) {
    const x = (from[0] + to[0]) / 2
    if (Math.abs(x - 0.5) > 0.3) return null
    // The finger moving up brings what is further down onto the screen.
    return dy < 0 ? 'down' : 'up'
  }
  if (Math.abs(dx) > Math.abs(dy) * 4) {
    const y = (from[1] + to[1]) / 2
    if (Math.abs(y - 0.5) > 0.2) return null
    return dx < 0 ? 'right' : 'left'
  }
  return null
}

export interface CapturedFlow {
  steps: CapturedStep[]
  /** The range did not begin with a launch, so `launchApp` goes first: a flow that does not launch its app starts on
   *  whatever screen the device happens to show. */
  launchAdded: boolean
  /** The values of the secrets the flow names, by name, for verifying it in the dialog. Never written to the file. */
  secrets: Record<string, string>
}

/**
 * The matched steps of a range as the flow's steps, with two decisions that need a neighbour:
 *
 * - **A swipe that brought a tapped element on screen becomes `scroll { until }`** — what the swipe was for, since its
 *   distance does not replay (a fling's length depends on its release). Only when the element was not on the screen
 *   the swipe started from, and the swipe could be the engine's own (straight, across the middle): a pager swiped to
 *   a page whose button every page has must stay a swipe and a tap.
 * - **A flow begins with a launch**: one is added when the range has none (`launchAdded`).
 * - **Each secret gets a name**: `PASSWORD` for a field that says it hides its text, `SECRET` for one that could not
 *   say, numbered from the second.
 */
export function toFlowSteps(matched: readonly CapturedStep[]): CapturedFlow {
  const steps = matched.map((m) => ({ ...m }))
  for (let i = 0; i + 1 < steps.length; i++) {
    const swipe = steps[i]!
    const next = steps.slice(i + 1).find((s) => s.step !== null)
    if (swipe.step?.type !== 'swipe' || next?.step?.type !== 'tapOn' || !swipe.tree) continue
    const direction = scrollDirection(swipe.step.from, swipe.step.to)
    if (!direction || matchSelector(swipe.tree, next.step.selector).length > 0) continue
    steps[i] = { raw: swipe.raw, step: { type: 'scroll', direction, until: next.step.selector }, auto: true }
  }

  const secrets: Record<string, string> = {}
  const used = new Map<string, number>()
  for (const [i, s] of steps.entries()) {
    if (!s.secret) continue
    const base = s.secret.known ? 'PASSWORD' : 'SECRET'
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    const name = n === 1 ? base : `${base}_${n}`
    secrets[name] = s.secret.value
    steps[i] = { ...s, step: { type: 'inputSecret', name } }
  }
  // A clear-state may come before the launch; anything else means the flow already started without one.
  const lead = steps.flatMap((s) => (s.step ? [s.step] : [])).find((s) => s.type !== 'clearState')
  return { steps, secrets, launchAdded: lead?.type !== 'launchApp' }
}

/**
 * The flow's steps, in order: a clear-state when the app is known, the added launch, then every step a flow can say. The
 * clear-state is what makes the file start where the replay did whichever way it is run — `run_flow` does not reset the
 * app, nor does `flow run --no-reset` — at the cost of pinning the flow to that bundle id (the flow's `appId`, so a
 * build with another one skips it rather than clearing the wrong app). Without a bundle id there is none to clear.
 */
export function flowSteps(captured: CapturedFlow, opts: { appId?: string } = {}): Step[] {
  const said = captured.steps.flatMap((s) => (s.step ? [s.step] : []))
  // A clear-state the range began with stays first, and the launch goes after it, never before. It stands in for the
  // added one only when it clears this app: one naming another app (a companion it also resets) is kept and this app is
  // still cleared, so the flow does not start on whatever data the app under test had.
  const first = said[0]
  const leads = first?.type === 'clearState'
  const clearsThis = leads && (first.appId === undefined || first.appId === opts.appId)
  const added: Step[] = opts.appId !== undefined && !clearsThis ? [{ type: 'clearState' }] : []
  const lead = leads ? [first, ...added] : added
  const rest = leads ? said.slice(1) : said
  return [...lead, ...(captured.launchAdded ? [{ type: 'launchApp' } as Step] : []), ...rest]
}
