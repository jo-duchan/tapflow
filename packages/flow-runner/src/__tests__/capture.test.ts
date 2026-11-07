import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UIElement } from '@tapflowio/agent-core'
import type { CaptureEntry, CapturedMessage } from '@tapflowio/protocol/capture'
import {
  segment, defaultRange, rangeWarnings, matchStep, toFlowSteps, flowSteps, flowToYaml, rawStepLabel, capturedStepLabel,
  type MatchContext, type RawStep,
} from '../capture/index.js'
import { parseFlow } from '../schema.js'

// A recording as the relay keeps it: messages stamped with its clock, acks after the inputs they answer.
class Rec {
  entries: CaptureEntry[] = []
  t = 1000
  private n = 0
  at(ms: number): this { this.t = ms; return this }
  wait(ms: number): this { this.t += ms; return this }
  msg(msg: CapturedMessage, ok?: boolean): this {
    this.entries.push({ at: this.t, kind: 'input', msg })
    const id = 'requestId' in msg ? msg.requestId : undefined
    if (ok !== undefined && id) this.entries.push({ at: this.t + 5, kind: 'ack', requestId: id, ok })
    return this
  }
  id(): string { return `r${++this.n}` }
  chrome(chrome: unknown): this { this.entries.push({ at: this.t, kind: 'chrome', chrome }); return this }
  touch(path: Array<[number, number]>, opts: { holdMs?: number; stepMs?: number; ok?: boolean; space?: 'frame' } = {}): this {
    const [first, ...moves] = path
    const space = opts.space ? { space: opts.space } : {}
    this.msg({ type: 'input:touch:start', sessionId: 's', payload: { x: first![0], y: first![1], ...space } })
    this.wait(opts.holdMs ?? 0)
    for (const [x, y] of moves) this.wait(opts.stepMs ?? 16).msg({ type: 'input:touch:move', sessionId: 's', payload: { x, y, ...space } })
    return this.wait(opts.stepMs ?? 60).msg({ type: 'input:touch:end', sessionId: 's', requestId: this.id() }, opts.ok ?? true)
  }
  key(code: string, modifiers = 0, ok = true): this {
    return this.wait(120).msg({ type: 'input:key', sessionId: 's', requestId: this.id(), payload: { code, modifiers } }, ok)
  }
  type(text: string): this {
    for (const ch of text) {
      if (/[a-z]/.test(ch)) this.key(`Key${ch.toUpperCase()}`)
      else if (/[A-Z]/.test(ch)) this.key(`Key${ch}`, 0x02)
      else if (/[0-9]/.test(ch)) this.key(`Digit${ch}`)
      else if (ch === ' ') this.key('Space')
      else if (ch === '@') this.key('Digit2', 0x02)
      else if (ch === '.') this.key('Period')
      else throw new Error(`no key for ${ch}`)
    }
    return this
  }
  launch(buildId = 7): this { return this.wait(100).msg({ type: 'app:launch', sessionId: 's', requestId: this.id(), buildId }, true) }
  install(buildId = 7): this { return this.wait(100).msg({ type: 'app:install', sessionId: 's', requestId: this.id(), buildId }, true) }
  steps(): RawStep[] { return segment(this.entries) }
}

const el = (over: Partial<UIElement>): UIElement => ({
  role: 'button', label: '', enabled: true, frame: { x: 0, y: 0, width: 1, height: 1 }, ...over,
})
const SCREEN = el({ role: 'other', label: '' })
const ctxOf = (tree: UIElement[], extra: Partial<MatchContext> = {}): MatchContext => ({ tree: [SCREEN, ...tree], ...extra })

