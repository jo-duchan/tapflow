import type { UIElement } from '@tapflowio/agent-core'

/**
 * What a touch was seen to do, and what a replay must see it do again (#1125). A tap that landed on the wrong element,
 * or on an overlay the tree does not show, passes every check that looks only at whether the touch was sent — so a flow
 * Flow Capture writes carries, on each touch, what changed on the screen when it was verified, and the engine looks for
 * that change after the touch.
 *
 * The rules are tester-army/e2e's end check (`endAnchors`/`goneAnchors`), fitted to a mobile tree:
 *
 * - **An anchor names an element by what it says, never where it is or what it was minted as**: its identifier when one
 *   is stable and its label when that is, else its role and label, and the switch or selection state a tap changes. The
 *   label rides beside the identifier because a tap's effect is often a label changing on an element that keeps its id
 *   (a status, a count) — measured on the sample app, an id-only key saw nothing. A frame is not in the key, so a device
 *   of another size still finds it.
 * - **Never from what was typed or what hides it**: no input, no secure element, no keyboard key, and no label holding a
 *   secret's value — the anchors are written into the flow file.
 * - **Never from text that changes by itself**: a clock time, a date, a number of four digits or more (an order number, a
 *   year, a price) or a relative time ("3분 전", "5 min ago") is not an anchor. A small number is: a count a tap set, or
 *   "Row 2", replays the same from a cleared app. Every label with a digit was the first rule, and it dropped the most
 *   common effect there is.
 * - **Appeared means newly there; gone means no element on the screen after matches**, so a label that moved to another
 *   node did not go.
 * - **Evidence, not presence**: a replay passes only when the screen before the touch did not already look like the
 *   effect — otherwise data left from an earlier run passes it.
 */
export interface EffectAnchor {
  id?: string
  text?: string
  role?: string
  checked?: boolean
  selected?: boolean
}

export interface StepExpect {
  appear?: EffectAnchor[]
  gone?: EffectAnchor[]
}

/** How many of each a step keeps. Every one must hold on replay, so each is a way to fail on a smaller screen too. */
const MAX_ANCHORS = 4
/** Labels longer than this are prose that reflows, not a name. */
const MAX_TEXT = 80
/** The upper part of the screen: what a smaller device still shows of a list. */
const UPPER = 0.6
/** An identifier the app minted per run: a run of hex or a long token. */
const MINTED = /[0-9a-f]{8,}|[A-Za-z0-9_-]{41,}/i
/** Text that changes by itself between runs: a clock, a date, a long number, a time ago. */
const VOLATILE = [
  /\d{1,2}\s*:\s*\d{2}/,
  /\d{1,4}\s*[./\-년월]\s*\d{1,2}/,
  /\d(?:[\d,.\s]*\d){3,}/,
  /\d+\s*(?:초|분|시간|일|주|개월|달|년)\s*(?:전|후)/,
  /\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s+ago/i,
  // tester-army/e2e's: a duration or an age, and a generated key (letters and digits mixed, twelve or more).
  /\b\d+\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|weeks?|months?|years?)\b/i,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/,
]
const volatile = (text: string): boolean => VOLATILE.some((re) => re.test(text))
/** e2e's count text: a tally the screen shows of its own data, which another run's data changes. */
const COUNT_TEXT = [/\b\d+\s*(?:to|-|–)\s*\d+\s+of\s+\d+\b/i, /\b\d+\s+(?:results?|items?|rows?|entries|records?|matches|total)\b/i]
/** A label with its numbers taken out: two labels of one shape that differ only in their numbers. */
const shapeOf = (text: string): string => text.replace(/\d+/g, '#')
const hasDigit = (text: string): boolean => /\d/.test(text)

