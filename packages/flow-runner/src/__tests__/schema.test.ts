import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { keyModifierBits, parseFlow } from '../schema.js'

describe('parseFlow', () => {
  it('parses the full step vocabulary', () => {
    const flow = parseFlow(`
name: Login smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - tapOn: "로그인"
  - tapOn:
      id: com.example.app:id/email
  - tapOn:
      label: "로그인"
      timeout: 20
  - inputText: "user@example.com"
  - pressKey: Enter
  - swipe:
      from: [0.5, 0.8]
      to: [0.5, 0.2]
  - scroll
  - scroll: down
  - openUrl: "myapp://orders/1"
  - assertVisible: "주문 목록"
  - assertNotVisible:
      label: "오류"
      timeout: 3
`, 'login.yaml')

    expect(flow.name).toBe('Login smoke')
    expect(flow.appId).toBe('com.example.app')
    expect(flow.steps).toHaveLength(13)
    expect(flow.steps[0]).toEqual({ type: 'clearState' })
    expect(flow.steps[1]).toEqual({ type: 'launchApp' })
    expect(flow.steps[2]).toEqual({ type: 'tapOn', selector: { text: '로그인' } })
    expect(flow.steps[3]).toEqual({ type: 'tapOn', selector: { id: 'com.example.app:id/email' } })
    expect(flow.steps[4]).toEqual({ type: 'tapOn', selector: { label: '로그인', timeoutMs: 20_000 } })
    expect(flow.steps[5]).toEqual({ type: 'inputText', text: 'user@example.com' })
    expect(flow.steps[6]).toEqual({ type: 'pressKey', code: 'Enter' })
    expect(flow.steps[7]).toEqual({ type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 300 })
    expect(flow.steps[8]).toEqual({ type: 'scroll', direction: 'down' })
    expect(flow.steps[9]).toEqual({ type: 'scroll', direction: 'down' })
    expect(flow.steps[10]).toEqual({ type: 'openUrl', url: 'myapp://orders/1' })
    expect(flow.steps[11]).toEqual({ type: 'assertVisible', selector: { text: '주문 목록' } })
    expect(flow.steps[12]).toEqual({ type: 'assertNotVisible', selector: { label: '오류', timeoutMs: 3_000 } })
  })

  it('defaults name to the file name when omitted', () => {
    const flow = parseFlow('steps:\n  - launchApp\n', '.tapflow/flows/checkout.yaml')
    expect(flow.name).toBe('checkout')
    expect(parseFlow('steps:\n  - launchApp\n', 'login.YML').name).toBe('login')
    expect(parseFlow('steps:\n  - launchApp\n', 'C:\\app\\flows\\pay.yaml').name).toBe('pay')
  })

  it('rejects a flow without steps', () => {
    expect(() => parseFlow('name: empty\n', 'x.yaml')).toThrow(/steps/)
  })

  it('rejects an unknown step keyword with the step index', () => {
    expect(() => parseFlow(`
steps:
  - launchApp
  - tapp: "로그인"
`, 'x.yaml')).toThrow(/steps\[1\]/)
  })

  it('rejects a selector with neither id, label, nor role', () => {
    expect(() => parseFlow(`
steps:
  - tapOn:
      timeout: 5
`, 'x.yaml')).toThrow(/id.*label.*role/)
  })

  it('parses role and index disambiguators', () => {
    const flow = parseFlow(`
steps:
  - tapOn:
      label: "New Orders"
      role: button
  - tapOn:
      role: cell
      index: 2
`, 'x.yaml')
    expect(flow.steps[0]).toEqual({ type: 'tapOn', selector: { label: 'New Orders', role: 'button' } })
    expect(flow.steps[1]).toEqual({ type: 'tapOn', selector: { role: 'cell', index: 2 } })
  })

  it('rejects a negative or non-integer index', () => {
    expect(() => parseFlow('steps:\n  - tapOn:\n      role: cell\n      index: -1\n', 'x.yaml')).toThrow(/index/)
    expect(() => parseFlow('steps:\n  - tapOn:\n      role: cell\n      index: 1.5\n', 'x.yaml')).toThrow(/index/)
  })

  it('rejects non-finite and timer-overflow selector timeouts', () => {
    expect(() => parseFlow('steps:\n  - tapOn:\n      label: OK\n      timeout: .inf\n', 'x.yaml')).toThrow(/timeout/)
    expect(() => parseFlow('steps:\n  - tapOn:\n      label: OK\n      timeout: 2147483.648\n', 'x.yaml')).toThrow(/timeout/)
  })

  it('rejects index alone with no id/label/role', () => {
    expect(() => parseFlow('steps:\n  - tapOn:\n      index: 0\n', 'x.yaml')).toThrow(/id.*label.*role/)
  })

  it('rejects clearState when no appId is available', () => {
    expect(() => parseFlow(`
steps:
  - clearState
`, 'x.yaml')).toThrow(/appId/)
  })

  it('allows clearState with an inline bundle id instead of appId', () => {
    const flow = parseFlow(`
steps:
  - clearState: com.other.app
`, 'x.yaml')
    expect(flow.steps[0]).toEqual({ type: 'clearState', appId: 'com.other.app' })
  })

  it('rejects non-finite swipe coordinates (.nan)', () => {
    expect(() => parseFlow(`
steps:
  - swipe:
      from: [.nan, 0.5]
      to: [0.5, 0.2]
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects swipe coordinates outside 0-1', () => {
    expect(() => parseFlow(`
steps:
  - swipe:
      from: [0.5, 1.8]
      to: [0.5, 0.2]
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects invalid scroll directions', () => {
    expect(() => parseFlow(`
steps:
  - scroll: sideways
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects non-YAML and non-object documents', () => {
    expect(() => parseFlow('just a string', 'x.yaml')).toThrow()
    expect(() => parseFlow('- a\n- b\n', 'x.yaml')).toThrow()
  })

  it('keeps fractional swipe durations (0.23.0 compatibility)', () => {
    const flow = parseFlow(`
steps:
  - swipe:
      from: [0.5, 0.8]
      to: [0.5, 0.2]
      durationMs: 250.5
`, 'x.yaml')
    expect(flow.steps[0]).toEqual({ type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 250.5 })
  })

  it('rejects non-positive and over-limit swipe durations', () => {
    expect(() => parseFlow('steps:\n  - swipe:\n      from: [0.5, 0.8]\n      to: [0.5, 0.2]\n      durationMs: 0\n', 'x.yaml')).toThrow(/durationMs/)
    expect(() => parseFlow('steps:\n  - swipe:\n      from: [0.5, 0.8]\n      to: [0.5, 0.2]\n      durationMs: 2147483648\n', 'x.yaml')).toThrow(/durationMs/)
  })

  it('rejects timeouts that round to 0ms', () => {
    expect(() => parseFlow('steps:\n  - tapOn:\n      label: OK\n      timeout: 0.0004\n', 'x.yaml')).toThrow(/at least 1ms/)
  })

  describe('tags', () => {
    it('reads a list of tags, trimmed', () => {
      expect(parseFlow('tags: [smoke, " login "]\nsteps:\n  - launchApp\n', 'x.yaml').tags).toEqual(['smoke', 'login'])
    })

    it('leaves tags out when the flow has none', () => {
      expect(parseFlow('steps:\n  - launchApp\n', 'x.yaml')).not.toHaveProperty('tags')
    })

    it.each([
      ['a string', 'tags: smoke'],
      ['an empty tag', 'tags: [smoke, ""]'],
      ['a blank tag', 'tags: ["  "]'],
      ['a number', 'tags: [1]'],
      ['a comma', 'tags: ["smoke,login"]'],
    ])('rejects %s', (_, line) => {
      expect(() => parseFlow(`${line}\nsteps:\n  - launchApp\n`, 'x.yaml')).toThrow(/"tags" must be a list of non-empty strings without commas/)
    })

    it('agrees with the JSON schema on what a tag may be', () => {
      const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
      const item = schema.properties.tags.items
      const pattern = new RegExp(item.pattern)
      for (const ok of ['smoke', ' login ', 'a b']) expect(pattern.test(ok)).toBe(true)
      for (const bad of ['', '  ', 'a,b']) expect(pattern.test(bad) && bad.length >= item.minLength).toBe(false)
    })
  })

  // #1047. The rules themselves are tested in protocol; this is that the flow loader applies them, at load time.
  describe('launchApp with options', () => {
    it('carries arguments and env', () => {
      const flow = parseFlow('steps:\n  - launchApp:\n      arguments:\n        FIRDebugEnabled: true\n        port: "8080"\n        AppleLanguages: [en]\n      env:\n        API_HOST: s.example.com\n', 'x.yaml')
      expect(flow.steps[0]).toEqual({ type: 'launchApp', options: { arguments: { FIRDebugEnabled: true, port: '8080', AppleLanguages: ['en'] }, env: { API_HOST: 's.example.com' } } })
    })

    it('reads an empty mapping or a null value as the bare step', () => {
      expect(parseFlow('steps:\n  - launchApp:\n', 'x.yaml').steps[0]).toEqual({ type: 'launchApp' })
      expect(parseFlow('steps:\n  - launchApp: { arguments: {} }\n', 'x.yaml').steps[0]).toEqual({ type: 'launchApp' })
    })

    it.each([
      ['a fraction', 'launchApp: { arguments: { r: 1.5 } }', /steps\[0\]: launchApp arguments\.r: .*quote 1\.5/],
      ['a dashed key', 'launchApp: { arguments: { -FIRDebugEnabled: true } }', /without the leading "-"/],
      ['a reserved env name', 'launchApp: { env: { DYLD_INSERT_LIBRARIES: x } }', /reserved/],
      ['an unknown key', 'launchApp: { args: { a: 1 } }', /unknown launchApp keys: args/],
      ['a string', 'launchApp: now', /takes \{ arguments, env \}/],
    ])('refuses %s when the flow loads', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })

    it('agrees with the JSON schema on key forms', () => {
      const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
      const step = schema.definitions.step.oneOf.find((s: { properties?: Record<string, unknown> }) => s.properties?.launchApp)
      const opts = step.properties.launchApp.oneOf[1].properties
      const argKey = new RegExp(opts.arguments.propertyNames.pattern)
      const envName = new RegExp(opts.env.propertyNames.pattern)
      for (const key of ['FIRDebugEnabled', 'com.apple.CoreData.SQLDebug', 'a-b']) {
        expect(argKey.test(key)).toBe(true)
        expect(() => parseFlow(`steps:\n  - launchApp: { arguments: { ${key}: "1" } }\n`, 'x.yaml')).not.toThrow()
      }
      for (const key of ['-x', '_x', 'a b']) {
        expect(argKey.test(key)).toBe(false)
        expect(() => parseFlow(`steps:\n  - launchApp: { arguments: { "${key}": "1" } }\n`, 'x.yaml')).toThrow()
      }
      for (const name of ['API_HOST', '_X']) expect(envName.test(name)).toBe(true)
      for (const name of ['1X', 'A-B']) expect(envName.test(name)).toBe(false)
    })
  })

  describe('pressButton', () => {
    it('takes any non-empty name: whether the device has it is decided against the device, not here', () => {
      expect(parseFlow('steps:\n  - pressButton: home\n', 'x.yaml').steps[0]).toEqual({ type: 'pressButton', name: 'home' })
      expect(parseFlow('steps:\n  - pressButton: action\n', 'x.yaml').steps[0]).toEqual({ type: 'pressButton', name: 'action' })
    })

    it.each([['a number', 'pressButton: 3'], ['an empty name', 'pressButton: ""'], ['a mapping', 'pressButton: { name: home }']])(
      'refuses %s', (_, step) => {
        expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(/steps\[0\]: "pressButton" must be a button name/)
      },
    )
  })

  describe('longPressOn', () => {
    it('holds a bare selector for the default time, matched exactly as tapOn matches it', () => {
      expect(parseFlow('steps:\n  - longPressOn: "Save"\n', 'x.yaml').steps[0])
        .toEqual({ type: 'longPressOn', selector: { text: 'Save' }, durationMs: 1000 })
      expect(parseFlow('steps:\n  - longPressOn: { id: save }\n', 'x.yaml').steps[0])
        .toEqual({ type: 'longPressOn', selector: { id: 'save' }, durationMs: 1000 })
    })

    // `{ label, durationMs }` would have changed how "Save" matches (label only, never the identifier) just to change
    // the time, and put a seconds field and a milliseconds field in one mapping.
    it('takes a duration only around the selector, which keeps the bare string\'s matching', () => {
      expect(parseFlow('steps:\n  - longPressOn: { on: "Save", durationMs: 1500 }\n', 'x.yaml').steps[0])
        .toEqual({ type: 'longPressOn', selector: { text: 'Save' }, durationMs: 1500 })
      expect(parseFlow('steps:\n  - longPressOn: { on: { label: Save, timeout: 3 } }\n', 'x.yaml').steps[0])
        .toEqual({ type: 'longPressOn', selector: { label: 'Save', timeoutMs: 3000 }, durationMs: 1000 })
    })

    it.each([
      ['a duration on the selector itself', 'longPressOn: { label: Save, durationMs: 1500 }', /put the selector under "on"/],
      ['a negative duration', 'longPressOn: { on: Save, durationMs: -1 }', /"durationMs" must be a positive number no greater than 60000ms/],
      ['a hold past a minute', 'longPressOn: { on: Save, durationMs: 61000 }', /no greater than 60000ms/],
      ['an unknown key beside "on"', 'longPressOn: { on: Save, hold: 2 }', /unknown longPressOn keys: hold/],
      ['an empty selector', 'longPressOn: ""', /selector must not be empty/],
    ])('refuses %s', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })
  })

  describe('pinch', () => {
    it('pinches around an element or a point, by a scale', () => {
      expect(parseFlow('steps:\n  - pinch: { on: Map, scale: 2 }\n', 'x.yaml').steps[0])
        .toEqual({ type: 'pinch', on: { text: 'Map' }, scale: 2, durationMs: 500 })
      expect(parseFlow('steps:\n  - pinch: { on: [0.5, 0.4], scale: 0.5, durationMs: 800 }\n', 'x.yaml').steps[0])
        .toEqual({ type: 'pinch', on: [0.5, 0.4], scale: 0.5, durationMs: 800 })
    })

    it.each([
      ['no scale', 'pinch: { on: Map }', /"scale" must be a number from 0.1 to 10, other than 1/],
      ['a scale of 1', 'pinch: { on: Map, scale: 1 }', /other than 1/],
      ['a zero scale', 'pinch: { on: Map, scale: 0 }', /from 0.1 to 10/],
      ['a scale past 10', 'pinch: { on: Map, scale: 11 }', /from 0.1 to 10/],
      ['no target', 'pinch: { scale: 2 }', /"on" must be a selector or \[x, y\]/],
      ['a point off the screen', 'pinch: { on: [1.2, 0.5], scale: 2 }', /"on" must be \[x, y\] with normalized 0-1 coordinates/],
      ['an unknown key', 'pinch: { on: Map, scale: 2, angle: 30 }', /unknown pinch keys: angle/],
      ['a bare string', 'pinch: Map', /"pinch" must be \{ on, scale, durationMs\? \}/],
    ])('refuses %s', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })
  })

  describe('scroll until', () => {
    it('takes a selector and defaults the direction to down; the string forms are unchanged', () => {
      const steps = parseFlow('steps:\n  - scroll: { until: "Row 16" }\n  - scroll: { direction: up, until: { id: row.16, timeout: 5 } }\n  - scroll\n  - scroll: left\n', 'x.yaml').steps
      expect(steps).toEqual([
        { type: 'scroll', direction: 'down', until: { text: 'Row 16' } },
        { type: 'scroll', direction: 'up', until: { id: 'row.16', timeoutMs: 5000 } },
        { type: 'scroll', direction: 'down' },
        { type: 'scroll', direction: 'left' },
      ])
    })

    it.each([
      ['no until', 'scroll: { direction: up }', /needs "until"/],
      ['an empty mapping', 'scroll: {}', /needs "until"/],
      ['a bad direction', 'scroll: { direction: sideways, until: x }', /direction must be one of/],
      ['an unknown key', 'scroll: { until: x, times: 3 }', /unknown scroll keys: times/],
      ['an empty selector', 'scroll: { until: "" }', /selector must not be empty/],
    ])('refuses %s', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })
  })

  describe('pressKey with modifiers', () => {
    it('takes a code and the modifiers to hold; the string form is unchanged', () => {
      const steps = parseFlow('steps:\n  - pressKey: { code: KeyA, modifiers: [shift, meta] }\n  - pressKey: Enter\n', 'x.yaml').steps
      expect(steps).toEqual([{ type: 'pressKey', code: 'KeyA', modifiers: ['shift', 'meta'] }, { type: 'pressKey', code: 'Enter' }])
    })

    it.each([
      ['no modifiers', 'pressKey: { code: KeyA }', /"modifiers" must be a list/],
      ['an empty list', 'pressKey: { code: KeyA, modifiers: [] }', /"modifiers" must be a list/],
      ['an unknown modifier', 'pressKey: { code: KeyA, modifiers: [hyper] }', /distinct shift, ctrl, alt, meta/],
      ['a repeated modifier', 'pressKey: { code: KeyA, modifiers: [shift, shift] }', /distinct/],
      ['no code', 'pressKey: { modifiers: [shift] }', /"code" must be a key code/],
      ['an unknown key', 'pressKey: { code: KeyA, modifiers: [shift], hold: 1 }', /unknown pressKey keys: hold/],
    ])('refuses %s', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })

    it('turns the names into the HID bitmap the agents read', () => {
      expect(keyModifierBits()).toBe(0)
      expect([keyModifierBits(['ctrl']), keyModifierBits(['shift']), keyModifierBits(['alt']), keyModifierBits(['meta'])]).toEqual([1, 2, 4, 8])
      expect(keyModifierBits(['shift', 'ctrl', 'alt', 'meta'])).toBe(15)
    })
  })

  describe('setOrientation and setPosture', () => {
    it('takes a target, never a toggle', () => {
      expect(parseFlow('steps:\n  - setOrientation: landscape\n', 'x.yaml').steps[0]).toEqual({ type: 'setOrientation', orientation: 'landscape' })
      expect(parseFlow('steps:\n  - setPosture: folded\n', 'x.yaml').steps[0]).toEqual({ type: 'setPosture', posture: 'folded' })
    })

    it.each([
      ['a toggle', 'setOrientation: rotate', /"setOrientation" must be portrait or landscape/],
      ['a platform posture id', 'setPosture: HALF_OPENED', /"setPosture" must be folded or unfolded/],
      ['a mapping', 'setOrientation: { to: landscape }', /must be portrait or landscape/],
    ])('refuses %s', (_, step, message) => {
      expect(() => parseFlow(`steps:\n  - ${step}\n`, 'x.yaml')).toThrow(message)
    })
  })

  it('agrees with the JSON schema on the input steps\' limits', () => {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
    const steps = schema.definitions.step.oneOf.find((s: { properties?: Record<string, unknown> }) => s.properties?.pinch).properties
    expect(steps.pressButton.minLength).toBe(1)
    const hold = steps.longPressOn.oneOf[1].properties.durationMs
    expect([hold.exclusiveMinimum, hold.maximum, hold.default]).toEqual([0, 60000, 1000])
    const pinch = steps.pinch.properties
    expect([pinch.scale.minimum, pinch.scale.maximum, pinch.durationMs.maximum, pinch.durationMs.default]).toEqual([0.1, 10, 60000, 500])
  })

  it('keeps the JSON schema timeout floor consistent with the parser', () => {
    // The parser rejects timeouts that round to 0ms, i.e. anything below
    // 0.0005s — so the shipped JSON schema must reject them too, or
    // schema-validated flows fail at runtime.
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
    const timeout = schema.definitions.selector.oneOf[1].properties.timeout
    expect(timeout.minimum).toBe(0.0005)
    // The boundary itself parses: 0.0005s rounds to exactly 1ms.
    const flow = parseFlow('steps:\n  - tapOn:\n      label: OK\n      timeout: 0.0005\n', 'x.yaml')
    expect(flow.steps[0]).toEqual({ type: 'tapOn', selector: { label: 'OK', timeoutMs: 1 } })
  })
})

// Flow Capture (#1125): a tap whose point the tree names nothing at, and a typed password, need a way into a flow.
// #1125: what a touch is expected to bring, beside the action in the step's own mapping.
describe('expect', () => {
  const parse = (step: string) => parseFlow(`steps:\n${step}`, 'f.yaml')

  it('rides beside a touch step', () => {
    const flow = parse('  - tapOn: "Save"\n    expect:\n      appear: [{ text: Saved }]\n      gone: [{ id: save, checked: true }]\n')
    expect(flow.steps[0]).toEqual({ type: 'tapOn', selector: { text: 'Save' }, expect: { appear: [{ text: 'Saved' }], gone: [{ id: 'save', checked: true }] } })
    expect(parse('  - longPressOn: [0.2, 0.3]\n    expect: { appear: [{ id: menu }] }\n').steps[0]).toMatchObject({ type: 'longPressPoint', expect: { appear: [{ id: 'menu' }] } })
  })

  it('goes on no other step', () => {
    expect(() => parse('  - swipe: { from: [0.5, 0.8], to: [0.5, 0.2] }\n    expect: { appear: [{ id: x }] }\n')).toThrow(/"expect" goes only on a touch step/)
  })

  it('refuses an anchor that names nothing, a key it does not know, and an empty list', () => {
    expect(() => parse('  - tapOn: "Save"\n    expect: { appear: [{ role: button }] }\n')).toThrow(/needs an id or a text/)
    expect(() => parse('  - tapOn: "Save"\n    expect: { appear: [{ text: Saved, frame: 1 }] }\n')).toThrow(/unknown keys: frame/)
    expect(() => parse('  - tapOn: "Save"\n    expect: { appear: [] }\n')).toThrow(/non-empty list/)
    expect(() => parse('  - tapOn: "Save"\n    expect: {}\n')).toThrow(/needs appear or gone/)
  })

  it('is described to editors with the keys the loader takes', () => {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
    expect(Object.keys(schema.definitions.expectAnchor.properties).sort()).toEqual(['checked', 'id', 'role', 'selected', 'text'])
    expect(Object.keys(schema.definitions.expect.properties).sort()).toEqual(['appear', 'gone'])
    const step = schema.definitions.step.oneOf.find((s: { properties?: Record<string, unknown> }) => s.properties?.tapOn)
    expect(step.properties.expect).toEqual({ $ref: '#/definitions/expect' })
    expect(step.then.anyOf).toEqual([{ required: ['tapOn'] }, { required: ['longPressOn'] }])
  })

  it('leaves a step with two actions refused as before', () => {
    expect(() => parse('  - tapOn: "Save"\n    swipe: up\n')).toThrow(/exactly one key/)
  })
})

// #1125: the screen a flow's points were made on.
describe('viewport', () => {
  it('is read as given, and refused when it is not a size', () => {
    expect(parseFlow('viewport: { width: 402, height: 874 }\nsteps: [launchApp]\n', 'f.yaml').viewport).toEqual({ width: 402, height: 874 })
    expect(() => parseFlow('viewport: { width: 0, height: 874 }\nsteps: [launchApp]\n', 'f.yaml')).toThrow(/viewport.width" must be a positive number/)
    expect(() => parseFlow('viewport: { width: 1, height: 2, scale: 3 }\nsteps: [launchApp]\n', 'f.yaml')).toThrow(/unknown viewport keys: scale/)
  })
})

describe('points and secrets', () => {
  const step = (yaml: string) => parseFlow(`steps:\n  - ${yaml}\n`, 'x.yaml').steps[0]

  it('reads an array under tapOn and longPressOn as a point, and leaves selectors as they were', () => {
    expect(step('tapOn: [0.4, 0.6]')).toEqual({ type: 'tapPoint', at: [0.4, 0.6] })
    expect(step('longPressOn: [0.4, 0.6]')).toEqual({ type: 'longPressPoint', at: [0.4, 0.6], durationMs: 1000 })
    expect(step('longPressOn: { on: [0.4, 0.6], durationMs: 800 }')).toEqual({ type: 'longPressPoint', at: [0.4, 0.6], durationMs: 800 })
    expect(step('tapOn: "0.4"')).toEqual({ type: 'tapOn', selector: { text: '0.4' } })
    expect(step('longPressOn: { on: Save, durationMs: 800 }')).toEqual({ type: 'longPressOn', selector: { text: 'Save' }, durationMs: 800 })
  })

  it.each([
    ['tapOn: [0.4]'], ['tapOn: [1.2, 0.5]'], ['tapOn: [.nan, 0.5]'], ['longPressOn: [0.4, 0.6, 0.1]'],
    ['longPressOn: { on: [0.4, -0.1] }'], ['longPressOn: { on: [0.4, 0.6], durationMs: 60001 }'],
  ])('refuses the point in %s', (yaml) => {
    expect(() => step(yaml)).toThrow(/\[x, y\]|durationMs/)
  })

  it('reads inputText { secret } as a named secret, never as text', () => {
    expect(step('inputText: { secret: PASSWORD }')).toEqual({ type: 'inputSecret', name: 'PASSWORD' })
    expect(step('inputText: { secret: _pin2 }')).toEqual({ type: 'inputSecret', name: '_pin2' })
    expect(step('inputText: "PASSWORD"')).toEqual({ type: 'inputText', text: 'PASSWORD' })
  })

  it('keeps the JSON schema\'s inputText forms the ones the parser takes', () => {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
    const forms = (schema as { definitions: Record<string, unknown> }) && JSON.stringify(schema).match(/"inputText":\{[^]*?"oneOf":(\[[^]*?\])\s*\}\s*,\s*"pressKey"/)
    expect(forms).not.toBeNull()
    const oneOf = JSON.parse(forms![1]!) as Array<{ type: string; required?: string[]; properties?: Record<string, unknown> }>
    expect(oneOf.map((f) => f.type === 'object' ? `${f.required!.join()}:${Object.keys(f.properties!).sort().join()}` : f.type))
      .toEqual(['string', 'text:replace,text', 'secret:replace,secret'])
    expect(step('inputText: { secret: PASSWORD, replace: true }')).toEqual({ type: 'inputSecret', name: 'PASSWORD', replace: true })
  })

  it('reads inputText { text, replace } as replacing what the field holds (#1135)', () => {
    expect(step('inputText: { text: "a@b.com", replace: true }')).toEqual({ type: 'inputText', text: 'a@b.com', replace: true })
    expect(step('inputText: { text: "안녕", replace: false }')).toEqual({ type: 'inputText', text: '안녕' })
    expect(step('inputText: { text: "x" }')).toEqual({ type: 'inputText', text: 'x' })
  })

  it.each([
    ['inputText: { secret: 2FA }', /"secret" must be a name/],
    ['inputText: { secret: "MY-PASS" }', /"secret" must be a name/],
    ['inputText: { secret: "" }', /"secret" must be a name/],
    ['inputText: { env: PASSWORD }', /unknown inputText keys: env/],
    ['inputText: { secret: A, text: b }', /unknown inputText keys: text/],
    ['inputText: { text: 1 }', /"inputText.text" must be a string/],
    ['inputText: { text: a, replace: "yes" }', /"inputText.replace" must be true or false/],
    ['inputText: { text: a, append: true }', /unknown inputText keys: append/],
  ])('refuses %s', (yaml, error) => {
    expect(() => step(yaml)).toThrow(error)
  })
})

// 1b-3c: `exact` on a selector, for a value a flow checks.
describe('parseFlow — exact', () => {
  const flow = (sel: string) => `name: f\nappId: a\nsteps:\n  - assertVisible: ${sel}\n`
  it('reads it beside a label', () => {
    expect(parseFlow(flow('{ label: "Total $12", exact: true }'), 'f.yaml').steps[0]).toEqual({ type: 'assertVisible', selector: { label: 'Total $12', exact: true } })
  })
  it('refuses it without a label, or as anything but true', () => {
    expect(() => parseFlow(flow('{ id: "total", exact: true }'), 'f.yaml')).toThrow(/"exact" needs a "label"/)
    expect(() => parseFlow(flow('{ label: "x", exact: false }'), 'f.yaml')).toThrow(/"exact" must be true/)
  })
  // CodeRabbit on #1158: the JSON schema an editor validates with refuses what the parser refuses.
  it('is refused without a label by the JSON schema too', () => {
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'tapflow-flow.schema.json'), 'utf8'))
    expect(schema.definitions.selector.oneOf[1].dependencies).toEqual({ exact: ['label'] })
  })
})