describe('segment: a recording as the actions a person took', () => {
  it('reads a quick touch as a tap, and a held one as a long press with its length', () => {
    const steps = new Rec().touch([[0.4, 0.6]], { stepMs: 80 }).wait(500).touch([[0.4, 0.6]], { stepMs: 900 }).steps()
    expect(steps.map((s) => s.kind)).toEqual(['tap', 'longPress'])
    expect(steps[0]).toMatchObject({ point: [0.4, 0.6], outcome: 'landed' })
    expect(steps[1]).toMatchObject({ durationMs: 900 })
  })

  it('reads movement as a swipe ending where the last move was, since the end carries no point', () => {
    const [s] = new Rec().touch([[0.5, 0.8], [0.5, 0.6], [0.5, 0.3]]).steps()
    expect(s).toMatchObject({ kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.3] })
  })

  it('reads a thinned flick, with only its last move left, as a swipe', () => {
    // The relay's budget keeps a gesture's start and last move.
    const [s] = new Rec().touch([[0.5, 0.8], [0.5, 0.2]]).steps()
    expect(s).toMatchObject({ kind: 'swipe', to: [0.5, 0.2] })
  })

  it('keeps a tremble under the dashboard\'s drag threshold a tap', () => {
    const [s] = new Rec().touch([[0.5, 0.5], [0.51, 0.505]]).steps()
    expect(s!.kind).toBe('tap')
  })

  it('reads a hold and then a move as a drag after a long press', () => {
    const [s] = new Rec().touch([[0.5, 0.5], [0.5, 0.7]], { holdMs: 700 }).steps()
    expect(s!.kind).toBe('holdDrag')
  })

  it('drops a cancelled touch: the app saw no tap', () => {
    const r = new Rec()
    r.msg({ type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } }).msg({ type: 'input:touch:cancel', sessionId: 's' })
    expect(r.steps()).toEqual([])
  })

  it('marks an input the device refused', () => {
    const [s] = new Rec().touch([[0.5, 0.5]], { ok: false }).steps()
    expect(s!.outcome).toBe('refused')
  })

  it('reads a pinch from its first and last fingers', () => {
    const r = new Rec()
    r.msg({ type: 'input:pinch:start', sessionId: 's', payload: { f0: { x: 0.45, y: 0.5 }, f1: { x: 0.55, y: 0.5 } } })
      .wait(16).msg({ type: 'input:pinch:move', sessionId: 's', payload: { f0: { x: 0.4, y: 0.5 }, f1: { x: 0.6, y: 0.5 } } })
      .wait(300).msg({ type: 'input:pinch:end', sessionId: 's', requestId: 'p' }, true)
    expect(r.steps()[0]).toMatchObject({ kind: 'pinch', start: [[0.45, 0.5], [0.55, 0.5]], end: [[0.4, 0.5], [0.6, 0.5]], durationMs: 316 })
  })

  it('types a run of character keys as one text, shift included', () => {
    const [s] = new Rec().type('hI 2').steps()
    expect(s).toMatchObject({ kind: 'text', text: 'hI 2' })
  })

  it('cuts a run at a key that types nothing, so each piece is judged by its own field', () => {
    // Email, Tab, password: one run would put the password into the email field's verdict.
    const steps = new Rec().type('a@b.co').key('Tab').type('hunter').steps()
    expect(steps.map((s) => s.kind === 'text' ? `text:${s.text}` : s.kind === 'key' ? `key:${s.code}` : s.kind))
      .toEqual(['text:a@b.co', 'key:Tab', 'text:hunter'])
  })

  it('cuts a run at a pause, and keeps a chord out of it', () => {
    const steps = new Rec().type('ab').wait(3000).type('cd').wait(11_000).type('ef').key('KeyA', 0x08).steps()
    expect(steps.map((s) => s.kind === 'text' ? s.text : s.kind)).toEqual(['abcd', 'ef', 'key'])
  })

  it('types letters as Caps Lock left them, and keeps a Caps Lock nothing followed', () => {
    const steps = new Rec().key('CapsLock').key('KeyA').key('KeyB', 0x02).key('CapsLock').key('KeyC').key('Tab')
      .key('CapsLock').key('Enter').steps()
    expect(steps.map((s) => s.kind === 'text' ? s.text : s.kind === 'key' ? s.code : s.kind)).toEqual(['Abc', 'Tab', 'CapsLock', 'Enter'])
    // A press the device refused turned nothing on.
    expect(new Rec().key('CapsLock', 0, false).key('KeyA').steps().map((s) => s.kind === 'text' ? s.text : s.kind)).toEqual(['a'])
  })

  it('leaves a key the device refused out of the text and out of the replay', () => {
    // A refusal can be transient (the input channel still starting): sent again, it would land and type a letter the
    // flow does not have.
    const [s] = new Rec().key('KeyA').key('KeyB', 0, false).key('KeyC').steps()
    expect(s).toMatchObject({ kind: 'text', text: 'ac' })
    expect(s!.messages).toHaveLength(2)
  })

  it('pairs a button\'s down and up, the way iOS\'s bezel sends every press', () => {
    const r = new Rec()
    r.msg({ type: 'input:button', sessionId: 's', requestId: 'd', payload: { name: 'volume_up', phase: 'down' } }, true)
      .wait(120).msg({ type: 'input:button', sessionId: 's', requestId: 'u', payload: { name: 'volume_up', phase: 'up' } }, true)
      .wait(100).msg({ type: 'input:button', sessionId: 's', requestId: 'h', payload: { name: 'home' } }, true)
    expect(r.steps()).toMatchObject([{ kind: 'button', name: 'volume_up', heldMs: 120 }, { kind: 'button', name: 'home' }])
  })

  it('carries a chrome entry to the steps after it, for showing them', () => {
    const steps = new Rec().chrome({ bodyRotation: 90 }).touch([[0.5, 0.5]]).steps()
    expect(steps[0]!.chrome).toEqual({ bodyRotation: 90 })
  })
})

