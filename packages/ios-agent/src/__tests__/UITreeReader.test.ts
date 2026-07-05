import { describe, it, expect } from 'vitest'
import { PlatformError } from '@tapflowio/agent-core'
import { mapAxNodes, UITreeReader, type AxNode } from '../UITreeReader.js'

const node = (over: Partial<AxNode> = {}): AxNode => ({
  role: 'AXButton',
  label: 'Login',
  enabled: true,
  frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
  ...over,
})

describe('mapAxNodes', () => {
  it('maps an AXButton to the unified schema', () => {
    const [el] = mapAxNodes([node({ identifier: 'login-button' })])
    expect(el).toEqual({
      role: 'button',
      label: 'Login',
      identifier: 'login-button',
      frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
      enabled: true,
      rawRole: 'AXButton',
    })
  })

  it('maps the macOS AX bridge roles to the closed vocabulary', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['AXButton', undefined, 'button'],
      ['AXTextField', 'AXSearchField', 'input'],
      ['AXTextArea', undefined, 'input'],
      ['AXCheckBox', 'AXSwitch', 'switch'],       // UISwitch bridges as AXCheckBox/AXSwitch
      ['AXCheckBox', undefined, 'checkbox'],
      ['AXRadioButton', 'AXTabButton', 'tab'],    // tab bar items
      ['AXStaticText', undefined, 'text'],
      ['AXHeading', undefined, 'text'],
      ['AXGenericElement', undefined, 'text'],
      ['AXImage', undefined, 'image'],
      ['AXSlider', undefined, 'slider'],
      ['AXTable', undefined, 'list'],
      ['AXScrollArea', undefined, 'list'],
      ['AXCell', undefined, 'cell'],
      ['AXUnknownRole', undefined, 'other'],
    ]
    const els = mapAxNodes(cases.map(([role, subrole]) => node({ role, subrole, label: 'x' })))
    expect(els.map((e) => e.role)).toEqual(cases.map(([, , expected]) => expected))
  })

  it('preserves role/subrole in rawRole', () => {
    const [el] = mapAxNodes([node({ role: 'AXCheckBox', subrole: 'AXSwitch' })])
    expect(el.rawRole).toBe('AXCheckBox/AXSwitch')
  })

  it('keeps actionable elements without labels, drops unlabeled text/other', () => {
    const els = mapAxNodes([
      node({ role: 'AXButton', label: '' }),          // actionable → kept
      node({ role: 'AXStaticText', label: '' }),      // unlabeled text → dropped
      node({ role: 'AXGroup', label: '' }),           // unlabeled container → dropped
      node({ role: 'AXStaticText', label: 'Hello' }), // labeled text → kept
    ])
    expect(els.map((e) => [e.role, e.label])).toEqual([['button', ''], ['text', 'Hello']])
  })

  it('drops zero-area frames and rounds to 4 decimals', () => {
    const els = mapAxNodes([
      node({ frame: { x: 0, y: 0, width: 0, height: 0.5 } }),
      node({ frame: { x: 0.269485903, y: 0.064454614, width: 0.920398009, height: 0.050343249 } }),
    ])
    expect(els).toHaveLength(1)
    expect(els[0].frame).toEqual({ x: 0.2695, y: 0.0645, width: 0.9204, height: 0.0503 })
  })

  it('reflects enabled=false', () => {
    const [el] = mapAxNodes([node({ enabled: false })])
    expect(el.enabled).toBe(false)
  })
})

describe('UITreeReader', () => {
  it('parses helper JSON output into unified elements', async () => {
    const reader = new UITreeReader(async () =>
      JSON.stringify({ elements: [node({ identifier: 'ok-btn' })] }))
    const els = await reader.read('iPhone 16 Pro')
    expect(els).toHaveLength(1)
    expect(els[0].identifier).toBe('ok-btn')
  })

  it('maps helper exit code 2 to an Accessibility-permission guidance error', async () => {
    const reader = new UITreeReader(async () => {
      throw Object.assign(new Error('exit 2'), { code: 2, stderr: 'NOT_TRUSTED' })
    })
    await expect(reader.read('iPhone 16 Pro')).rejects.toThrow(/Accessibility permission/)
  })

  it('maps helper exit code 3 to a Simulator-window guidance error', async () => {
    const reader = new UITreeReader(async () => {
      throw Object.assign(new Error('exit 3'), { code: 3, stderr: 'Simulator.app is not running' })
    })
    await expect(reader.read('iPhone 16 Pro')).rejects.toThrow(/Simulator.app must be running/)
  })

  it('throws PlatformError on malformed helper output (never a silent empty tree)', async () => {
    const reader = new UITreeReader(async () => 'not json')
    await expect(reader.read('iPhone 16 Pro')).rejects.toThrow(PlatformError)
  })
})
