import type { UIElement } from '@tapflowio/agent-core'
import type { TouchLanding, TouchObservation } from '@tapflowio/protocol'
import { matchSelector } from '../selector.js'
import { isSecretName, type Selector, type Step } from '../schema.js'
import { expectedFor, mentionsSecret, type ExpectWarning } from './expected.js'
import { centre, hitTest, recordedSelector, target, toFlowSteps, flowSteps, type CapturedStep, type FragileReason } from './match.js'
import { LONG_PRESS_MS, type Point, type RawStep } from './segment.js'
import { flowToYaml } from './yaml.js'

/**
 * MCP Flow Capture (L6a): what an AI agent did on a device while its capture was open, as the MCP server recorded it —
 * the agent's own record, not the relay's, since only the MCP server knows which element a tap was aimed at, what was
 * typed, and which steps a `run_flow` ran. Turned into a flow here without a Match replay: each step is named by what
 * was known when it was done (the agent's selector, the agent's observation of the touch, the tree the agent had just
 * read), the agent judges the steps with a fixed set of choices, and the result is verified by a replay before anything
 * is saved (mcp-server). Plan: `.work/2026-11-25-mcp-flow-capture-plan.md`.
 *
 * Points are normalised on the screen as the app draws it — the tree's space and a flow's — as the MCP server resolved
 * them, before its driver turned them for the device.
 */
export type AgentAction = (
  | {
    kind: 'tap'
    point: Point
    /** Held this long, when it was a long press. */
    holdMs?: number
    /** The element the agent asked for (`tap` with `element`), as the engine resolved it. Absent for a point. */
    selector?: Selector
    /** What the agent observed the touch hit, and where it went down (`capture:observation`). */
    observed?: TouchObservation
    landed?: TouchLanding
  }
  | { kind: 'swipe'; from: Point; to: Point; durationMs: number; landed?: TouchLanding }
  /**
   * Typed into the field focused just before, as a tree read then saw it: `null` when the read found none focused,
   * absent when there was no read. Only `secure: false` writes the text into the flow.
   */
  | { kind: 'type'; text: string; field?: Pick<UIElement, 'secure' | 'identifier'> | null }
  | { kind: 'key'; code: string }
  | { kind: 'button'; name: string }
  | { kind: 'launch' }
  | { kind: 'clearState'; bundleId?: string }
  | { kind: 'openUrl'; url: string }
  /**
   * A `run_flow` the agent ran: its steps as parsed, and how many of them passed (all of them when it passed). Written by
   * the agent, not observed, so a flow keeps saying so (`origin: 'agent-step'`).
   */
  | { kind: 'flow'; block: number; steps: Step[]; passed: number; source: { path?: string; hash: string } }
) & { at: number }

/** A UI tree the agent or its engine read, and when (`query_ui_tree`, an element tap's own read). */
export interface TreeRead {
  at: number
  elements: UIElement[]
  /** The tree's height ÷ width (`UiTreeResponse.aspect`), for the scroll rule. */
  aspect?: number
}

export interface AgentCapture {
  actions: AgentAction[]
  trees: TreeRead[]
}

/** Where a step's name came from: the agent's own element, its observation of the touch, the tree it had just read, a
 *  point nothing named, or a step a `run_flow` ran. */
export type StepOrigin = 'agent' | 'observed' | 'tree' | 'coordinate' | 'agent-step'

export interface AgentStep extends CapturedStep {
  origin: StepOrigin
  /** The element the observation named, where it is another than the one the agent asked for: the agent's is used. */
  mismatch?: Selector
  /** The `run_flow` this step came from, and whether it ran to it. A failed one is not offered. */
  block?: number
  failed?: true
  /** What the agent can expect after this touch: the elements of the screen read after it, with `expectedFor`'s verdict. */
  expectable?: Array<{ selector: Selector; warnings: ExpectWarning[] }>
  /** What it was before the step, for the warning on an expectation it already showed. */
  before?: UIElement[]
  /** A tap the app did not respond to (Manual's rule): offered to be left out, never left out by itself. */
  noResponse?: true
  landed?: TouchLanding
  /** A name for it held a secret's value, so it was not used: named by the next way, or left a point. */
  withheld?: true
}