describe('defaultRange', () => {
  it('starts at the first launch after the last install or clear-state', () => {
    const steps = new Rec().install().launch().touch([[0.1, 0.1]]).install().launch().touch([[0.2, 0.2]]).steps()
    expect(defaultRange(steps)).toEqual({ start: 4, end: 6 })
    expect(rangeWarnings(steps, defaultRange(steps))).toEqual([])
  })

  it('starts after an install the person opened from the home screen, and says there was no launch', () => {
    // Measured in the dashboard: its install does not launch the app, and a person taps the icon as often as Launch.
    const steps = new Rec().install().touch([[0.17, 0.48]]).touch([[0.4, 0.2]]).steps()
    expect(defaultRange(steps)).toEqual({ start: 1, end: 3 })
    expect(rangeWarnings(steps, defaultRange(steps))).toEqual(['no-launch-at-start'])
  })

  it('falls back to the last launch, and says the app ran on old data', () => {
    const steps = new Rec().launch().touch([[0.1, 0.1]]).launch().touch([[0.2, 0.2]]).steps()
    expect(defaultRange(steps)).toEqual({ start: 2, end: 4 })
    expect(rangeWarnings(steps, defaultRange(steps))).toEqual(['no-clean-start'])
  })

  it('starts at the beginning without a launch, and says so', () => {
    const steps = new Rec().touch([[0.1, 0.1]]).steps()
    expect(defaultRange(steps)).toEqual({ start: 0, end: 1 })
    expect(rangeWarnings(steps, defaultRange(steps))).toEqual(['no-launch-at-start'])
  })
})

