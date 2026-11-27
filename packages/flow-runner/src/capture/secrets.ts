import type { Selector, Step } from '../schema.js'
import type { CapturedStep } from './match.js'

/**
 * Whether a captured flow would write a secret's value: the one rule Manual (the dashboard) and MCP (`agent.ts`) keep
 * every value typed as a secret out of a file with. Each producer still filters what it makes (a tap is named the next
 * way, an expectation is not offered); these are what they filter by, and `stepHoldsSecret` is the check at the exit,
 * so a path nobody thought of cannot write one either (CodeRabbit, #1248, found three in a row).
 *
 * Values are matched as they were typed, against the strings as they are held — never a serialized form, whose escaping
 * (`"` → `\"`) hides a value with a quote or a backslash in it.
 */

/** Whether `text` holds any of the secrets' values. */
export function mentionsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => s.length > 0 && text.includes(s))
}

/** The values to look for, from the texts typed as secrets: each whole, and each piece between a Tab or a Return, since
 *  one typing with those in it may have filled two fields, a password's among them. */
export function secretPieces(typed: readonly string[]): string[] {
  return typed.flatMap((t) => [t, ...t.split(/[\t\n\r]/)]).filter((v) => v.length > 0)
}

/** Whether a selector holds a secret's value in any of its strings but its `role`. */
export function selectorHoldsSecret(sel: Selector, secrets: readonly string[]): boolean {
  return holds(sel, secrets)
}

/**
 * Steps whose strings are all the flow's own words or the platform's (a key code, a button, an orientation, the app's
 * bundle id): nothing typed can be in them, and reading them only matched a short secret by chance — a one-character
 * value typed into a field that could not say it was plain took every `pressKey: Tab` with it (review of #1248's
 * follow-up). An `inputSecret`'s name is the point of it.
 */
const UNTYPED = new Set<Step['type']>(['inputSecret', 'pressKey', 'pressButton', 'imeAction', 'setOrientation', 'setPosture', 'clearState'])
/** The same kind of word inside a step: a step's `type`, an element's `role` (button, cell), a scroll's `direction`. */
const VOCABULARY = new Set(['type', 'role', 'direction'])

/** Whether a step would write a secret's value: any string in it that could hold typed text, nested ones included
 *  (`scroll.until`, `pinch.on`, an `expect`'s anchors, a launch's arguments). */
export function stepHoldsSecret(step: Step, secrets: readonly string[]): boolean {
  return !UNTYPED.has(step.type) && holds(step, secrets)
}

function holds(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return mentionsSecret(value, secrets)
  if (Array.isArray(value)) return value.some((v) => holds(v, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => !VOCABULARY.has(k) && holds(v, secrets))
  }
  return false
}

/**
 * A captured step (Manual's) as it may be written, given every value now known to be a secret: unchanged — the same
 * object, which `withEffects` pairs Match's look by — unless a string in it holds one. Then it is said without its name
 * (`unnamed`: the point, or the swipe a scroll was), marked `secret-name`, or left out as `holds-secret` when it has no
 * such form. Run at the exit rather than at Match, because a value can be made a secret in Edit, after the name was
 * chosen.
 */
export function withoutSecretNames(s: CapturedStep, secrets: readonly string[]): CapturedStep {
  if (!s.step || secrets.length === 0 || !stepHoldsSecret(s.step, secrets)) return s
  const { auto: _auto, unnamed, ...rest } = s
  return unnamed && !stepHoldsSecret(unnamed, secrets)
    // A reason it was fragile already is kept: it says what to check (a stray second tap), and the point says the rest.
    ? { ...rest, step: unnamed, fragile: rest.fragile ?? 'secret-name' }
    : { ...rest, step: null, skipped: 'holds-secret' }
}
