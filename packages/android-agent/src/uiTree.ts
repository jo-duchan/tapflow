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

// The window's own decor. Android gives almost every view an id, the framework's included, so "an id keeps a
// node" would otherwise put these full-width layers in every tree — noise for an agent reading it, and nothing a
// flow selects. Only these: `android:id/` as a whole also covers real targets such as `android:id/progress`.
const DECOR_IDS = new Set(['android:id/content', 'android:id/statusBarBackground', 'android:id/navigationBarBackground'])
/** Down, for a far edge: `x + width` must not reach past 1 by a rounding step. Same rule as the iOS parser. */
const floor4 = (n: number): number => Math.max(0, Math.floor(n * 10000 + 1e-9) / 10000)

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
    if (!bounds) continue
    // Clip to the display so partially scrolled-out nodes (negative or
    // beyond-screen bounds) never break the 0-1 normalized contract;
    // fully off-screen nodes are dropped.
    const x1 = Math.max(0, bounds.x1)
    const y1 = Math.max(0, bounds.y1)
    const x2 = Math.min(width, bounds.x2)
    const y2 = Math.min(height, bounds.y2)
    if (x2 <= x1 || y2 <= y1) continue

    const label = attrs['text'] || attrs['content-desc'] || ''
    const interactive =
      attrs['clickable'] === 'true' ||
      attrs['long-clickable'] === 'true' ||
      attrs['checkable'] === 'true' ||
      attrs['scrollable'] === 'true'
    // An id keeps a node, as it does on iOS: whoever named it can select it, and a selector by `id` must find
    // it. Without this a node that is neither clickable nor labelled was dropped even when the app named it —
    // measured on a Compose `SeekBar` and on a selected navigation item, which stops being clickable.
    const id = attrs['resource-id'] ?? ''
    // A password field is kept whatever else it lacks: whether typed text may be written down depends on finding it,
    // and a Compose field with no click semantics, no text and no test tag would otherwise drop out like the SeekBar.
    const password = attrs['password'] === 'true'
    if (!interactive && !password && label === '' && (id === '' || DECOR_IDS.has(id))) continue

    const className = attrs['class'] ?? ''
    const element: UIElement = {
      role: toRole(className),
      label,
      // The far edge is rounded down from the rounded near one, so x + width never passes 1: every consumer refuses
      // the whole tree for one element outside 0–1, and a node flush with the bottom edge (the navigation bar's
      // background, 2337/2400) rounded to 1.0001.
      frame: {
        x: round4(x1 / width),
        y: round4(y1 / height),
        width: floor4(x2 / width - round4(x1 / width)),
        height: floor4(y2 / height - round4(y1 / height)),
      },
      enabled: attrs['enabled'] !== 'false',
    }
    if (id) element.identifier = id
    if (className) element.rawRole = className
    // Stated on every input so a missing value means "unknown" (see `UIElement.secure`), and on any node that says it
    // is a password whatever its class.
    if (element.role === 'input' || password) element.secure = password
    if (element.role === 'input') {
      // Only an input: a WebView or Compose host view reports `focused` alongside the field inside it, and a button
      // takes focus once a key event leaves touch mode. Neither is where typing goes.
      if (attrs['focused'] === 'true') element.focused = true
    }
    elements.push(element)
  }
  return elements
}
