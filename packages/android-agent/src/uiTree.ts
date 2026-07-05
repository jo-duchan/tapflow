import type { UIElement, UIElementRole } from '@tapflowio/agent-core'
import { PlatformError } from '@tapflowio/agent-core'

// Ordered: first match wins. Composite names (ToggleButton, RadioButton,
// AutoCompleteTextView, ImageButton) must hit their specific role before the
// generic Button/TextView/Image substrings.
const ROLE_RULES: Array<[RegExp, UIElementRole]> = [
  [/EditText|AutoCompleteTextView|SearchView/, 'input'],
  [/CheckBox|CheckedTextView|RadioButton/, 'checkbox'],
  [/Switch|Toggle/, 'switch'],
  [/SeekBar|RatingBar/, 'slider'],
  [/TabWidget|TabLayout|TabView/, 'tab'],
  [/Button/, 'button'],
  [/Image/, 'image'],
  [/RecyclerView|ListView|GridView|ScrollView|ViewPager/, 'list'],
  [/TextView/, 'text'],
]

function toRole(className: string): UIElementRole {
  for (const [re, role] of ROLE_RULES) {
    if (re.test(className)) return role
  }
  return 'other'
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

interface RawNode {
  attrs: Record<string, string>
  bounds: { x1: number; y1: number; x2: number; y2: number } | null
}

function parseBounds(v: string | undefined): RawNode['bounds'] {
  const m = v?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)
  if (!m) return null
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000

export function parseUiAutomatorDump(xml: string): UIElement[] {
  if (!xml.includes('<hierarchy')) {
    throw new PlatformError(`uiautomator dump did not return a UI hierarchy: ${xml.slice(0, 200).trim() || '(empty output)'}`)
  }

  const nodes: RawNode[] = []
  for (const tag of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of tag[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[a[1]] = decodeEntities(a[2])
    }
    nodes.push({ attrs, bounds: parseBounds(attrs['bounds']) })
  }
  if (nodes.length === 0) return []

  // The root node spans the current display, so dumps normalize correctly in
  // any orientation without a separate `wm size` round-trip. Fall back to the
  // max extents when the root reports a degenerate frame.
  let width = nodes[0].bounds?.x2 ?? 0
  let height = nodes[0].bounds?.y2 ?? 0
  if (width <= 0 || height <= 0) {
    for (const n of nodes) {
      if (!n.bounds) continue
      width = Math.max(width, n.bounds.x2)
      height = Math.max(height, n.bounds.y2)
    }
  }
  if (width <= 0 || height <= 0) {
    throw new PlatformError('uiautomator dump contains no usable bounds')
  }

  const elements: UIElement[] = []
  for (const { attrs, bounds } of nodes) {
    if (!bounds || bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue

    const label = attrs['text'] || attrs['content-desc'] || ''
    const interactive =
      attrs['clickable'] === 'true' ||
      attrs['long-clickable'] === 'true' ||
      attrs['checkable'] === 'true' ||
      attrs['scrollable'] === 'true'
    if (!interactive && label === '') continue

    const className = attrs['class'] ?? ''
    const element: UIElement = {
      role: toRole(className),
      label,
      frame: {
        x: round4(bounds.x1 / width),
        y: round4(bounds.y1 / height),
        width: round4((bounds.x2 - bounds.x1) / width),
        height: round4((bounds.y2 - bounds.y1) / height),
      },
      enabled: attrs['enabled'] !== 'false',
    }
    if (attrs['resource-id']) element.identifier = attrs['resource-id']
    if (className) element.rawRole = className
    elements.push(element)
  }
  return elements
}
