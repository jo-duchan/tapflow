import { parse as parseYaml } from 'yaml'
import type { UIElement } from '@tapflowio/agent-core'
import { parseSelector, type Selector } from './schema.js'
import { matchSelector } from './selector.js'

/**
 * A `tapOn` line to try instead of one that matched nothing or several (B2). No LLM: the tree the runner failed to
 * match, ranked against the selector.
 *
 * **Only for `tapOn`.** An `assertVisible` that misses is as often the app being wrong as the flow, and a near match
 * offered as a fix would let a regression be "fixed" into a pass — by a person, or by an agent reading `get_run`.
 */
export interface SelectorSuggestion {
  /** The step line, as it would be written in the flow: `tapOn: "Pay now"`, `tapOn: { id: "pay" }`. */
  yaml: string
  /** What it taps. An input's label is left out: it can be what was typed into it. */
  element: { role: string; label: string; identifier?: string }
}

const MAX_SUGGESTIONS = 3
/** Longer than this is a paragraph, not a name to select by — and too long to store whole. */
const MAX_NAME = 200
/** At or under this many characters, only the same text or one containing the other counts: "Pay" and "Day" are one
 *  letter apart and nothing alike. */
const SHORT = 4
const MIN_EDIT_RATIO = 0.7

type Form = { text?: string; id?: string; label?: string; role?: string; index?: number }