/** The relay-record half of a step, which an agent's step has none of: only its time, and a swipe's ends, are read
 *  (`toFlowSteps` reads `raw` for a typed field's `replace`, which an agent's typing never has). */
function raw(at: number, swipe?: { from: Point; to: Point; durationMs: number }): RawStep {
  const base = { at, endAt: at, outcome: 'landed' as const, messages: [] }
  return swipe ? { ...base, kind: 'swipe', ...swipe } : { ...base, kind: 'button', name: 'agent' }
}

/** Typed text written into the flow as it is: into a field read as not secure, and in one piece — a Tab or a Return
 *  in it may move to the next field, a password's, as Manual's typing is cut at every key that types no character. */
const writable = (a: Extract<AgentAction, { kind: 'type' }>): boolean => a.field?.secure === false && !/[\t\n\r]/.test(a.text)

/** The tree read last before `at` and after `after`: the screen the agent was looking at. None read in between, none. */
function treeBetween(trees: readonly TreeRead[], after: number, at: number): TreeRead | undefined {
  let best: TreeRead | undefined
  for (const t of trees) if (t.at > after && t.at <= at && (!best || t.at >= best.at)) best = t
  return best
}

/** The one element a selector finds in a tree, or none. */
function onlyMatch(tree: readonly UIElement[], selector: Selector): UIElement | undefined {
  const found = matchSelector([...tree], selector)
  return found.length === 1 ? found[0] : undefined
}

/**
 * The capture as steps, each named by what was known when it was done:
 *
 * - **An element tap** is the agent's selector. Where its observation names another element in the tree read before it
 *   (an overlay the agent did not see), the agent's is still used and the other is kept as `mismatch`.
 * - **A point tap** is named by the observation when the tree read before it finds that element alone and its centre is
 *   that element; else by the tree read before it, as Manual's Match names a point (`target`); else it stays a point,
 *   `fragile`.
 * - **Typed text** is written into the flow only into a field the read before it saw focused and `secure: false`;
 *   anything else is a secret (fail-closed: no read, nothing focused, `secure` absent).
 * - **A swipe** is a swipe, with the tree before it, so `toFlowSteps` turns it into `scroll { until }` as Manual's does.
 * - **A `run_flow`'s steps** are taken as written, marked as the agent's, and those past where it failed are `failed`.
 */
