import { describe, it, expect } from 'vitest'
import { parseUiAutomatorDump } from '../uiTree.js'

const attrs = (over: Record<string, string> = {}): string => {
  const base: Record<string, string> = {
    'index': '0', 'text': '', 'resource-id': '', 'class': 'android.view.View',
    'package': 'com.example.app', 'content-desc': '', 'checkable': 'false',
    'checked': 'false', 'clickable': 'false', 'enabled': 'true',
    'focusable': 'false', 'focused': 'false', 'scrollable': 'false',
    'long-clickable': 'false', 'password': 'false', 'selected': 'false',
    'bounds': '[0,0][0,0]',
  }
  return Object.entries({ ...base, ...over })
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
}

// 1080x2400 root, matching a typical portrait emulator
const wrap = (inner: string): string =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
  `<hierarchy rotation="0">\n` +
  `<node ${attrs({ class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' })}>\n` +
  inner +
  `\n</node>\n</hierarchy>`

describe('parseUiAutomatorDump', () => {
  it('maps a clickable Button to the unified schema with a 0-1 normalized frame', () => {
    const xml = wrap(
      `<node ${attrs({
        class: 'android.widget.Button', text: 'Login',
        'resource-id': 'com.example.app:id/login',
        clickable: 'true', bounds: '[270,1200][810,1350]',
      })} />`,
    )
    const [el] = parseUiAutomatorDump(xml)
    expect(el).toEqual({
      role: 'button',
      label: 'Login',
      identifier: 'com.example.app:id/login',
      frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
      enabled: true,
      rawRole: 'android.widget.Button',
    })
  })

  it('derives screen size from the root node so landscape dumps normalize correctly', () => {
    const xml =
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
      `<hierarchy rotation="1">\n` +
      `<node ${attrs({ class: 'android.widget.FrameLayout', bounds: '[0,0][2400,1080]' })}>\n` +
      `<node ${attrs({ class: 'android.widget.Button', text: 'OK', clickable: 'true', bounds: '[600,270][1800,810]' })} />\n` +
      `</node>\n</hierarchy>`
    const [el] = parseUiAutomatorDump(xml)
    expect(el.frame).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
  })

  it('keeps text-bearing and interactive nodes, drops inert containers and zero-area nodes', () => {
    const xml = wrap(
      [
        `<node ${attrs({ class: 'android.widget.LinearLayout', bounds: '[0,0][1080,2400]' })} />`,
        `<node ${attrs({ class: 'android.widget.TextView', text: 'Welcome', bounds: '[0,100][1080,200]' })} />`,
        `<node ${attrs({ class: 'android.view.View', clickable: 'true', bounds: '[0,300][1080,400]' })} />`,
        `<node ${attrs({ class: 'android.widget.Button', text: 'Ghost', clickable: 'true', bounds: '[500,500][500,600]' })} />`,
      ].join('\n'),
    )
    const els = parseUiAutomatorDump(xml)
    expect(els.map((e) => e.label)).toEqual(['Welcome', ''])
    expect(els[0].role).toBe('text')
    expect(els[1].role).toBe('other')
  })

  it('maps the closed role vocabulary from widget classes', () => {
    const cases: Array<[string, string]> = [
      ['android.widget.EditText', 'input'],
      ['androidx.appcompat.widget.AppCompatEditText', 'input'],
      ['android.widget.CheckBox', 'checkbox'],
      ['android.widget.RadioButton', 'checkbox'],
      ['android.widget.Switch', 'switch'],
      ['android.widget.ToggleButton', 'switch'],
      ['android.widget.SeekBar', 'slider'],
      ['com.google.android.material.tabs.TabLayout$TabView', 'tab'],
      ['android.widget.ImageButton', 'button'],
      ['android.widget.ImageView', 'image'],
      ['androidx.recyclerview.widget.RecyclerView', 'list'],
      ['android.widget.ListView', 'list'],
      ['android.widget.ScrollView', 'list'],
      ['android.widget.TextView', 'text'],
      ['android.view.ViewGroup', 'other'],
    ]
    const xml = wrap(
      cases
        .map(([cls], i) =>
          `<node ${attrs({ class: cls, text: 'x', clickable: 'true', bounds: `[0,${i * 100}][100,${i * 100 + 50}]` })} />`)
        .join('\n'),
    )
    const els = parseUiAutomatorDump(xml)
    expect(els.map((e) => e.role)).toEqual(cases.map(([, role]) => role))
    expect(els.map((e) => e.rawRole)).toEqual(cases.map(([cls]) => cls))
  })

  it('falls back to content-desc when text is empty and omits empty identifiers', () => {
    const xml = wrap(
      `<node ${attrs({
        class: 'android.widget.ImageButton', 'content-desc': 'Open menu',
        clickable: 'true', bounds: '[0,0][108,108]',
      })} />`,
    )
    const [el] = parseUiAutomatorDump(xml)
    expect(el.label).toBe('Open menu')
    expect(el.identifier).toBeUndefined()
  })

  it('decodes XML entities in text and content-desc', () => {
    const xml = wrap(
      `<node ${attrs({
        class: 'android.widget.TextView', text: 'Tom &amp; Jerry &lt;3 &quot;hi&quot;',
        bounds: '[0,0][500,100]',
      })} />`,
    )
    expect(parseUiAutomatorDump(xml)[0].label).toBe('Tom & Jerry <3 "hi"')
  })

  it('reflects enabled="false"', () => {
    const xml = wrap(
      `<node ${attrs({
        class: 'android.widget.Button', text: 'Pay', clickable: 'true',
        enabled: 'false', bounds: '[0,0][500,100]',
      })} />`,
    )
    expect(parseUiAutomatorDump(xml)[0].enabled).toBe(false)
  })

  it('throws on output that is not a uiautomator hierarchy', () => {
    expect(() => parseUiAutomatorDump('ERROR: could not get idle state.')).toThrow()
    expect(() => parseUiAutomatorDump('')).toThrow()
  })
})
