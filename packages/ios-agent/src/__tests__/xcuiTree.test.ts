import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseTreeText } from '../xcuiTree'

// Real XCUIApplication.debugDescription captured from the resident runner
// (io.cloudgrey.the-app main screen). This is the format-regression fixture
// (Open Q9): a debugDescription format change in a future Xcode fails here.
const FIXTURE = readFileSync(join(import.meta.dirname, '..', '__fixtures__', 'the-app-tree.txt'), 'utf-8')

describe('parseTreeText', () => {
  const els = parseTreeText(FIXTURE)

  it('parses the tree into unified elements', () => {
    expect(els.length).toBeGreaterThan(0)
  })

  it('normalizes every frame into 0-1 space (basis = Window frame)', () => {
    for (const e of els) {
      expect(e.frame.x).toBeGreaterThanOrEqual(-0.01)
      expect(e.frame.width).toBeLessThanOrEqual(1.01)
      expect(e.frame.height).toBeLessThanOrEqual(1.01)
    }
  })

  it('extracts identifier-bearing rows (Echo Box) with normalized frame', () => {
    const echo = els.find((e) => e.identifier === 'Echo Box')
    expect(echo).toBeDefined()
    // {{0.0, 131.3}, {402.0, 66.4}} on a 402×874 window
    expect(echo!.frame.x).toBeCloseTo(0, 3)
    expect(echo!.frame.width).toBeCloseTo(1, 2)
    expect(echo!.label).toBe('Echo Box')
  })

  it('maps StaticText to role text and keeps its label', () => {
    const title = els.find((e) => e.role === 'text' && e.label === 'The App')
    expect(title).toBeDefined()
  })

  it('parses label even when a value field follows (scroll bar row)', () => {
    const bar = els.find((e) => e.label === 'Vertical scroll bar, 1 page')
    expect(bar).toBeDefined()
  })

  it('preserves the XCUITest type as rawRole', () => {
    const echo = els.find((e) => e.identifier === 'Echo Box')
    expect(echo!.rawRole).toBe('Other')
  })

  it('defaults enabled to true (debugDescription has no enabled field)', () => {
    expect(els.every((e) => e.enabled === true)).toBe(true)
  })
})

describe('parseTreeText field-boundary edge cases', () => {
  it('does not truncate a label containing an apostrophe', () => {
    const text = [
      'Element subtree:',
      " →Application, 0x1, pid: 1, label: 'App'",
      "    Window (Main), 0x2, {{0.0, 0.0}, {100.0, 200.0}}",
      "      Button, 0x3, {{0.0, 0.0}, {50.0, 20.0}}, label: 'Don't tap', value: on",
    ].join('\n')
    const els = parseTreeText(text)
    const btn = els.find((e) => e.role === 'button')
    expect(btn?.label).toBe("Don't tap")
  })

  it('returns empty when there is no usable frame basis', () => {
    expect(parseTreeText('Element subtree:\n →Application, 0x1, pid: 1, label: \'App\'')).toEqual([])
  })
})
