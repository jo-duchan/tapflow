import type { Selector, Step } from '../schema.js'

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

/** Whether a selector holds a secret's value in any of its strings. */
export function selectorHoldsSecret(sel: Selector, secrets: readonly string[]): boolean {
  return holds(sel, secrets)
}

/** Whether a step would write a secret's value: any string in it, nested ones included (`scroll.until`, `pinch.on`, an
 *  `expect`'s anchors). Not its `type`, a word of the vocabulary, nor an `inputSecret`'s name, which is the point of it. */
export function stepHoldsSecret(step: Step, secrets: readonly string[]): boolean {
  if (step.type === 'inputSecret') return false
  const { type: _type, ...rest } = step
  return holds(rest, secrets)
}

function holds(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return mentionsSecret(value, secrets)
  if (Array.isArray(value)) return value.some((v) => holds(v, secrets))
  if (value !== null && typeof value === 'object') return Object.values(value).some((v) => holds(v, secrets))
  return false
}