export function agentSteps(capture: AgentCapture): AgentStep[] {
  const out: AgentStep[] = []
  let previousAt = -Infinity
  const actions = [...capture.actions].sort((a, b) => a.at - b.at)
  // What was typed as a secret: an element showing it is never offered to expect, or named by it, or the value would be
  // written. Each piece between a Tab or a Return too, since those may have typed into two fields (CodeRabbit, #1244).
  const secrets = actions.flatMap((a) => (a.kind === 'type' && !writable(a) ? [a.text, ...a.text.split(/[\t\n\r]/)] : []))
    .filter((v) => v.length > 0)
  const leaks = (s: Selector): boolean => [s.text, s.id, s.label, s.role].some((v) => v !== undefined && mentionsSecret(v, secrets))
  for (const [i, a] of actions.entries()) {
    const nextAt = actions[i + 1]?.at ?? Infinity
    const before = treeBetween(capture.trees, previousAt, a.at)
    const after = treeBetween(capture.trees, a.at, nextAt)
    const expectable = after && (a.kind === 'tap' || a.kind === 'swipe' || a.kind === 'button' || a.kind === 'launch' || a.kind === 'key')
      ? after.elements.flatMap((e) => {
        const v = expectedFor(e, { secrets, before: before?.elements })
        return 'selector' in v ? [{ selector: v.selector, warnings: v.warnings }] : []
      })
      : undefined
    // The tree before a step is also what `toFlowSteps` reads after a swipe, to tell a scroll that brought the next tap's
    // element into view.
    const common = { ...(expectable ? { expectable } : {}), ...(before ? { before: before.elements, tree: before.elements } : {}) }
    previousAt = a.at
    switch (a.kind) {
      case 'tap': {
        const long = (a.holdMs ?? 0) >= LONG_PRESS_MS
        const said = (selector: Selector): Step => long ? { type: 'longPressOn', selector, durationMs: a.holdMs! } : { type: 'tapOn', selector }
        const point = (fragile: FragileReason): Pick<AgentStep, 'step' | 'fragile' | 'origin'> => ({
          step: long ? { type: 'longPressPoint', at: a.point, durationMs: a.holdMs! } : { type: 'tapPoint', at: a.point },
          fragile, origin: 'coordinate',
        })
        // A name holding a secret's value is passed over for the next way, down to a point, so it is never written
        // (CodeRabbit, #1244).
        const hid = { any: false }
        const usable = (s: Selector | null | undefined): Selector | undefined => {
          if (s && leaks(s)) { hid.any = true; return undefined }
          return s ?? undefined
        }
        const seen = recordedSelector(a.observed)
        const mine = usable(a.selector)
        const observed = usable(seen)
        const base = { raw: raw(a.at), ...common, ...(a.landed ? { landed: a.landed } : {}),
          ...(a.observed?.acted === false ? { noResponse: true as const } : {}), ...(hid.any ? { withheld: true as const } : {}) }
        if (mine) {
          const asked = before && onlyMatch(before.elements, mine)
          const theirs = before && observed && onlyMatch(before.elements, observed)
          const mismatch = asked && theirs && asked !== theirs ? { mismatch: observed! } : {}
          out.push({ ...base, step: said(mine), origin: 'agent', ...mismatch })
          break
        }
        if (observed) {
          const e = before && onlyMatch(before.elements, observed)
          if (!before || (e && hitTest(before.elements, centre(e)) === e)) {
            out.push({ ...base, step: said(observed), origin: 'observed' })
            break
          }
        }
        if (before && !a.observed?.surface) {
          const t = target(before.elements, a.point, undefined)
          const named = 'selector' in t ? usable(t.selector) : undefined
          out.push({ ...base, ...(hid.any ? { withheld: true as const } : {}),
            ...(named ? { step: said(named), origin: 'tree' as const } : point('fragile' in t ? t.fragile : 'no-selector')) })
          break
        }
        out.push({ ...base, ...point('no-element') })
        break
      }
      case 'swipe':
        out.push({
          raw: raw(a.at, { from: a.from, to: a.to, durationMs: a.durationMs }),
          step: { type: 'swipe', from: a.from, to: a.to, durationMs: a.durationMs }, fragile: 'swipe', origin: 'coordinate',
          ...common, ...(before ? { tree: before.elements, ...(before.aspect !== undefined ? { screenAspect: before.aspect } : {}) } : {}),
          ...(a.landed ? { landed: a.landed } : {}),
        })
        break
      case 'type': {
        // Text typed as a secret elsewhere stays one here: a password shown and typed again into a plain field
        // (CodeRabbit, #1244).
        const plain = writable(a) && !mentionsSecret(a.text, secrets)
        out.push({
          raw: raw(a.at), origin: 'agent', ...common,
          step: plain ? { type: 'inputText', text: a.text } : null,
          ...(plain ? {} : { secret: { value: a.text, known: a.field?.secure === true } }),
        })
        break
      }
      case 'key': out.push({ raw: raw(a.at), step: { type: 'pressKey', code: a.code }, origin: 'agent', ...common }); break
      case 'button': out.push({ raw: raw(a.at), step: { type: 'pressButton', name: a.name }, origin: 'agent', ...common }); break
      case 'launch': out.push({ raw: raw(a.at), step: { type: 'launchApp' }, origin: 'agent', ...common }); break
      case 'clearState':
        out.push({ raw: raw(a.at), step: { type: 'clearState', ...(a.bundleId ? { appId: a.bundleId } : {}) }, origin: 'agent', ...common })
        break
      case 'openUrl': out.push({ raw: raw(a.at), step: { type: 'openUrl', url: a.url }, origin: 'agent', ...common }); break
      case 'flow':
        a.steps.forEach((step, k) => out.push({
          raw: raw(a.at), step, origin: 'agent-step', block: a.block, ...(k >= a.passed ? { failed: true as const } : {}),
        }))
        break
    }
  }
  return out
}

/** What the agent decided about its steps (`capture_flow`): numbers are `agentSteps`' indexes from 1, as listed. */
export interface AgentJudgement {
  /** The flow's name, as `flow run` lists it. */
  name: string
  from?: number
  to?: number
  drop?: number[]
  /** An element from the step's `expectable`, by its index there (from 0). */
  expect?: Array<{ step: number; candidate: number }>
  /** A name for a secret step; defaults to `PASSWORD`/`SECRET`, numbered. */
  secrets?: Array<{ step: number; name: string }>
  /** Steps that failed in an earlier Verify of this capture, and which try this is (from 1). Said in the file. */
  failedBefore?: number[]
  attempt?: number
}

