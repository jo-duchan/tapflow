import type { UIElement } from '@tapflowio/agent-core'
import type { Selector } from './schema.js'

// Selector resolution: explicit id → identifier only; explicit label → exact then partial (exact only with `exact`); bare text →
// exact identifier, then exact label, then partial label, then exact placeholder. The placeholder comes last
// so it only answers a selector that found nothing before it existed — a flow that resolved by label keeps
// resolving to the same element. It is never matched in part: placeholders are short, common words
// ("Search", "Name"). role then narrows by element kind, and index
// (0-based) picks one of the remaining matches — so a label shared by e.g. a button and its inner text
// can be disambiguated with { label, role: button }, and a label-less row with { role: cell, index }.
export function matchSelector(tree: UIElement[], sel: Selector): UIElement[] {
  let pool: UIElement[]
  if (sel.text !== undefined) {
    const text = sel.text
    const byId = tree.filter((e) => e.identifier === text)
    const exact = tree.filter((e) => e.label === text)
    const partial = text.length > 0 ? tree.filter((e) => e.label.includes(text)) : []
    pool = byId.length > 0
      ? byId
      : exact.length > 0
        ? exact
        : partial.length > 0
          ? partial
          : tree.filter((e) => e.placeholder !== undefined && e.placeholder === text)
  } else {
    pool = tree
    if (sel.id !== undefined) pool = pool.filter((e) => e.identifier === sel.id)
    if (sel.label !== undefined) {
      const label = sel.label
      const exact = pool.filter((e) => e.label === label)
      pool = exact.length > 0 || sel.exact ? exact : pool.filter((e) => e.label.includes(label))
    }
  }
  if (sel.role !== undefined) pool = pool.filter((e) => e.role === sel.role)
  if (sel.index !== undefined) {
    const el = pool[sel.index]
    return el ? [el] : []
  }
  return pool
}
