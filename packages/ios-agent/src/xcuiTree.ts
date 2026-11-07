import type { UIElement, UIElementRole } from '@tapflowio/agent-core'

// Parses the text emitted by XCUIApplication.debugDescription (served by the
// resident xctest-runner) into the unified UIElement schema. Kept as a pure
// function so it stays unit-testable against a fixed fixture (Open Q9: a format
// change in a future Xcode is caught by the snapshot regression test).
//
// A debugDescription element line looks like:
//   NavigationBar, 0x105808b10, {{0.0, 47.4}, {402.0, 47.4}}, identifier: 'The App'
//   Other, 0x105810800, {{0.0, 131.3}, {402.0, 66.4}}, identifier: 'Echo Box', label: 'Echo Box'
//   Other, 0x105811820, {{366.6, 94.7}, {32.2, 779.3}}, label: 'Vertical scroll bar', value: 0%
//   TextField, 0x105812a00, {{20.0, 120.0}, {362.0, 34.0}}, identifier: 'email', placeholderValue: 'Email'
//   Button, 0x105813b00, {{279.0, 795.0}, {98.0, 54.0}}, identifier: 'tab.web', label: 'Web', Selected
// Fields after the address appear in order: [pid], [frame], [identifier], [label], [placeholderValue],
// [value], then state flags (Selected, Focused, ...).

// XCUITest element type → unified vocabulary. XCUITest labels many custom/composed
// views as "Other" (they still carry identifier/label), so role is best-effort and
// identifier/label carry the selector weight.
function toRole(type: string): UIElementRole {
  switch (type) {
    case 'Button':
    case 'Key':
      return 'button'
    case 'TextField':
    case 'SecureTextField':
    case 'SearchField':
    case 'TextView':
      return 'input'
    case 'StaticText':
      return 'text'
    case 'Image':
    case 'Icon':
      return 'image'
    case 'Switch':
    case 'Toggle':
      return 'switch'
    case 'CheckBox':
      return 'checkbox'
    case 'Slider':
      return 'slider'
    case 'Table':
    case 'CollectionView':
    case 'ScrollView':
      return 'list'
    case 'Cell':
      return 'cell'
    case 'TabBar':
    case 'TabGroup':
      return 'tab'
    default:
      return 'other'
  }
}

const ACTIONABLE = new Set<UIElementRole>(['button', 'input', 'checkbox', 'switch', 'slider', 'tab', 'cell'])
const round4 = (n: number): number => Math.round(n * 10000) / 10000
/** Down, for a far edge: `x + width` must not reach past 1 by a rounding step. */
const floor4 = (n: number): number => Math.max(0, Math.floor(n * 10000 + 1e-9) / 10000)

interface RawNode {
  type: string
  frame?: { x: number; y: number; width: number; height: number }
  identifier?: string
  label?: string
  placeholder?: string
  /** Text-input focus: the line's trailing flags carry `Keyboard Focused`. A bare `Focused` is not it — a focused
   *  button prints that too (`Selected, Focused` on a tab), and typing does not go there. */
  focused?: boolean
}

const FRAME_RE = /\{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}/
// Terminate quoted fields on the next field boundary, so a quote inside the
// value (e.g. label: 'Don't') does not truncate the match. A boundary is one of
// the fields that can follow — `placeholderValue` on a text field, `value`
// even though it isn't captured — or the end of the line, which may carry state
// flags first (`, Selected`, `, Focused`). Missing either let the lazy match run
// on to the line's last quote: a placeholder field's identifier came out as
// `email', placeholderValue: 'Email`, and a selected tab's label as nothing.
// A flag may be two capitalised words: `Keyboard Focused` is printed on a text field being typed into
// (iOS 26.5, measured), which a single-word pattern would have let the lazy match run past.
const TRAILING_FLAGS = String.raw`(?:, [A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*)*$`
const IDENTIFIER_RE = new RegExp(String.raw`, identifier: '(.*?)'(?=, label: |, placeholderValue: |, value: |${TRAILING_FLAGS})`)
const LABEL_RE = new RegExp(String.raw`, label: '(.*?)'(?=, placeholderValue: |, value: |${TRAILING_FLAGS})`)
// Kept after typing: measured, a field holding "abc" still prints `placeholderValue: 'Email', value: abc`. An
// empty field echoes the placeholder into `value` too, which is one reason `value` is not read here.
const PLACEHOLDER_RE = new RegExp(String.raw`, placeholderValue: '(.*?)'(?=, value: |${TRAILING_FLAGS})`)
// Read from the flags at the end of the line only. Searching the whole line would take `label: 'Tap, Keyboard
// Focused'` for a flag; a quoted field ends in `'`, so the tail cannot reach into one.
const FLAG_TAIL_RE = new RegExp(TRAILING_FLAGS)