export type JudgementRefusal =
  | { step?: number; reason: 'out-of-range' | 'failed-block' | 'no-candidate' | 'not-secret' | 'bad-secret-name' | 'secret-name-taken' | 'bad-range' }
  | { reason: 'nothing-done' }

export interface AgentFlow {
  steps: Step[]
  /** The YAML, with the comment that says where it came from and what was left out. */
  yaml: string
  /** The secrets' values, for Verify only. Never written, never returned to the agent. */
  secrets: Record<string, string>
  /** What a person reviewing the file should know; also the comment's body. */
  notes: string[]
}

/** Steps that do something, beyond starting the app. */
const ACTING = new Set<Step['type']>(['tapOn', 'tapPoint', 'longPressOn', 'longPressPoint', 'inputText', 'inputSecret', 'pressKey',
  'imeAction', 'swipe', 'scroll', 'openUrl', 'pressButton', 'pinch', 'setOrientation', 'setPosture'])

/** As many steps left out as this, or half of those that act, is called out in the file. */
const MANY_DROPPED = 3

/**
 * The flow the agent's judgement makes of its steps, or why the judgement cannot stand. Only these choices exist — a
 * range, steps left out, an element expected from those offered, a secret's name — so every step is still one the agent
 * did or the device saw (D4). What was left out is never hidden (D5): it is in the file's comment and in `notes`.
 * Refused: a step number out of the list, a step past where its `run_flow` failed, an expectation not offered, and a flow
 * that does nothing but start the app.
 */