describe('matchStep', () => {
  const signIn = el({ label: 'Sign in', frame: { x: 0.3, y: 0.55, width: 0.4, height: 0.1 } })

  it('names the element a tap landed on', () => {
    const [tap] = new Rec().touch([[0.45, 0.6]]).steps()
    expect(matchStep(tap!, ctxOf([signIn])).step).toEqual({ type: 'tapOn', selector: { text: 'Sign in' } })
  })

  it('keeps the point when no element is there to name', () => {
    const [tap] = new Rec().touch([[0.45, 0.6]]).steps()
    const m = matchStep(tap!, { tree: [] })
    expect(m).toMatchObject({ step: { type: 'tapPoint', at: [0.45, 0.6] }, fragile: 'no-element' })
  })

  it('keeps the point when tapping the element\'s centre would land on something else', () => {
    // A wide cell with a small button on its middle: the person tapped the cell's edge.
    const cell = el({ role: 'cell', label: 'Row', frame: { x: 0, y: 0.5, width: 1, height: 0.2 } })
    const star = el({ label: 'Star', frame: { x: 0.45, y: 0.55, width: 0.1, height: 0.1 } })
    const [tap] = new Rec().touch([[0.1, 0.6]]).steps()
    expect(matchStep(tap!, ctxOf([cell, star]))).toMatchObject({ step: { type: 'tapPoint' }, fragile: 'not-centre' })
  })

  it('never names an element by a label that may be what was typed into it', () => {
    // An Android password node of another class: secure, not an input, its label the masked text.
    const node = el({ role: 'other', label: '••••', secure: true, frame: { x: 0.2, y: 0.4, width: 0.6, height: 0.1 } })
    const [tap] = new Rec().touch([[0.5, 0.45]]).steps()
    const m = matchStep(tap!, ctxOf([node]))
    expect(JSON.stringify(m.step)).not.toContain('••••')
  })

  it('places an iOS point by the app\'s turn, and an Android body-mode point by the screen\'s settled turn', () => {
    // iOS sends the portrait framebuffer; a landscape app (turn 90) draws (0.2, 0.3) of the frame at (0.7, 0.2).
    const [ios] = new Rec().touch([[0.2, 0.3]]).steps()
    expect(matchStep(ios!, { tree: [], interfaceTurn: 90 }).step).toEqual({ type: 'tapPoint', at: [0.7, 0.2] })
    // Body mode sends the frame's own point; the recorded chrome lags and is not read.
    const [android] = new Rec().chrome({ streamRotation: 0 }).touch([[0.2, 0.3]], { space: 'frame' }).steps()
    expect(matchStep(android!, { tree: [], frameTurn: 270 }).step).toEqual({ type: 'tapPoint', at: [0.3, 0.8] })
    // A point with no space is already the screen's, whatever the frame does.
    const [plain] = new Rec().touch([[0.2, 0.3]]).steps()
    expect(matchStep(plain!, { tree: [], frameTurn: 270 }).step).toEqual({ type: 'tapPoint', at: [0.2, 0.3] })
  })

  describe('typing', () => {
    const field = (over: Partial<UIElement>) => el({ role: 'input', label: '', frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.08 }, ...over })
    const [text] = new Rec().type('hunter').steps()

    it('writes typing into a field known not to hide it', () => {
      expect(matchStep(text!, ctxOf([field({ focused: true, secure: false })])).step).toEqual({ type: 'inputText', text: 'hunter' })
    })

    it.each([
      ['a field that hides its text', { focused: true, secure: true }, true],
      ['a field that cannot say', { focused: true }, false],
    ] as const)('keeps it out of the flow for %s', (_, over, known) => {
      const m = matchStep(text!, ctxOf([field(over)]))
      expect(m.step).toBeNull()
      expect(m.secret).toEqual({ value: 'hunter', known })
    })

    it('keeps it out when no field has focus', () => {
      expect(matchStep(text!, ctxOf([field({ secure: false })])).secret).toBeDefined()
    })

    it('keeps it out when focus is in a secret field after it', () => {
      const after = [SCREEN, field({ focused: true, secure: true })]
      expect(matchStep(text!, ctxOf([field({ focused: true, secure: false })], { treeAfter: after })).secret).toBeDefined()
    })

    it('refuses a paste Android cannot type, and takes one it can', () => {
      const r = new Rec()
      r.msg({ type: 'clipboard:write', sessionId: 's', requestId: 'c', payload: { text: '김철수', pasteAfter: true } }, true)
      r.msg({ type: 'clipboard:write', sessionId: 's', requestId: 'd', payload: { text: 'Kim', pasteAfter: true } }, true)
      const [korean, latin] = r.steps()
      const ctx = ctxOf([field({ focused: true, secure: false })], { platform: 'android' })
      expect(matchStep(korean!, ctx).skipped).toBe('paste-not-typeable')
      expect(matchStep(latin!, ctx).step).toEqual({ type: 'inputText', text: 'Kim' })
      expect(matchStep(korean!, { ...ctx, platform: 'ios' }).step).toEqual({ type: 'inputText', text: '김철수' })
    })
  })

  it('says a key that types nothing as a key, with its modifiers', () => {
    const [enter, chord] = new Rec().key('Enter').key('KeyA', 0x08).steps()
    expect(matchStep(enter!, ctxOf([])).step).toEqual({ type: 'pressKey', code: 'Enter' })
    expect(matchStep(chord!, ctxOf([])).step).toEqual({ type: 'pressKey', code: 'KeyA', modifiers: ['meta'] })
  })

  it('leaves out what a flow cannot say, with the reason', () => {
    const r = new Rec().touch([[0.5, 0.5], [0.5, 0.7]], { holdMs: 700 }).touch([[0.5, 0.5]], { ok: false }).install()
    r.msg({ type: 'network:set', sessionId: 's', requestId: 'n', payload: { offline: true } }, true)
    expect(r.steps().map((s) => matchStep(s, ctxOf([])).skipped)).toEqual(['hold-drag', 'refused', 'install', 'network'])
  })

  it('turns a rotate into the orientation it ended in', () => {
    const r = new Rec()
    r.msg({ type: 'input:rotate', sessionId: 's', payload: { direction: 'clockwise' } })
    r.msg({ type: 'input:rotate', sessionId: 's', payload: { orientation: 'portrait' } })
    const [turn, upright] = r.steps()
    expect(matchStep(turn!, ctxOf([], { orientationAfter: 'landscape' })).step).toEqual({ type: 'setOrientation', orientation: 'landscape' })
    expect(matchStep(turn!, ctxOf([], { orientationAfter: 'upside-down' })).skipped).toBe('orientation-unknown')
    expect(matchStep(upright!, ctxOf([])).step).toEqual({ type: 'setOrientation', orientation: 'portrait' })
  })

  it('names a posture by its end of the list', () => {
    const postures = [{ id: 'CLOSED', label: 'Folded' }, { id: 'HALF', label: 'Half' }, { id: 'OPENED', label: 'Open' }]
    const r = new Rec()
    for (const postureId of ['CLOSED', 'HALF', 'OPENED']) r.msg({ type: 'input:posture', sessionId: 's', payload: { postureId } })
    expect(r.steps().map((s) => matchStep(s, ctxOf([], { postures })).step?.type ?? matchStep(s, ctxOf([], { postures })).skipped))
      .toEqual(['setPosture', 'posture-between', 'setPosture'])
  })
})