/**
 * Judged by shape, not by element: one row whose number moved bars every `Row #` label, which drops a real `Row 3`
 * effect sometimes — the safe direction, a missed anchor and never a false pass (review of #1125).
 *
 * Shapes whose numbers were seen to move with nothing done about it, so their text cannot be an anchor (#1125):
 * - between the settled read and the confirming one 1.5 s later — a live counter, a timer;
 * - between the screen before the touch and after it, for count text only (e2e's rule): `41 items` becoming `42 items`
 *   is the list's data. Any other label that changed only in a number is the touch's effect (`tapped:row.2`).
 */
function driftingShapes(before: readonly UIElement[], after: readonly UIElement[], confirm: readonly UIElement[]): Set<string> {
  const drifting = new Set<string>()
  const moved = (from: readonly UIElement[], to: readonly UIElement[], only?: (label: string) => boolean) => {
    const labels = new Set(to.map((e) => e.label))
    const shapes = new Map<string, Set<string>>()
    for (const e of to) if (hasDigit(e.label)) shapes.set(shapeOf(e.label), (shapes.get(shapeOf(e.label)) ?? new Set()).add(e.label))
    for (const e of from) {
      if (!hasDigit(e.label) || labels.has(e.label) || (only && !only(e.label))) continue
      if (shapes.has(shapeOf(e.label))) drifting.add(shapeOf(e.label))
    }
  }
  moved(after, confirm)
  moved(before, after, (label) => COUNT_TEXT.some((re) => re.test(label)))
  return drifting
}
/** iOS keyboard keys and the keyboard itself (Android's keyboard is another window and not in the app's tree). */
const KEYBOARD_ROLES = new Set(['Key', 'Keyboard'])

/** `inner`'s frame lies within `outer`'s: a button inside the dialog it closes. */
const within = (inner: UIElement, outer: UIElement): boolean =>
  inner.frame.x >= outer.frame.x && inner.frame.y >= outer.frame.y
  && inner.frame.x + inner.frame.width <= outer.frame.x + outer.frame.width
  && inner.frame.y + inner.frame.height <= outer.frame.y + outer.frame.height

export function anchorMatches(e: UIElement, a: EffectAnchor): boolean {
  return (a.id === undefined || e.identifier === a.id)
    && (a.text === undefined || e.label === a.text)
    && (a.role === undefined || e.role === a.role)
    && (a.checked === undefined || (e.checked === true) === a.checked)
    && (a.selected === undefined || (e.selected === true) === a.selected)
}

export const isPresent = (tree: readonly UIElement[], a: EffectAnchor): boolean => tree.some((e) => anchorMatches(e, a))

/** How an anchor reads in a message: its text or id, and the state it is looked for in. */
export function describeAnchor(a: EffectAnchor): string {
  const name = a.text !== undefined ? `"${a.text}"` : `id=${a.id}`
  const states = [
    ...(a.checked === undefined ? [] : [a.checked ? 'on' : 'off']),
    ...(a.selected === undefined ? [] : [a.selected ? 'selected' : 'not selected']),
  ]
  return states.length > 0 ? `${name} (${states.join(', ')})` : name
}

/** Who an element is, as an anchor names it, or `null` when it may not be one. */
function identity(e: UIElement, hidden: readonly string[], drifting: ReadonlySet<string>): EffectAnchor | null {
  if (e.frame.width <= 0 || e.frame.height <= 0) return null
  const cx = e.frame.x + e.frame.width / 2
  const cy = e.frame.y + e.frame.height / 2
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return null
  if (e.role === 'input' || e.secure === true || (e.rawRole !== undefined && KEYBOARD_ROLES.has(e.rawRole))) return null
  if (hidden.some((h) => h.length > 0 && (e.label.includes(h) || (e.identifier ?? '').includes(h)))) return null
  // A bare number with no id to name it is a badge or a tally (e2e's rule); with one, the id says what it counts.
  const bareNumber = /^\d+$/.test(e.label) && !(e.identifier && !MINTED.test(e.identifier))
  const text = e.label.length > 0 && e.label.length <= MAX_TEXT && !volatile(e.label) && !bareNumber && !drifting.has(shapeOf(e.label))
    ? e.label : undefined
  if (e.identifier && !MINTED.test(e.identifier)) return text !== undefined ? { id: e.identifier, text } : { id: e.identifier }
  return text !== undefined ? { text, role: e.role } : null
}