export function agentFlow(steps: readonly AgentStep[], j: AgentJudgement, opts: { appId?: string } = {}): { ok: true; flow: AgentFlow } | { ok: false; refusals: JudgementRefusal[] } {
  const refusals: JudgementRefusal[] = []
  const n = steps.length
  const inList = (k: number) => Number.isInteger(k) && k >= 1 && k <= n
  const from = j.from ?? 1
  const to = j.to ?? n
  // Before anything walks the range: `to` is the agent's number, and a huge one would be walked (CodeRabbit, #1244).
  if (!inList(from) || !inList(to) || from > to) return { ok: false, refusals: [{ reason: 'bad-range' }] }
  for (const k of j.drop ?? []) if (!inList(k)) refusals.push({ step: k, reason: 'out-of-range' })
  const dropped = new Set(j.drop ?? [])
  const kept = (k: number) => k >= from && k <= to && !dropped.has(k)
  for (let k = from; k <= to; k++) if (kept(k) && steps[k - 1]?.failed) refusals.push({ step: k, reason: 'failed-block' })
  const expectAfter = new Map<number, Selector[]>()
  for (const e of j.expect ?? []) {
    const c = inList(e.step) ? steps[e.step - 1]!.expectable?.[e.candidate] : undefined
    if (!c || !kept(e.step)) { refusals.push({ step: e.step, reason: 'no-candidate' }); continue }
    expectAfter.set(e.step, [...(expectAfter.get(e.step) ?? []), c.selector])
  }
  const names = new Map<number, string>()
  for (const s of j.secrets ?? []) {
    if (!inList(s.step) || !steps[s.step - 1]!.secret) refusals.push({ step: s.step, reason: 'not-secret' })
    else if (!isSecretName(s.name)) refusals.push({ step: s.step, reason: 'bad-secret-name' })
    else names.set(s.step, s.name)
  }
  if (refusals.length) return { ok: false, refusals }

  const chosen: Array<{ k: number; s: CapturedStep }> = []
  for (let k = from; k <= to; k++) if (kept(k)) chosen.push({ k, s: steps[k - 1]! })
  // Manual's export first, on the steps alone: an expectation between a swipe and the tap after it would stop the swipe
  // from becoming the scroll it was for (pre-PR review).
  const captured = toFlowSteps(chosen.map((c) => c.s))
  // The agent's names for its secrets, over the ones `toFlowSteps` numbered. One name, one value: two fields given the
  // same name would be typed the same thing, so a name already holding another value is refused (pre-PR review).
  const secrets: Record<string, string> = {}
  const taken: JudgementRefusal[] = []
  captured.steps.forEach((s, i) => {
    if (s.step?.type !== 'inputSecret') return
    const own = names.get(chosen[i]!.k)
    const value = captured.secrets[s.step.name]!
    const name = own ?? s.step.name
    if (name in secrets && secrets[name] !== value) taken.push({ step: chosen[i]!.k, reason: 'secret-name-taken' })
    secrets[name] = value
    if (own) captured.steps[i] = { ...s, step: { ...s.step, name } }
  })
  if (taken.length) return { ok: false, refusals: taken }
  const withExpects = captured.steps.flatMap((s, i) => [s, ...(expectAfter.get(chosen[i]!.k) ?? [])
    .map((selector): CapturedStep => ({ raw: s.raw, step: { type: 'assertVisible', selector } }))])
  const flowStepsOut = flowSteps({ ...captured, steps: withExpects }, opts)
  if (!flowStepsOut.some((s) => ACTING.has(s.type))) return { ok: false, refusals: [{ reason: 'nothing-done' }] }

  const notes: string[] = []
  const failedBefore = new Set(j.failedBefore ?? [])
  const label = (k: number) => `#${k}`
  const outOfRange = steps.map((_, i) => i + 1).filter((k) => k < from || k > to)
  if (outOfRange.length) notes.push(`Outside the range (${from}–${to}): ${outOfRange.map(label).join(', ')}`)
  const droppedList = [...dropped].sort((a, b) => a - b)
  const afterFailure = droppedList.filter((k) => failedBefore.has(k))
  const byAgent = droppedList.filter((k) => !failedBefore.has(k))
  if (byAgent.length) notes.push(`Left out by the agent: ${byAgent.map(label).join(', ')}`)
  if (afterFailure.length) notes.push(`Left out after they failed in an earlier Verify (dropped-after-verify-failure): ${afterFailure.map(label).join(', ')}`)
  // As exported: a swipe that became `scroll { until }` is not fragile any more.
  const fragile = chosen.flatMap((c, i) => (captured.steps[i]!.fragile && captured.steps[i]!.step?.type !== 'scroll' ? [`${label(c.k)} ${captured.steps[i]!.fragile}`] : []))
  if (fragile.length) notes.push(`Fragile: ${fragile.join(', ')}`)
  const mismatched = chosen.filter((c) => (c.s as AgentStep).mismatch).map((c) => label(c.k))
  const withheld = chosen.filter((c) => (c.s as AgentStep).withheld).map((c) => label(c.k))
  if (withheld.length) notes.push(`Not named by an element whose name holds a typed secret: ${withheld.join(', ')}`)
  if (mismatched.length) notes.push(`The touch was seen to hit another element than the agent named: ${mismatched.join(', ')}`)
  const blocks = [...new Set(chosen.flatMap((c) => ((c.s as AgentStep).origin === 'agent-step' ? [(c.s as AgentStep).block!] : [])))]
  if (blocks.length) notes.push(`Written by the agent (run_flow), not observed: ${blocks.length} block${blocks.length === 1 ? '' : 's'}`)
  // An expectation it already showed proves nothing about the touch, so it is not counted (`expectedFor`'s `before`).
  const realExpects = (j.expect ?? []).filter((e) => !steps[e.step - 1]!.expectable![e.candidate]!.warnings.includes('before'))
  if (realExpects.length === 0) notes.push('Warning: no expectation — the flow checks only that each step could be done')
  const acting = steps.filter((s) => s.step && ACTING.has(s.step.type)).length
  if (dropped.size >= MANY_DROPPED || (acting > 0 && dropped.size * 2 >= acting)) notes.push(`Warning: ${dropped.size} of ${n} steps left out`)
  const header = [`Captured from an AI agent's session over MCP${j.attempt ? `, verified on try ${j.attempt}` : ''}: ${n} steps recorded.`, ...notes]
  const yaml = flowToYaml({ name: j.name, ...(opts.appId ? { appId: opts.appId } : {}), steps: flowStepsOut }, { comment: header.join('\n') })
  return { ok: true, flow: { steps: flowStepsOut, yaml, secrets, notes } }
}