describe('toFlowSteps', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => el({ role: 'cell', label: `Item ${i}`, frame: { x: 0, y: i * 0.1, width: 1, height: 0.1 } }))
  const item30 = el({ role: 'cell', label: 'Item 30', frame: { x: 0, y: 0.5, width: 1, height: 0.1 } })

  it('turns a swipe that brought the tapped element on screen into scroll until it', () => {
    const [swipe, tap] = new Rec().touch([[0.5, 0.8], [0.5, 0.3]]).touch([[0.5, 0.55]]).steps()
    const flow = toFlowSteps([matchStep(swipe!, ctxOf(list(8))), matchStep(tap!, ctxOf([item30]))])
    expect(flow.steps.map((s) => s.step)).toEqual([
      { type: 'scroll', direction: 'down', until: { text: 'Item 30' } },
      { type: 'tapOn', selector: { text: 'Item 30' } },
    ])
    expect(flow.steps[0]!.auto).toBe(true)
  })

  it('keeps a swipe whose tapped element was on screen already: a pager, not a scroll', () => {
    const cont = el({ label: 'Continue', frame: { x: 0.3, y: 0.85, width: 0.4, height: 0.08 } })
    const [swipe, tap] = new Rec().touch([[0.8, 0.5], [0.2, 0.5]]).touch([[0.5, 0.89]]).steps()
    const flow = toFlowSteps([matchStep(swipe!, ctxOf([cont])), matchStep(tap!, ctxOf([cont]))])
    expect(flow.steps.map((s) => s.step?.type)).toEqual(['swipe', 'tapOn'])
  })

  it('keeps a diagonal swipe a swipe', () => {
    const [swipe, tap] = new Rec().touch([[0.2, 0.8], [0.7, 0.3]]).touch([[0.5, 0.55]]).steps()
    const flow = toFlowSteps([matchStep(swipe!, ctxOf(list(3))), matchStep(tap!, ctxOf([item30]))])
    expect(flow.steps[0]!.step?.type).toBe('swipe')
  })

  it('begins a flow with a launch when the range has none, and adds none when it has one', () => {
    const [tap] = new Rec().touch([[0.45, 0.6]]).steps()
    const [launch] = new Rec().launch().steps()
    const r = new Rec()
    r.msg({ type: 'app:clear-state', sessionId: 's', requestId: 'c', payload: { bundleId: 'com.x' } }, true)
    const [clear] = r.steps()
    const without = toFlowSteps([matchStep(tap!, { tree: [] })])
    expect(without.launchAdded).toBe(true)
    expect(flowSteps(without).map((s) => s.type)).toEqual(['launchApp', 'tapPoint'])
    const withLaunch = toFlowSteps([clear!, launch!, tap!].map((s) => matchStep(s, { tree: [] })))
    expect(withLaunch.launchAdded).toBe(false)
    expect(flowSteps(withLaunch).map((s) => s.type)).toEqual(['clearState', 'launchApp', 'tapPoint'])
  })

  it('names each secret, and hands its value to the dialog only', () => {
    const field = (secure?: boolean) => el({ role: 'input', focused: true, ...(secure === undefined ? {} : { secure }), frame: { x: 0, y: 0.3, width: 1, height: 0.1 } })
    const [a, , b, , c] = new Rec().type('one').key('Tab').type('two').key('Tab').type('three').steps()
    const flow = toFlowSteps([matchStep(a!, ctxOf([field(true)])), matchStep(b!, ctxOf([field(true)])), matchStep(c!, ctxOf([field()]))])
    expect(flow.steps.map((s) => s.step)).toEqual([
      { type: 'inputSecret', name: 'PASSWORD' }, { type: 'inputSecret', name: 'PASSWORD_2' }, { type: 'inputSecret', name: 'SECRET' },
    ])
    expect(flow.secrets).toEqual({ PASSWORD: 'one', PASSWORD_2: 'two', SECRET: 'three' })
  })
})

