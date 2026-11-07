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

const round = (n: number): number => Math.round(n * 10000) / 10000

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

  it('keeps a node that has an id even when it is neither clickable nor labelled', () => {
    // As a Compose app dumped them (Android 14): a Slider, and the selected item of a navigation bar, which
    // reports `selected` and drops `clickable`.
    const xml = wrap(
      [
        `<node ${attrs({ class: 'android.widget.SeekBar', 'resource-id': 'form.volume', focusable: 'true', bounds: '[27,1089][1053,1205]' })} />`,
        `<node ${attrs({ class: 'android.view.View', 'resource-id': 'tab.form', selected: 'true', focusable: 'true', bounds: '[0,2127][255,2337]' })} />`,
        `<node ${attrs({ class: 'android.widget.LinearLayout', bounds: '[0,0][1080,2400]' })} />`,
        // The window's decor carries ids too, and is left out.
        `<node ${attrs({ class: 'android.widget.FrameLayout', 'resource-id': 'android:id/content', bounds: '[0,0][1080,2337]' })} />`,
        `<node ${attrs({ class: 'android.view.View', 'resource-id': 'android:id/navigationBarBackground', bounds: '[0,2337][1080,2400]' })} />`,
        // A framework id that names a real target is kept.
        `<node ${attrs({ class: 'android.widget.ProgressBar', 'resource-id': 'android:id/progress', bounds: '[500,1000][580,1080]' })} />`,
      ].join('\n'),
    )
    const els = parseUiAutomatorDump(xml)
    expect(els.map((e) => [e.identifier, e.role])).toEqual([
      ['form.volume', 'slider'], ['tab.form', 'other'], ['android:id/progress', 'other'],
    ])
  })

  it('never lets a frame reach past the screen by rounding', () => {
    // Flush with the bottom edge at the bounds an Android 14 emulator's navigation bar had: rounding y and height
    // apart gave y + height = 1.0001 and the whole tree was refused. Any clickable bottom bar reached it.
    const xml = wrap(`<node ${attrs({ class: 'android.widget.Button', text: 'Bottom bar', clickable: 'true', bounds: '[0,2337][1080,2400]' })} />`)
    const [el] = parseUiAutomatorDump(xml)
    expect(el.frame.y + el.frame.height).toBeLessThanOrEqual(1)
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const rows = Array.from({ length: 400 }, () => {
      const x1 = Math.floor(rnd() * 1079), y1 = Math.floor(rnd() * 2399)
      const x2 = x1 + 1 + Math.floor(rnd() * (1080 - x1)), y2 = y1 + 1 + Math.floor(rnd() * (2400 - y1))
      return `<node ${attrs({ class: 'android.widget.Button', text: 'b', clickable: 'true', bounds: `[${x1},${y1}][${x2},${y2}]` })} />`
    })
    for (const e of parseUiAutomatorDump(wrap(rows.join('\n')))) {
      expect(e.frame.x + e.frame.width).toBeLessThanOrEqual(1)
      expect(e.frame.y + e.frame.height).toBeLessThanOrEqual(1)
    }
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

  it('clips partially off-screen bounds into 0-1 and drops fully off-screen nodes', () => {
    const xml = wrap(
      [
        // scrolled half above the top edge → y clipped to 0
        `<node ${attrs({ class: 'android.widget.Button', text: 'Top', clickable: 'true', bounds: '[0,-100][1080,100]' })} />`,
        // extends past the bottom edge → height clipped to the screen
        `<node ${attrs({ class: 'android.widget.Button', text: 'Bottom', clickable: 'true', bounds: '[0,2300][1080,2600]' })} />`,
        // entirely off-screen → dropped
        `<node ${attrs({ class: 'android.widget.Button', text: 'Gone', clickable: 'true', bounds: '[0,2400][1080,2600]' })} />`,
      ].join('\n'),
    )
    const els = parseUiAutomatorDump(xml)
    expect(els.map((e) => e.label)).toEqual(['Top', 'Bottom'])
    // The far edge is rounded down (see "never lets a frame reach past the screen"), so a height that rounds up
    // on its own comes out a step lower: 100/2400 is 0.0417 rounded, 0.0416 as the parser writes it.
    expect(els[0].frame).toEqual({ x: 0, y: 0, width: 1, height: 0.0416 })
    expect(els[1].frame).toEqual({ x: 0, y: round(2300 / 2400), width: 1, height: 0.0417 })
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
describe('secure and focused', () => {
  const field = (over: Record<string, string>) =>
    `<node ${attrs({ class: 'android.widget.EditText', clickable: 'true', bounds: '[0,100][1080,200]', ...over })} />`

  // `secure` is stated on every input so a missing one means "unknown", which a capture treats as secret.
  it('states secure on every input, true only for a password field', () => {
    const els = parseUiAutomatorDump(wrap([
      field({ text: 'Email' }),
      field({ text: '••••', password: 'true' }),
      `<node ${attrs({ class: 'android.widget.Button', text: 'Go', clickable: 'true', bounds: '[0,300][1080,400]' })} />`,
    ].join('\n')))
    expect(els.map((e) => e.secure)).toEqual([false, true, undefined])
    expect('secure' in els[2]!).toBe(false)
  })

  it('keeps a password node that has nothing else to keep it, and marks it secure', () => {
    const els = parseUiAutomatorDump(wrap(
      `<node ${attrs({ class: 'android.view.View', password: 'true', bounds: '[0,100][1080,200]' })} />`,
    ))
    expect(els).toHaveLength(1)
    expect(els[0]).toMatchObject({ role: 'other', secure: true })
  })

  // As `uiautomator dump` printed them on Pixel_6_tapflow (Android 14), Compose sample app, after typing into the
  // password field: masked text, `password` and `focused` on the field only, and no `hint` attribute at all.
  it('reads a measured Compose dump', () => {
    const els = parseUiAutomatorDump(wrap([
      '<node index="0" text="" resource-id="form.email" class="android.widget.EditText" package="dev.tapflow.sample.compose" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[53,538][1027,685]" />',
      '<node index="1" text="••••••••" resource-id="form.password" class="android.widget.EditText" package="dev.tapflow.sample.compose" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[53,727][1027,874]" />',
    ].join('\n')))
    expect(els.map((e) => [e.identifier, e.secure, e.focused ?? null])).toEqual([
      ['form.email', false, null],
      ['form.password', true, true],
    ])
  })

  // A WebView or Compose host reports `focused` beside the field inside it; only the field receives typing.
  it('marks focus on an input only', () => {
    const els = parseUiAutomatorDump(wrap([
      `<node ${attrs({ class: 'android.webkit.WebView', focused: 'true', scrollable: 'true', bounds: '[0,0][1080,2400]' })} />`,
      field({ text: 'Email', focused: 'true' }),
      field({ text: 'Name' }),
    ].join('\n')))
    expect(els.map((e) => [e.role, e.focused ?? null])).toEqual([['other', null], ['input', true], ['input', null]])
  })
})