export function suggestSelectors(tree: UIElement[], sel: Selector): SelectorSuggestion[] {
  const wanted = { text: sel.text, id: sel.id, label: sel.label }
  const ranked = tree
    .map((e, order) => ({ e, order, score: onScreen(e) ? scoreElement(e, wanted) : 0 }))
    // An image only by the same name. Its label is usually an asset name ("donut", "topping/zigzag-blue-thumb"), not
    // text anyone sees, so a near one is noise — and seen on Food Truck, a missing "Donuts" card suggested the donut
    // icon in an order row, which opens that order.
    .filter((c) => c.score > 0 && (c.e.role !== 'image' || c.score === 1))
    .sort((a, b) => b.score - a.score || a.order - b.order)

  const out: SelectorSuggestion[] = []
  for (const { e } of ranked) {
    const yaml = firstVerifiedForm(tree, e, sel)
    if (!yaml) continue
    out.push({
      yaml: `tapOn: ${yaml}`,
      element: { role: e.role, label: e.role === 'input' || e.secure === true ? '' : e.label, ...(e.identifier ? { identifier: e.identifier } : {}) },
    })
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * A selector that taps exactly `target` on this screen, or `null` when none does — the same verified forms a
 * suggestion is built from, for Flow Capture's turning a recorded tap into `tapOn` (#1125).
 */
export function selectorFor(tree: UIElement[], target: UIElement): Selector | null {
  const yaml = firstVerifiedForm(tree, target, {})
  return yaml === null ? null : parseSelector((parseYaml(`v: ${yaml}`) as { v: unknown }).v, 'capture')
}

/**
 * The simplest selector that, **written out and read back the way a pasted line would be**, taps exactly `target` in
 * this tree — the same element, not just one element. A bare string resolves by identifier first, and on iOS an
 * identifier is often some other element's title, so "matches one" alone would suggest tapping the wrong thing.
 * `index` comes last: it holds only while the screen keeps its order.
 */
function firstVerifiedForm(tree: UIElement[], target: UIElement, sel: Selector): string | null {
  const timeout = sel.timeoutMs !== undefined ? sel.timeoutMs / 1000 : undefined
  // A secure element's label can be what was typed into it, whatever its role (an Android password node of another
  // class), so it is never a name to select by.
  const named = target.role !== 'input' && target.secure !== true && target.label.trim().length > 0 && target.label.length <= MAX_NAME
  const id = target.identifier && target.identifier.length <= MAX_NAME ? target.identifier : undefined

  const byLabel: Form[] = named
    ? [...(timeout === undefined ? [{ text: target.label }] : []), { label: target.label }, { label: target.label, role: target.role }]
    : []
  // A placeholder is offered where an input's label is not: the label can be what was typed into the field,
  // the placeholder never is. Bare text only, so it resolves through the same placeholder fallback.
  const placeholder = target.placeholder && target.placeholder.length <= MAX_NAME ? target.placeholder : undefined
  const byPlaceholder: Form[] = placeholder && timeout === undefined ? [{ text: placeholder }] : []
  const byId: Form[] = id ? [{ id }, { id, role: target.role }] : []
  const byIndex: Form[] = [
    ...(named ? [indexed(tree, target, { label: target.label, role: target.role })] : []),
    ...(id ? [indexed(tree, target, { id, role: target.role })] : []),
  ].filter((f): f is Form => f !== null)

  const order = sel.id !== undefined
    ? [...byId, ...byLabel, ...byPlaceholder, ...byIndex]
    : [...byLabel, ...byId, ...byPlaceholder, ...byIndex]
  for (const form of order) {
    const yaml = emit(form, timeout)
    if (resolvesTo(tree, yaml) === target) return yaml
  }
  return null
}

function indexed(tree: UIElement[], target: UIElement, base: Form): Form | null {
  const i = matchSelector(tree, base as Selector).indexOf(target)
  return i < 0 ? null : { ...base, index: i }
}

function emit(form: Form, timeout: number | undefined): string {
  if (form.text !== undefined) return JSON.stringify(form.text)
  // JSON strings are valid YAML double-quoted scalars, so quotes, colons and newlines in a label survive.
  const parts = [
    form.id !== undefined ? `id: ${JSON.stringify(form.id)}` : null,
    form.label !== undefined ? `label: ${JSON.stringify(form.label)}` : null,
    form.role !== undefined ? `role: ${JSON.stringify(form.role)}` : null,
    form.index !== undefined ? `index: ${form.index}` : null,
    timeout !== undefined ? `timeout: ${timeout}` : null,
  ].filter(Boolean)
  return `{ ${parts.join(', ')} }`
}

/** The one element the line taps, through the flow schema's own parser, or null. */
function resolvesTo(tree: UIElement[], yaml: string): UIElement | null {
  let selector: Selector
  try {
    selector = parseSelector((parseYaml(`v: ${yaml}`) as { v: unknown }).v, 'suggestion')
  } catch {
    return null
  }
  const hit = matchSelector(tree, selector)
  return hit.length === 1 ? hit[0]! : null
}

function onScreen(e: UIElement): boolean {
  const cx = e.frame.x + e.frame.width / 2
  const cy = e.frame.y + e.frame.height / 2
  return e.frame.width > 0 && e.frame.height > 0 && cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1
}

function scoreElement(e: UIElement, wanted: { text?: string; id?: string; label?: string }): number {
  const scores: number[] = []
  if (wanted.text !== undefined) {
    scores.push(similarity(wanted.text, e.label), similarity(wanted.text, e.identifier ?? ''), similarity(wanted.text, e.placeholder ?? ''))
  }
  if (wanted.label !== undefined) scores.push(similarity(wanted.label, e.label))
  if (wanted.id !== undefined) scores.push(similarity(wanted.id, e.identifier ?? ''))
  return Math.max(0, ...scores)
}

function normalise(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()
}

/** 0 for unrelated, 1 for the same text once case, spacing and punctuation are set aside. */
export function similarity(wanted: string, candidate: string): number {
  // Both sides: a pasted paragraph as the selector would otherwise run the edit distance against every element.
  if (candidate.length === 0 || candidate.length > MAX_NAME || wanted.length > MAX_NAME) return 0
  const w = normalise(wanted)
  const c = normalise(candidate)
  if (!w || !c) return 0
  if (w === c) return 1
  const wl = [...w].length
  const cl = [...c].length
  if (w.includes(c) || c.includes(w)) {
    const ratio = Math.min(wl, cl) / Math.max(wl, cl)
    return ratio >= 0.5 ? 0.7 + 0.2 * ratio : 0
  }
  if (Math.min(wl, cl) <= SHORT) return 0
  // Hangul by jamo: a syllable is one code point, so a one-jamo typo ("결재" for "결제") would count as a whole
  // letter wrong. Short words are already excluded above; this is what lets a longer label with such typos match.
  const a = [...w.normalize('NFD')]
  const b = [...c.normalize('NFD')]
  if (b.length > a.length * 3) return 0
  const ratio = 1 - editDistance(a, b) / Math.max(a.length, b.length)
  return ratio >= MIN_EDIT_RATIO ? 0.6 * ratio : 0
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}