describe('flowToYaml', () => {
  it('writes every kind of step so it reads back as the same steps', () => {
    const steps = [
      { type: 'clearState', appId: 'com.example' }, { type: 'launchApp', options: { arguments: { demo: true } } },
      { type: 'tapOn', selector: { text: 'Sign in' } }, { type: 'tapOn', selector: { label: 'Go', role: 'button', index: 1 } },
      { type: 'tapPoint', at: [0.4, 0.6] }, { type: 'inputText', text: 'a: "b"\n' }, { type: 'inputSecret', name: 'PASSWORD' },
      { type: 'pressKey', code: 'Enter' }, { type: 'pressKey', code: 'KeyA', modifiers: ['meta'] },
      { type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 250.5 },
      { type: 'scroll', direction: 'down', until: { id: 'row-30' } }, { type: 'openUrl', url: 'app://x' },
      { type: 'pressButton', name: 'home' }, { type: 'longPressOn', selector: { text: 'Map' }, durationMs: 900 },
      { type: 'longPressPoint', at: [0.1, 0.2], durationMs: 700 }, { type: 'pinch', on: [0.5, 0.5], scale: 1.8, durationMs: 400 },
      { type: 'pinch', on: { text: 'Map' }, scale: 0.5, durationMs: 400 },
      { type: 'setOrientation', orientation: 'landscape' }, { type: 'setPosture', posture: 'folded' },
    ] as const
    const yaml = flowToYaml({ name: 'Captured', appId: 'com.example', steps: steps as never })
    expect(parseFlow(yaml, 'x.yaml').steps).toEqual(steps)
    expect(yaml).toContain('tapOn: [ 0.4, 0.6 ]')
    expect(yaml).toContain('inputText:\n      secret: PASSWORD')
  })

  it('refuses to write a flow that would read back as different steps', () => {
    // A selector carrying both text and an id: the file can say only the text, and would tap by it alone.
    const steps = [{ type: 'tapOn', selector: { text: 'Go', id: 'go' } }] as const
    expect(() => flowToYaml({ name: 'x', steps: steps as never })).toThrow(/does not read back as the same steps/)
  })
})

