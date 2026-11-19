import type { UIElement } from '@tapflowio/agent-core'
import { lastingId, showsTyping, tellsTime } from '../effect.js'
import { matchSelector } from '../selector.js'
import type { Selector } from '../schema.js'

/**
 * What a person can expect a touch to bring (1b-3c): an element they pick on the screen after it, written into the flow
 * as an `assertVisible` right after the touch. The automatic `expect` guesses a touch's effect; this is the person's own
 * answer, and its point is the values a guess leaves out — a total, a count — so a number is never refused here.
 */
export type ExpectedVerdict =
  | { refused: ExpectRefusal }
  | { selector: Selector; warnings: ExpectWarning[] }

export type ExpectRefusal =
  /** An input shows what was typed, a secure field hides it, a key is the keyboard: none is the touch's result. */
  | 'typing'
  /** Its text holds a secret's value, which the flow file must never hold. */
  | 'secret'
  /** No label to check: an id alone says the element is there, not what it shows. */
  | 'unnamed'

export type ExpectWarning =
  /** It was on the screen before the touch too, so seeing it says nothing about what the touch did. */
  | 'before'
  /** A clock, a date or a time ago: another run shows another one. */
  | 'time'

/**
 * The expected element `e`, picked on the screen after a touch. Its selector checks what it shows: the whole label,
 * never a label that contains it (`exact`) — "Total $12" must not pass on "Total $12.50" — with the element's lasting
 * id beside it when it has one, so a second element showing the same text does not answer for it.
 */
export function expectedFor(e: UIElement, ctx: { secrets: readonly string[]; before?: readonly UIElement[] }): ExpectedVerdict {
  if (showsTyping(e)) return { refused: 'typing' }
  if (mentionsSecret(e.label, ctx.secrets) || mentionsSecret(e.identifier ?? '', ctx.secrets)) return { refused: 'secret' }
  if (e.label.length === 0) return { refused: 'unnamed' }
  const id = lastingId(e)
  const selector: Selector = { ...(id ? { id } : {}), label: e.label, exact: true }
  const warnings: ExpectWarning[] = []
  if (ctx.before && matchSelector([...ctx.before], selector).length > 0) warnings.push('before')
  if (tellsTime(e.label)) warnings.push('time')
  return { selector, warnings }
}

/** Whether `text` holds any of the secrets' values. */
export function mentionsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => s.length > 0 && text.includes(s))
}
