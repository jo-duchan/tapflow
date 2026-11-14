import type { DevicePosture, ObservedElement, PointSpace, ReachResult, TouchObservation, UIElement } from '@tapflowio/protocol'
import type { InterfaceTurn } from '@tapflowio/protocol/screen'
import type { ScrollDirection, Selector, Step } from '../schema.js'
import type { StepExpect } from '../effect.js'
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
  /** The device's answers to `reachQuestions` for this step, in their order, asked against `tree` (#1125). Absent where
   *  the host could not ask: the step is then judged by the tree's frames alone, as it was before reach. */
  reach?: ReachResult[]
}

export type SkipReason =
  | 'refused' | 'hold-drag' | 'held-button' | 'too-long' | 'no-pinch'
  | 'orientation-unknown' | 'posture-between'
  /** The run installs and resets the app itself (`--build`, and the reset it does by default). */
  | 'install'
  | 'network' | 'cut' | 'keyboard'
  /** A key on the soft keyboard whose typing no field read caught (#1135): what it typed is not known. */
  | 'keyboard-key'
  /** Went down on a list that was still moving: it stopped the list and pressed nothing (`RawStep.dropped`). */
  | 'stopped-scroll'

export type FragileReason =
  /** Tapped where the tree names no element. */
  | 'no-element'
  /** The element under the point could not be named so that a selector finds it alone. */
  | 'no-selector'
  /** Tapping the element's centre would not tap what the person did: a bigger element, or one partly covered — in the
   *  tree, or on the device where it can say (#1125). */
  | 'not-centre'
  /** A swipe replays its two ends at the speed it was made, not what it brought on screen. */
  | 'swipe'
  /** Typed on a device whose agent reads fields, but no read of this one was usable — typed too fast before the next
   *  input, or the field changed under it — so the text is the keys read on a US layout, a guess on iOS (#1135). */
  | 'field-unread'
  /** The soft keyboard may have been up around the touch and its reads could not say whether it was on a key (#1135). Replayed as
   *  a tap: one on a key would type, which a following `replace` overwrites. */
  | 'keyboard-unknown'

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
  /** On a swipe: the elements of `tree`, by index, that were on it but not wholly in view — partly off the screen, or
   *  their centre covered on the device (#1125). The scroll rule reads them as not yet brought into view. */
  notInView?: number[]
  /** On a touch: what Match's replay saw it do, from the screen before it to the screen the next step was read on.
   *  Export writes only what Verify saw it do as well (`agreedEffect`), since a number that changes by itself usually
   *  reads differently minutes apart (#1125). Absent where the replay could not read the screen after it. */
  observed?: StepExpect | null
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

/**
 * A selector for what is at `point`, or why the point has to be kept. A selector is used only when the element's centre
 * lands on it: then whatever the engine taps on it, the person's touch went to it too. The tree alone cannot say that —
 * an iOS row under a tab bar, or under a scrim the tree names, has a frame whose centre is the bar (#1125) — so where the
 * device answered, its word decides: reached at the centre, or the point is kept. Where it could not judge, the tree's
 * frames are all there is, as before reach.
 */
function target(tree: UIElement[], point: Point, reach: ReachResult | undefined): { selector: Selector } | { fragile: FragileReason } {
  const hit = hitTest(tree, point)
  if (!hit) return { fragile: 'no-element' }
  if (hitTest(tree, centre(hit)) !== hit) return { fragile: 'not-centre' }
  // Covered at its centre or wholly: the person's point may have gone to the cover, and only replaying it says so.
  if (reach && (reach.state === 'occluded' || (reach.state === 'reachable' && !reach.atCentre))) return { fragile: 'not-centre' }
  const selector = selectorFor(tree, hit)
  return selector ? { selector } : { fragile: 'no-selector' }
}

/** The point a touch step was made at, on the screen as the app draws it; `null` for a step that touches no element. */
function touchedAt(raw: RawStep, ctx: Pick<MatchContext, 'interfaceTurn' | 'frameTurn'>): Point | null {
  switch (raw.kind) {
    case 'tap': case 'longPress': return toScreen(raw.point, raw.space, ctx)
    case 'pinch': {
      const [a, b] = raw.start.map((f) => toScreen(f, raw.space, ctx)) as [Point, Point]
      return [round4((a[0] + b[0]) / 2), round4((a[1] + b[1]) / 2)]
    }
    default: return null
  }
}

/** The most a swipe asks about: the relay's limit on one reach. */
const MAX_SWIPE_QUESTIONS = 64

const overlaps = (a: UIElement, b: UIElement): boolean => {
  const w = Math.min(a.frame.x + a.frame.width, b.frame.x + b.frame.width) - Math.max(a.frame.x, b.frame.x)
  const h = Math.min(a.frame.y + a.frame.height, b.frame.y + b.frame.height) - Math.max(a.frame.y, b.frame.y)
  return w > 1e-4 && h > 1e-4
}
const within = (inner: UIElement, outer: UIElement): boolean =>
  inner.frame.x >= outer.frame.x && inner.frame.y >= outer.frame.y
  && inner.frame.x + inner.frame.width <= outer.frame.x + outer.frame.width
  && inner.frame.y + inner.frame.height <= outer.frame.y + outer.frame.height