describe('labels', () => {
  it('say what each action was without anything typed, pasted or opened', () => {
    const r = new Rec().touch([[0.4, 0.6]]).type('hunter2').key('KeyV', 0x08)
    r.msg({ type: 'clipboard:write', sessionId: 's', requestId: 'c', payload: { text: 'pasted-secret', pasteAfter: true } }, true)
    r.msg({ type: 'open-url', sessionId: 's', requestId: 'o', payload: { url: 'app://token=abc' } }, true)
    const labels = r.steps().map(rawStepLabel)
    expect(labels).toEqual(['tapOn 40%, 60%', 'inputText (7 chars)', 'pressKey meta+character', 'inputText (13 chars, pasted)', 'openUrl'])
    const matched = r.steps().map((s) => capturedStepLabel(matchStep(s, ctxOf([el({ role: 'input', focused: true, secure: false })]))))
    expect(matched.join(' ')).not.toMatch(/hunter2|pasted-secret|token=abc/)
  })
})

// Recorded in the dashboard on 2026-11-08 (iPhone 17 Pro iOS 26.4 with the UIKit sample, Pixel 6 Android 14 with the
// Compose sample): launch from the home screen, an email and a fake password on the Form tab, two swipes and a tap
// on the List tab, a hold, two pinches and a turn on the Gestures tab. Thresholds set from hand-written messages
// are held here to what a person's hand produced.
describe('recorded in the dashboard', () => {
  const load = (name: string): CaptureEntry[] =>
    (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')) as { entries: CaptureEntry[] }).entries
  const shape = (steps: RawStep[]) => steps.map((s) => s.kind === 'key' ? `key:${s.code}` : s.kind)

  it.each([
    ['capture-ios-uikit.json', [
      'install', 'tap', 'tap', 'text', 'key:Backspace', 'text', 'tap', 'text', 'key:Enter', 'tap', 'key:Enter', 'tap',
      'swipe', 'swipe', 'tap', 'tap', 'longPress', 'pinch', 'pinch', 'rotate',
    ]],
    ['capture-android-compose.json', [
      'install', 'tap', 'tap', 'text', 'tap', 'text', 'key:Enter', 'tap', 'tap', 'tap', 'swipe', 'swipe', 'tap', 'tap',
      'longPress', 'pinch', 'pinch', 'rotate',
    ]],
  ])('reads %s as the actions the person took', (file, kinds) => {
    const steps = segment(load(file))
    expect(shape(steps)).toEqual(kinds)
    expect(steps.every((s) => s.outcome !== 'refused')).toBe(true)
    // Opened from the home screen, not with Launch: the range starts right after the install.
    expect(defaultRange(steps).start).toBe(1)
  })

  it('types the email and the password each as one run, Caps Lock and a pause in the middle included', () => {
    // On iOS the person turned Caps Lock on and off before the email, and paused 2.1 s inside the password.
    for (const file of ['capture-ios-uikit.json', 'capture-android-compose.json']) {
      const texts = segment(load(file)).flatMap((s) => s.kind === 'text' ? [s.text] : [])
      expect(texts.slice(-2)).toEqual(['a@b.co', 'hunter2'])
    }
  })
})
