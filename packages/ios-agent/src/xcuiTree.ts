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
// Fields after the address appear in order: [pid], [frame], [identifier], [label], [value].

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

interface RawNode {
  type: string
  frame?: { x: number; y: number; width: number; height: number }
  identifier?: string
  label?: string
  value?: string
}

const FRAME_RE = /\{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}/
// Terminate quoted fields on the next field boundary, so a quote inside the
// value (e.g. label: 'Don't') does not truncate the match.
const IDENTIFIER_RE = /, identifier: '(.*?)'(?=, label: |, value: |$)/
const LABEL_RE = /, label: '(.*?)'(?=, value: |$)/
const VALUE_RE = /, value: (.*)$/

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
  const vm = VALUE_RE.exec(line)
  if (vm) node.value = vm[1]
  return node
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

    const element: UIElement = {
      role,
      label,
      frame: {
        x: round4(node.frame.x / basis.width),
        y: round4(node.frame.y / basis.height),
        width: round4(node.frame.width / basis.width),
        height: round4(node.frame.height / basis.height),
      },
      enabled: true, // debugDescription does not expose enabled; default true (Open Q9)
    }
    if (node.identifier) element.identifier = node.identifier
    element.rawRole = node.type
    elements.push(element)
  }
  return elements
}