/** The anchor for `e` on its side of the touch: who it is, and the states that differ from the same element across. */
function anchorOf(e: UIElement, who: EffectAnchor, other: readonly UIElement[]): EffectAnchor {
  const a: EffectAnchor = { ...who }
  const twin = other.filter((o) => anchorMatches(o, who))
  if (e.checked === true || twin.some((o) => o.checked === true)) a.checked = e.checked === true
  if (e.selected === true || twin.some((o) => o.selected === true)) a.selected = e.selected === true
  return a
}

interface Ranked { anchor: EffectAnchor; e: UIElement }

const rank = (list: Ranked[]): EffectAnchor[] => {
  const seen = new Set<string>()
  return list
    .filter(({ anchor }) => {
      const key = JSON.stringify(anchor)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((p, q) => {
      const byId = Number(q.anchor.id !== undefined) - Number(p.anchor.id !== undefined)
      if (byId !== 0) return byId
      const upper = (r: Ranked) => Number(r.e.frame.y + r.e.frame.height / 2 < UPPER)
      const byUpper = upper(q) - upper(p)
      if (byUpper !== 0) return byUpper
      return p.e.frame.width * p.e.frame.height - q.e.frame.width * q.e.frame.height
    })
    .slice(0, MAX_ANCHORS)
    .map((r) => r.anchor)
}

/**
 * What a touch was seen to do: the screen before it, the screen once it settled, and a read a moment later to confirm
 * (a spinner or a toast that was there at the first read is not an effect). `previous` is what earlier steps were seen
 * to bring, whose leaving is not by itself this one's doing; `touched` is the element the touch went to. `null` when
 * nothing that may be an anchor changed.
 */
export function observeEffect(
  before: readonly UIElement[], after: readonly UIElement[], confirm: readonly UIElement[],
  opts: { hidden?: readonly string[]; previous?: StepExpect | null; touched?: UIElement } = {},
): StepExpect | null {
  const hidden = opts.hidden ?? []
  const drifting = driftingShapes(before, after, confirm)
  const previous = new Set((opts.previous?.appear ?? []).map((a) => JSON.stringify(a)))
  const fromBefore: Ranked[] = []
  const appear: Ranked[] = []
  for (const e of after) {
    const who = identity(e, hidden, drifting)
    if (!who) continue
    const anchor = anchorOf(e, who, before)
    if (!isPresent(before, anchor) && isPresent(confirm, anchor)) appear.push({ anchor, e })
  }
  const gone: Ranked[] = []
  for (const e of before) {
    const who = identity(e, hidden, drifting)
    if (!who) continue
    const anchor = anchorOf(e, who, after)
    if (isPresent(after, anchor) || isPresent(confirm, anchor)) continue
    ;(previous.has(JSON.stringify(anchor)) ? fromBefore : gone).push({ anchor, e })
  }
  // What an earlier touch brought and is gone now: this touch's doing only when it touched what went (Close on a dialog,
  // or anything inside it) and nothing else changed. A toast going on its own clock while an unrelated touch is watched
  // would otherwise become that touch's `gone`, which a replay then finds already gone (review of #1125). Left out
  // always, the sample app's Close saw nothing.
  const touched = opts.touched
  const closedByTouch = touched !== undefined && fromBefore.some(({ anchor, e }) => anchorMatches(touched, anchor) || within(touched, e))
  if (appear.length === 0 && gone.length === 0 && closedByTouch) gone.push(...fromBefore)
  const expect: StepExpect = {}
  const a = rank(appear)
  const g = rank(gone)
  if (a.length > 0) expect.appear = a
  if (g.length > 0) expect.gone = g
  return a.length > 0 || g.length > 0 ? expect : null
}

export type EffectVerdict =
  | { met: true }
  | { met: false; missing: EffectAnchor; kind: 'appear' | 'gone' }

/** Whether `now` shows the effect: every anchor that appears is there, and every one that goes is not. */
export function judgeEffect(expect: StepExpect, now: readonly UIElement[]): EffectVerdict {
  const missing = expect.appear?.find((a) => !isPresent(now, a))
  if (missing) return { met: false, missing, kind: 'appear' }
  const still = expect.gone?.find((a) => isPresent(now, a))
  if (still) return { met: false, missing: still, kind: 'gone' }
  return { met: true }
}

/** Whether the screen before a touch leaves anything for it to do: one anchor not yet there, or one still to go. */
export function effectPending(expect: StepExpect, baseline: readonly UIElement[]): boolean {
  return (expect.appear ?? []).some((a) => !isPresent(baseline, a)) || (expect.gone ?? []).some((a) => isPresent(baseline, a))
}

/**
 * Watches a run of touches as one sequence: what each brought is remembered until it is seen gone, so a toast that
 * outlives a step or two is not by itself a later touch's effect. Verify's engine and Match's replay each keep one.
 */
export class EffectWatch {
  private brought: EffectAnchor[] = []
  /** The last screen a touch was watched on: what appeared between it and the next touch, a step that is not watched
   *  brought (a toast after `imeAction` — review of #1125), and its leaving is no touch's doing either. */
  private lastSeen: readonly UIElement[] | undefined

  observe(
    before: readonly UIElement[], after: readonly UIElement[], confirm: readonly UIElement[],
    opts: { hidden?: readonly string[]; touched?: UIElement } = {},
  ): StepExpect | null {
    if (this.lastSeen) {
      const keys = new Set(this.brought.map((a) => JSON.stringify(a)))
      for (const a of observeEffect(this.lastSeen, before, before, { previous: { appear: this.brought } })?.appear ?? []) {
        if (!keys.has(JSON.stringify(a))) this.brought.push(a)
      }
    }
    this.lastSeen = confirm
    const seen = observeEffect(before, after, confirm, { ...opts, previous: { appear: this.brought } })
    if (seen) {
      const went = new Set((seen.gone ?? []).map((a) => JSON.stringify(a)))
      const kept = this.brought.filter((a) => !went.has(JSON.stringify(a)))
      const keys = new Set(kept.map((a) => JSON.stringify(a)))
      this.brought = [...kept, ...(seen.appear ?? []).filter((a) => !keys.has(JSON.stringify(a)))]
    }
    return seen
  }
}

/**
 * What two looks at one touch agree it did: the anchors both saw, minutes apart (Match's replay and Verify's run). A
 * number that changes by itself slower than one look's confirming read usually differs between the two, which no
 * pattern can tell (research for #1125: e2e cannot either, and Diffy's noise filter is this, run twice). `null` when
 * they share nothing — a touch whose effect is not seen the same way twice is not one a run can hold it to.
 */
// Each side was cut to its top anchors before they meet, so one that both saw can be left out when either side ranked
// others above it (Match's read has no confirming read to drop a spinner): fewer anchors, never a false pass.
export function agreedEffect(a: StepExpect | null, b: StepExpect | null): StepExpect | null {
  if (!a || !b) return null
  const both = (x: EffectAnchor[] = [], y: EffectAnchor[] = []) => {
    const keys = new Set(y.map((v) => JSON.stringify(v)))
    return x.filter((v) => keys.has(JSON.stringify(v)))
  }
  const appear = both(a.appear, b.appear)
  const gone = both(a.gone, b.gone)
  const out: StepExpect = {}
  if (appear.length > 0) out.appear = appear
  if (gone.length > 0) out.gone = gone
  return appear.length > 0 || gone.length > 0 ? out : null
}