function parseLine(line: string): RawNode | null {
  // Strip indentation + the root arrow, then take the type up to ", 0x<addr>".
  const m = /^\s*→?\s*(.+?), 0x[0-9a-fA-F]+/.exec(line)
  if (!m) return null
  const node: RawNode = { type: m[1] }

  const fm = FRAME_RE.exec(line)
  if (fm) {
    node.frame = { x: parseFloat(fm[1]), y: parseFloat(fm[2]), width: parseFloat(fm[3]), height: parseFloat(fm[4]) }
  }
  const im = IDENTIFIER_RE.exec(line)
  if (im) node.identifier = im[1]
  const lm = LABEL_RE.exec(line)
  if (lm) node.label = lm[1]
  const pm = PLACEHOLDER_RE.exec(line)
  if (pm && pm[1] !== '') node.placeholder = pm[1]
  const tail = FLAG_TAIL_RE.exec(line)?.[0] ?? ''
  if (tail.split(', ').includes('Keyboard Focused')) node.focused = true
  return node
}

const ORIENTATION_HEADER = /^TAPFLOW_INTERFACE_ORIENTATION (\d+)\r?\n/

/**
 * The runner's first line (`TAPFLOW_INTERFACE_ORIENTATION <UIInterfaceOrientation>`) split off the tree, as the
 * clockwise turn that stands the app's interface up in the portrait framebuffer: landscape right — the home button on
 * the right, the device turned left — is 270, measured on an iPhone simulator. 0, an unknown value or no line (a
 * runner built before it) is no information. Split here rather than left to `parseTreeText`, whose fallback for a body
 * with no `Element subtree:` stops at the first line it cannot read and would return an empty tree.
 */
export function splitInterfaceTurn(text: string): { body: string; interfaceTurn?: 0 | 90 | 180 | 270 } {
  const m = ORIENTATION_HEADER.exec(text)
  if (!m) return { body: text }
  const body = text.slice(m[0].length)
  const turn = ({ 1: 0, 2: 180, 3: 270, 4: 90 } as const)[Number(m[1]) as 1 | 2 | 3 | 4]
  return turn === undefined ? { body } : { body, interfaceTurn: turn }
}

export function parseTreeText(text: string): UIElement[] {
  const lines = text.split('\n')
  const startIdx = lines.findIndex((l) => l.trim() === 'Element subtree:')
  const bodyLines = startIdx >= 0 ? lines.slice(startIdx + 1) : lines

  const raw: RawNode[] = []
  for (const line of bodyLines) {
    if (!line.trim()) continue
    // debugDescription ends with sections like "Path to element:" / "Query chain:".
    if (!/, 0x[0-9a-fA-F]+/.test(line)) break
    const node = parseLine(line)
    if (node) raw.push(node)
  }

  // Screen size = the first Window frame (normalization basis, same coordinate
  // space as the tap path). Fall back to the largest frame if no Window is found.
  const windowFrame = raw.find((n) => n.type.startsWith('Window') && n.frame)?.frame
  const basis = windowFrame ?? raw.reduce<RawNode['frame']>((max, n) => {
    if (!n.frame) return max
    const area = n.frame.width * n.frame.height
    return !max || area > max.width * max.height ? n.frame : max
  }, undefined)
  if (!basis || basis.width <= 0 || basis.height <= 0) return []

  const elements: UIElement[] = []
  for (const node of raw) {
    if (!node.frame || node.frame.width <= 0 || node.frame.height <= 0) continue
    const role = toRole(node.type)
    const label = node.label ?? ''
    // Skip pure structural containers with no label and no actionable role.
    if (!ACTIONABLE.has(role) && label === '' && !node.identifier) continue

    // Clipped to the screen, as the Android agent does: a node partly scrolled or animated out would otherwise
    // carry a frame outside 0–1, and every consumer refuses the whole tree for one such element. A node wholly
    // off the screen is dropped — nothing can tap it.
    const x1 = Math.max(0, (node.frame.x - basis.x) / basis.width)
    const y1 = Math.max(0, (node.frame.y - basis.y) / basis.height)
    const x2 = Math.min(1, (node.frame.x + node.frame.width - basis.x) / basis.width)
    const y2 = Math.min(1, (node.frame.y + node.frame.height - basis.y) / basis.height)
    if (x2 <= x1 || y2 <= y1) continue
    const element: UIElement = {
      role,
      label,
      // The far edge is rounded down, so rounding can never carry x + width past 1 — the consumers compare exactly.
      frame: { x: round4(x1), y: round4(y1), width: floor4(x2 - round4(x1)), height: floor4(y2 - round4(y1)) },
      enabled: true, // debugDescription does not expose enabled; default true (Open Q9)
    }
    if (node.identifier) element.identifier = node.identifier
    if (node.placeholder) element.placeholder = node.placeholder
    element.rawRole = node.type
    // Stated on every input so that a missing value means "unknown" (see `UIElement.secure`).
    if (role === 'input') element.secure = node.type === 'SecureTextField'
    if (node.focused && role === 'input') element.focused = true
    elements.push(element)
  }
  return elements
}