const offScreenPart = (e: UIElement): boolean =>
  e.frame.x < 0 || e.frame.y < 0 || e.frame.x + e.frame.width > 1 || e.frame.y + e.frame.height > 1

/**
 * The elements of `ctx.tree` whose reach decides how `raw` is matched (#1125), for the host to ask the device before it
 * replays the step and hand back as `MatchContext.reach`, in this order.
 *
 * - A tap, long press or pinch: the element under its point.
 * - A swipe: each element on the screen the swipe started from that something else in the tree overlaps without either
 *   holding the other — a row under a bar, a FAB or a named scrim. The scroll rule needs to know which of them were in
 *   view, and asking every element would cost a reach each (130 ms on iOS, measured); one nothing in the tree overlaps
 *   is taken as in view, which is all the tree could say before. A frame running off the screen is not in view and needs
 *   no question.
 */
export function reachQuestions(raw: RawStep, ctx: Pick<MatchContext, 'tree' | 'interfaceTurn' | 'frameTurn'>): UIElement[] {
  if (raw.outcome === 'refused' || raw.dropped) return []
  if (raw.kind === 'swipe') return swipeQuestions(ctx.tree)
  const p = touchedAt(raw, ctx)
  const hit = p ? hitTest(ctx.tree, p) : null
  return hit ? [hit] : []
}

function swipeQuestions(tree: readonly UIElement[]): UIElement[] {
  const asked: UIElement[] = []
  for (const e of tree) {
    if (asked.length >= MAX_SWIPE_QUESTIONS) break
    if (e.frame.width <= 0 || e.frame.height <= 0 || offScreenPart(e)) continue
    if (tree.some((o) => o !== e && overlaps(o, e) && !within(o, e) && !within(e, o))) asked.push(e)
  }
  return asked
}

/** Which of a swipe's tree was on it but not wholly in view, by index: off the screen in part, or not reached at its
 *  centre where the device answered (an element it could not judge counts as in view, as `scroll { until }` does). */
function notInView(tree: UIElement[], ctx: MatchContext): number[] {
  const asked = swipeQuestions(tree)
  const out = new Set<number>()
  tree.forEach((e, i) => { if (e.frame.width > 0 && e.frame.height > 0 && offScreenPart(e)) out.add(i) })
  if (ctx.reach && ctx.reach.length === asked.length) {
    asked.forEach((e, k) => {
      const r = ctx.reach![k]!
      if (r.state === 'unknown' || (r.state === 'reachable' && r.atCentre)) return
      out.add(tree.indexOf(e))
    })
  }
  return [...out].sort((a, b) => a - b)
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
  // A secret's value is the same guess, so it is marked too. A run with neither a value nor a tried read is one the
  // relay never read — an agent without `field-value`, or a Mac over its memory line — and the same guess on both
  // platforms: the keys went through the device's IME, Gboard on Android, which composes them in its own language.
  const unread = raw.kind === 'text'
    && (raw.fieldRead === 'unread' || (raw.fieldRead === undefined && raw.replace !== true))
  const guess = unread ? { fragile: 'field-unread' as const } : {}
  // Read as a password field when it was typed, or a value the person gave for one: still a secret whatever field
  // Match finds focused, which can be another one, or a "show password" left on that reads it as plain text — the
  // YAML would carry it.
  const keptSecret = raw.kind === 'text' && (raw.fieldRead === 'secure' || raw.askValue === true)
  if (keptSecret || typedSecretly(ctx)) {
    return { raw, step: null, secret: { value: text, known: keptSecret || knownSecret(ctx) }, ...guess }
  }
  const replace = raw.kind === 'text' && raw.replace === true
  return { raw, step: replace ? { type: 'inputText', text, replace: true } : { type: 'inputText', text }, ...guess }
}

/**
 * One recorded action as a flow step, against the screen it was replayed on. Pure: the host replays, reads, and
 * calls this; nothing here touches a device.
 */
export function matchStep(raw: RawStep, ctx: MatchContext): CapturedStep {
  const matched = matchAction(raw, ctx)
  // A touch the keyboard reads could not place says so above any other reason: the person decides whether it was a key.
  return 'keyboard' in raw && raw.keyboard === 'unknown' && matched.step ? { ...matched, fragile: 'keyboard-unknown' } : matched
}

function matchAction(raw: RawStep, ctx: MatchContext): CapturedStep {
  if (raw.outcome === 'refused') return { raw, step: null, skipped: 'refused' }
  if (raw.dropped) return { raw, step: null, skipped: raw.dropped }
  // One question for a touch: the element under its point.
  const reach = ctx.reach?.length === 1 ? ctx.reach[0] : undefined
  switch (raw.kind) {
    case 'tap': {
      const p = toScreen(raw.point, raw.space, ctx)
      const t = target(ctx.tree, p, reach)
      return 'selector' in t
        ? { raw, step: { type: 'tapOn', selector: t.selector }, tree: ctx.tree }
        : { raw, step: { type: 'tapPoint', at: p }, fragile: t.fragile, tree: ctx.tree }
    }
    case 'longPress': {
      if (raw.durationMs > MAX_GESTURE_MS) return { raw, step: null, skipped: 'too-long' }
      const p = toScreen(raw.point, raw.space, ctx)
      const t = target(ctx.tree, p, reach)
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
        notInView: notInView(ctx.tree, ctx),
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
      const t = target(ctx.tree, mid, reach)
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
    case 'paste': return typed(raw, raw.text, ctx)
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
    case 'keyboardKey': return { raw, step: null, skipped: 'keyboard-key' }
    case 'imeAction': return { raw, step: { type: 'imeAction' } }
  }
}

/**
 * The element of `tree` that a touch's report names (record-time observation): the button it was in, else the element
 * itself, found by identifier, else by label, and of several the one whose frame lies nearest the recorded one. `null`
 * when the report names nothing the tree has — not on this screen, scrolled out of it, or a touch on the keyboard, a
 * web view or Flutter, which the report does not name.
 *
 * Match replays such a tap on this element rather than at the recorded point: a list a fling left at another offset,
 * or one a tap stopped mid-glide in the recording and not in the replay, puts another row under the point.
 */
export function recordedTarget(tree: readonly UIElement[], touched: TouchObservation | undefined): UIElement | null {
  if (!touched || touched.surface) return null
  for (const named of [touched.button, touched.element]) {
    if (!named) continue
    const found = named.identifier
      ? tree.filter((e) => e.identifier === named.identifier)
      : named.label && !named.input ? tree.filter((e) => e.label === named.label && e.secure !== true) : []
    const nearest = nearestTo(found, named)
    if (nearest) return nearest
  }
  return null
}

function nearestTo(found: UIElement[], named: ObservedElement): UIElement | null {
  if (found.length <= 1) return found[0] ?? null
  if (!named.frame) return null
  const f = named.frame
  const d = (e: UIElement) => Math.hypot(e.frame.x + e.frame.width / 2 - (f.x + f.width / 2), e.frame.y + e.frame.height / 2 - (f.y + f.height / 2))
  return found.reduce((a, b) => (d(b) < d(a) ? b : a))
}

/** A selector for what a touch's report names, for an element the screen does not show yet (`scroll { until }`). */
export function recordedSelector(touched: TouchObservation | undefined): Selector | null {
  if (!touched || touched.surface) return null
  const named = touched.button ?? touched.element
  if (named?.identifier) return { id: named.identifier }
  if (named?.label && !named.input) return { label: named.label, exact: true }
  return null
}

/** The way a swipe scrolls, as `scroll` says it, on the screen as the app draws it; `null` for one `scroll` could not
 *  make (slanted, or off the middle). */
export function scrollDirectionOf(raw: RawStep, ctx: Pick<MatchContext, 'interfaceTurn' | 'frameTurn'>): ScrollDirection | null {
  if (raw.kind !== 'swipe') return null
  return scrollDirection(toScreen(raw.from, raw.space, ctx), toScreen(raw.to, raw.space, ctx))
}

/** Axis-parallel, and across the middle of the screen where `scroll` makes its own swipe. */
// Twice as far along the axis as across it: within ~26° of straight. A swipe made with a mouse leans (iOS E2E: 0.44 up
// and 0.19 across), and at 4:1 it stayed a swipe, whose distance does not replay, and the tap after it failed.
const AXIS_RATIO = 2

function scrollDirection(from: Point, to: Point): ScrollDirection | null {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.abs(dy) > Math.abs(dx) * AXIS_RATIO) {
    const x = (from[0] + to[0]) / 2
    if (Math.abs(x - 0.5) > 0.3) return null
    // The finger moving up brings what is further down onto the screen.
    return dy < 0 ? 'down' : 'up'
  }
  if (Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
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
 * - **A swipe that brought a tapped element into view becomes `scroll { until }`** — what the swipe was for, since its
 *   distance does not replay (a fling's length depends on its release). Only when the element was not wholly in view on
 *   the screen the swipe started from (absent, or there but in `notInView`: an iOS tree carries the rows under a tab
 *   bar, #1125), and the swipe could be the engine's own (straight, across the middle): a pager swiped to a page whose
 *   button every page has must stay a swipe and a tap.
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
    const hidden = new Set(swipe.notInView ?? [])
    const inView = matchSelector(swipe.tree, next.step.selector).some((e) => !hidden.has(swipe.tree!.indexOf(e)))
    if (!direction || inView) continue
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
    // A field's whole value replaces what it holds, as a written one does; typed after it, it would double up (#1135).
    steps[i] = { ...s, step: s.raw.kind === 'text' && s.raw.replace ? { type: 'inputSecret', name, replace: true } : { type: 'inputSecret', name } }
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
