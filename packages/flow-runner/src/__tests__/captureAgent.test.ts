import { describe, it, expect } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { agentSteps, agentFlow, type AgentAction, type AgentCapture } from '../capture/index.js'
import { parseFlow } from '../schema.js'

// MCP Flow Capture (L6a): an agent's steps named without a Match replay, judged by the agent, written with what was left out.
const el = (label: string, over: Partial<UIElement> = {}): UIElement => ({
  role: 'button', label, frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 }, enabled: true, ...over,
})
const login = el('Login', { identifier: 'login', frame: { x: 0.1, y: 0.8, width: 0.3, height: 0.05 } })
const forms = el('Forms', { identifier: 'forms', frame: { x: 0.5, y: 0.8, width: 0.3, height: 0.05 } })
const welcome = el('Welcome back', { role: 'text', frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 } })
const home = [login, forms]

const capture = (actions: AgentAction[], trees: AgentCapture['trees'] = []): AgentCapture => ({ actions, trees })
const tapAt = (at: number, point: [number, number], more: Partial<Extract<AgentAction, { kind: 'tap' }>> = {}): AgentAction =>
  ({ kind: 'tap', at, point, ...more })

describe('agentSteps', () => {
  it('names an element tap by the agent\'s selector', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], { selector: { id: 'login' } })], [{ at: 5, elements: home }]))
    expect(s).toMatchObject({ step: { type: 'tapOn', selector: { id: 'login' } }, origin: 'agent' })
    expect(s!.mismatch).toBeUndefined()
  })

  it('keeps the agent\'s selector when the touch was seen to hit another element, and says so', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], {
      selector: { id: 'login' }, observed: { point: { x: 0.25, y: 0.82 }, moving: false, element: { identifier: 'forms', traits: 1 } },
    })], [{ at: 5, elements: home }]))
    expect(s).toMatchObject({ step: { type: 'tapOn', selector: { id: 'login' } }, mismatch: { id: 'forms' } })
  })

  it('names a point by what the touch was seen to hit, then by the tree before it, then keeps the point', () => {
    const observed = { point: { x: 0.6, y: 0.82 }, moving: false, element: { identifier: 'forms', traits: 1 } }
    const steps = agentSteps(capture([
      tapAt(10, [0.6, 0.82], { observed }),
      tapAt(20, [0.25, 0.82]),
      tapAt(30, [0.9, 0.05]),
    ], [{ at: 5, elements: home }, { at: 15, elements: home }, { at: 25, elements: home }]))
    expect(steps.map((s) => [s.origin, s.step])).toEqual([
      ['observed', { type: 'tapOn', selector: { id: 'forms' } }],
      ['tree', { type: 'tapOn', selector: { text: 'Login' } }],
      ['coordinate', { type: 'tapPoint', at: [0.9, 0.05] }],
    ])
    expect(steps[2]!.fragile).toBe('no-element')
  })

  it('does not name a point by what it hit when that element\'s centre is something else: the flow would tap that', () => {
    const card = el('Card', { identifier: 'card', frame: { x: 0, y: 0.2, width: 1, height: 0.4 } })
    const badge = el('Badge', { identifier: 'badge', frame: { x: 0.45, y: 0.35, width: 0.1, height: 0.1 } })
    const [s] = agentSteps(capture([tapAt(10, [0.1, 0.25], { observed: { point: { x: 0.1, y: 0.25 }, moving: false, element: { identifier: 'card', traits: 1 } } })],
      [{ at: 5, elements: [card, badge] }]))
    expect(s).toMatchObject({ step: { type: 'tapPoint', at: [0.1, 0.25] }, fragile: 'not-centre', origin: 'coordinate' })
  })

  it('keeps a point on a web view or Flutter as a point, whatever the tree says', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], { observed: { point: { x: 0.25, y: 0.82 }, moving: false, surface: 'web' } })],
      [{ at: 5, elements: home }]))
    expect(s).toMatchObject({ step: { type: 'tapPoint' }, origin: 'coordinate', fragile: 'no-element' })
  })

  it('does not read a tree from before the previous step as this one\'s', () => {
    const steps = agentSteps(capture([tapAt(10, [0.25, 0.82], { selector: { id: 'login' } }), tapAt(20, [0.25, 0.82])], [{ at: 5, elements: home }]))
    expect(steps[1]).toMatchObject({ origin: 'coordinate', step: { type: 'tapPoint' } })
  })

  it('writes typed text only into a field read as not secure; anything else is a secret', () => {
    const steps = agentSteps(capture([
      { kind: 'type', at: 1, text: 'me@x.io', field: { secure: false, identifier: 'email' } },
      { kind: 'type', at: 2, text: 'hunter2', field: { secure: true } },
      { kind: 'type', at: 3, text: 'maybe' },
      { kind: 'type', at: 4, text: 'none', field: null },
    ]))
    expect(steps[0]).toMatchObject({ step: { type: 'inputText', text: 'me@x.io' } })
    expect(steps.slice(1).map((s) => [s.step, s.secret])).toEqual([
      [null, { value: 'hunter2', known: true }], [null, { value: 'maybe', known: false }], [null, { value: 'none', known: false }],
    ])
  })

  it('never offers to expect an element that shows what was typed as a secret', () => {
    const shows = el('Signed in as tok-123', { role: 'text', frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 } })
    const steps = agentSteps(capture([
      { kind: 'type', at: 1, text: 'tok-123' },
      tapAt(10, [0.25, 0.82], { selector: { id: 'login' } }),
      { kind: 'button', at: 30, name: 'home' },
    ], [{ at: 5, elements: home }, { at: 20, elements: [shows, welcome] }]))
    expect(steps[1]!.expectable!.map((c) => c.selector.label)).toEqual(['Welcome back'])
  })

  it('never offers to expect an element showing one piece of a secret typed with a Tab in it (CodeRabbit, #1244)', () => {
    const shows = el('Hello hunter2', { role: 'text', frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 } })
    const steps = agentSteps(capture([
      { kind: 'type', at: 1, text: 'a@b.c\thunter2', field: { secure: false } },
      tapAt(10, [0.25, 0.82], { selector: { id: 'login' } }),
      { kind: 'button', at: 30, name: 'home' },
    ], [{ at: 5, elements: home }, { at: 20, elements: [shows, welcome] }]))
    expect(steps[1]!.expectable!.map((c) => c.selector.label)).toEqual(['Welcome back'])
  })

  it('never names a tap by an element whose name holds a typed secret: the next way, down to a point (CodeRabbit, #1244)', () => {
    const copy = el('Copy', { identifier: 'copy-tok-123', frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } })
    const bare = el('Copy tok-123', { frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } })
    const typed: AgentAction = { kind: 'type', at: 1, text: 'tok-123', field: { secure: true } }
    const [, byTree] = agentSteps(capture([typed, tapAt(10, [0.25, 0.52], { selector: { id: 'copy-tok-123' } })],
      [{ at: 5, elements: [copy] }]))
    expect(byTree).toMatchObject({ step: { type: 'tapOn', selector: { text: 'Copy' } }, origin: 'tree', withheld: true })
    const [, point] = agentSteps(capture([typed, tapAt(10, [0.25, 0.52], { selector: { label: 'Copy tok-123', exact: true } })],
      [{ at: 5, elements: [bare] }]))
    expect(point).toMatchObject({ step: { type: 'tapPoint', at: [0.25, 0.52] }, origin: 'coordinate', fragile: 'no-selector', withheld: true })
    const [, seen] = agentSteps(capture([typed, tapAt(10, [0.25, 0.52], {
      observed: { point: { x: 0.25, y: 0.52 }, moving: false, element: { label: 'Copy tok-123', traits: 1 } },
    })], [{ at: 5, elements: [bare] }]))
    expect(seen).toMatchObject({ step: { type: 'tapPoint' }, withheld: true })
    const r = agentFlow(agentSteps(capture([{ kind: 'launch', at: 0 }, typed, tapAt(10, [0.25, 0.52], { selector: { label: 'Copy tok-123', exact: true } })],
      [{ at: 5, elements: [bare] }])), { name: 'copy' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusals))
    expect(r.flow.yaml).not.toContain('tok-123')
    expect(r.flow.notes).toContain('Not named by an element whose name holds a typed secret: #3')
  })

  it('keeps a secret a secret when it is typed again into a plain field (CodeRabbit, #1244)', () => {
    const steps = agentSteps(capture([
      { kind: 'launch', at: 0 },
      { kind: 'type', at: 1, text: 'tok-123', field: { secure: true } },
      { kind: 'type', at: 2, text: 'tok-123', field: { secure: false } },
      { kind: 'type', at: 3, text: 'jane', field: { secure: false } },
    ]))
    expect(steps.slice(1).map((s) => s.step?.type ?? null)).toEqual([null, null, 'inputText'])
    const r = agentFlow(steps, { name: 'retype' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusals))
    expect(r.flow.yaml).not.toContain('tok-123')
    expect(r.flow.yaml).toContain('jane')
  })

  it('keeps typing with a Tab or a Return in it a secret: it may have moved to the next field', () => {
    const steps = agentSteps(capture([
      { kind: 'type', at: 1, text: 'a@b.c\thunter2', field: { secure: false } },
      { kind: 'type', at: 2, text: 'a@b.c\nhunter2', field: { secure: false } },
    ]))
    expect(steps.map((s) => s.step)).toEqual([null, null])
  })

  it('offers what the screen after a touch shows as expectations, warning on what it showed before', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], { selector: { id: 'login' } }), { kind: 'button', at: 30, name: 'home' }],
      [{ at: 5, elements: home }, { at: 20, elements: [welcome, forms] }]))
    expect(s!.expectable).toEqual([
      { selector: { label: 'Welcome back', exact: true }, warnings: [] },
      { selector: { id: 'forms', label: 'Forms', exact: true }, warnings: ['before'] },
    ])
  })

  it('marks a run_flow\'s steps as the agent\'s, and those past where it failed', () => {
    const steps = agentSteps(capture([{ kind: 'flow', at: 1, block: 1, passed: 1, source: { hash: 'h' },
      steps: [{ type: 'launchApp' }, { type: 'tapOn', selector: { id: 'login' } }] }]))
    expect(steps.map((s) => [s.origin, s.block, s.failed])).toEqual([['agent-step', 1, undefined], ['agent-step', 1, true]])
  })

  it('leaves out a run_flow step holding a typed secret anywhere, and says so (CodeRabbit, #1248)', () => {
    const typed: AgentAction = { kind: 'type', at: 1, text: '4826', field: { secure: true } }
    const block: AgentAction = { kind: 'flow', at: 2, block: 1, passed: 4, source: { hash: 'h' }, steps: [
      { type: 'tapOn', selector: { label: 'PIN 4826' } },
      { type: 'openUrl', url: 'app://unlock?pin=4826' },
      { type: 'tapOn', selector: { id: 'login' } },
      { type: 'assertVisible', selector: { label: 'Welcome' } },
    ] }
    const steps = agentSteps(capture([{ kind: 'launch', at: 0 }, typed, block]))
    expect(steps.slice(2).map((s) => [s.step?.type ?? null, s.withheld])).toEqual([
      [null, true], [null, true], ['tapOn', undefined], ['assertVisible', undefined],
    ])
    const r = agentFlow(steps, { name: 'pin' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusals))
    expect(r.flow.yaml).not.toContain('4826')
    expect(r.flow.notes).toContain('Left out, a run_flow step holding a typed secret: #3, #4')
  })

  it('offers a tap the app did not respond to for leaving out', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], { selector: { id: 'login' }, observed: { point: { x: 0.25, y: 0.82 }, moving: false, acted: false } })]))
    expect(s!.noResponse).toBe(true)
  })

  it('makes a long press of a tap held past the threshold', () => {
    const [s] = agentSteps(capture([tapAt(10, [0.25, 0.82], { selector: { id: 'login' }, holdMs: 800 })]))
    expect(s!.step).toEqual({ type: 'longPressOn', selector: { id: 'login' }, durationMs: 800 })
  })
})

describe('agentFlow', () => {
  const steps = agentSteps(capture([
    { kind: 'launch', at: 1 },
    tapAt(10, [0.6, 0.82], { selector: { id: 'forms' } }),
    tapAt(20, [0.25, 0.82], { selector: { id: 'login' } }),
    { kind: 'type', at: 30, text: 'hunter2', field: { secure: true } },
    { kind: 'button', at: 40, name: 'home' },
  ], [{ at: 5, elements: home }, { at: 15, elements: home }, { at: 25, elements: [welcome, forms] }]))

  it('writes the judged flow with what was left out in its comment, and the secret only for Verify', () => {
    const r = agentFlow(steps, { name: 'login', drop: [2], expect: [{ step: 3, candidate: 0 }], secrets: [{ step: 4, name: 'APP_PASSWORD' }] }, { appId: 'com.app' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusals))
    expect(r.flow.steps).toEqual([
      { type: 'clearState' }, { type: 'launchApp' },
      { type: 'tapOn', selector: { id: 'login' } },
      { type: 'assertVisible', selector: { label: 'Welcome back', exact: true } },
      { type: 'inputSecret', name: 'APP_PASSWORD' },
      { type: 'pressButton', name: 'home' },
    ])
    expect(r.flow.secrets).toEqual({ APP_PASSWORD: 'hunter2' })
    expect(r.flow.yaml).not.toContain('hunter2')
    expect(r.flow.yaml).toMatch(/^# Captured from an AI agent's session over MCP: 5 steps recorded\.\n# Left out by the agent: #2\n/)
    expect(parseFlow(r.flow.yaml, 'x.yaml').steps).toEqual(r.flow.steps)
    // Each flow step in the agent's numbers, so a Verify that fails on one can say which: the expectation is its tap's.
    expect(r.flow.origins).toEqual([null, 1, 3, 3, 4, 5])
  })

  it('numbers the steps after a clear-state the range began with, the added launch between', () => {
    const cleared = agentSteps(capture([{ kind: 'clearState', at: 1 }, tapAt(10, [0.25, 0.82], { selector: { id: 'login' } })], [{ at: 5, elements: home }]))
    const r = agentFlow(cleared, { name: 'l' }, { appId: 'com.app' })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.steps.map((s) => s.type)).toEqual(['clearState', 'launchApp', 'tapOn'])
    expect(r.flow.origins).toEqual([1, null, 2])
  })

  it('writes the screen size only for a flow that touches a point', () => {
    const viewport = { width: 1206, height: 2622 }
    const point = agentSteps(capture([tapAt(10, [0.9, 0.05])]))
    const p = agentFlow(point, { name: 'p' }, { viewport })
    if (!p.ok) throw new Error('refused')
    expect(parseFlow(p.flow.yaml, 'p.yaml').viewport).toEqual(viewport)
    const named = agentFlow(steps, { name: 'n', to: 3 }, { viewport })
    if (!named.ok) throw new Error('refused')
    expect(parseFlow(named.flow.yaml, 'n.yaml').viewport).toBeUndefined()
  })

  it('says when a step was left out after it failed in an earlier Verify, and which try passed', () => {
    const r = agentFlow(steps, { name: 'l', drop: [2], failedBefore: [2], attempt: 2, expect: [{ step: 3, candidate: 0 }] })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.notes).toContain('Left out after they failed in an earlier Verify (dropped-after-verify-failure): #2')
    expect(r.flow.yaml).toContain('verified on try 2')
  })

  it('warns about a flow that expects nothing, counting none the screen already showed', () => {
    const noExpect = agentFlow(steps, { name: 'l' })
    if (!noExpect.ok) throw new Error('refused')
    expect(noExpect.flow.notes.some((n) => n.startsWith('Warning: no expectation'))).toBe(true)
  })

  it('does not count an expectation the screen already showed before the touch', () => {
    const r = agentFlow(steps, { name: 'l', expect: [{ step: 3, candidate: 1 }] })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.notes.some((n) => n.startsWith('Warning: no expectation'))).toBe(true)
  })

  it('warns when many steps are left out', () => {
    const r = agentFlow(steps, { name: 'l', drop: [2, 3, 5] })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.notes).toContain('Warning: 3 of 5 steps left out')
  })

  it('refuses a flow that does nothing but start the app', () => {
    expect(agentFlow(steps, { name: 'l', drop: [2, 3, 4, 5] })).toEqual({ ok: false, refusals: [{ reason: 'nothing-done' }] })
  })

  it('refuses choices outside what was offered', () => {
    const r = agentFlow(steps, { name: 'l', drop: [9], expect: [{ step: 3, candidate: 7 }], secrets: [{ step: 2, name: 'X' }, { step: 4, name: '1bad' }] })
    expect(r).toEqual({ ok: false, refusals: [
      { step: 9, reason: 'out-of-range' }, { step: 3, reason: 'no-candidate' }, { step: 2, reason: 'not-secret' }, { step: 4, reason: 'bad-secret-name' },
    ] })
    expect(agentFlow(steps, { name: 'l', from: 4, to: 2 })).toMatchObject({ ok: false, refusals: [{ reason: 'bad-range' }] })
    // Refused before the range is walked: a number this large would otherwise be counted up to (CodeRabbit, #1244).
    expect(agentFlow(steps, { name: 'l', to: Number.MAX_SAFE_INTEGER })).toEqual({ ok: false, refusals: [{ reason: 'bad-range' }] })
  })

  it('turns a swipe that brought the next tapped element into view into scroll until, as Manual does', () => {
    const list = el('', { role: 'list', frame: { x: 0, y: 0.1, width: 1, height: 0.8 } })
    const row = (id: string, y: number) => el(id, { role: 'button', identifier: id, frame: { x: 0, y, width: 1, height: 0.08 } })
    const swiped = agentSteps(capture([
      { kind: 'launch', at: 1 },
      { kind: 'swipe', at: 10, from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 300 },
      tapAt(20, [0.5, 0.44], { selector: { id: 'row-30' } }),
    ], [{ at: 5, elements: [list, row('row-1', 0.2), row('row-2', 0.3)] }, { at: 15, elements: [list, row('row-29', 0.3), row('row-30', 0.4)] }]))
    const r = agentFlow(swiped, { name: 'l' })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.steps).toContainEqual({ type: 'scroll', direction: 'down', until: { id: 'row-30' } })
  })

  it('refuses a secret name already holding another value, and lets two steps of one value share it', () => {
    const two = agentSteps(capture([
      { kind: 'launch', at: 1 },
      { kind: 'type', at: 2, text: 'one' },
      { kind: 'type', at: 3, text: 'two' },
      { kind: 'type', at: 4, text: 'one' },
    ]))
    // Steps 2 and 3 are SECRET and SECRET_2; naming 2 SECRET_2 would type 'two' into both.
    expect(agentFlow(two, { name: 'l', secrets: [{ step: 2, name: 'SECRET_2' }] })).toMatchObject({ ok: false, refusals: [{ reason: 'secret-name-taken' }] })
    const same = agentFlow(two, { name: 'l', secrets: [{ step: 2, name: 'PIN' }, { step: 4, name: 'PIN' }] })
    if (!same.ok) throw new Error(JSON.stringify(same.refusals))
    expect(same.flow.secrets).toEqual({ PIN: 'one', SECRET_2: 'two' })
  })

  it('still makes a scroll of a swipe the agent expected something after, and does not call it fragile', () => {
    const list = el('', { role: 'list', frame: { x: 0, y: 0.1, width: 1, height: 0.8 } })
    const row = (id: string, y: number) => el(id, { role: 'button', identifier: id, frame: { x: 0, y, width: 1, height: 0.08 } })
    const swiped = agentSteps(capture([
      { kind: 'launch', at: 1 },
      { kind: 'swipe', at: 10, from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 300 },
      tapAt(20, [0.5, 0.44], { selector: { id: 'row-30' } }),
    ], [{ at: 5, elements: [list, row('row-1', 0.2), row('row-2', 0.3)] }, { at: 15, elements: [list, row('row-29', 0.3), row('row-30', 0.4)] }]))
    const k = swiped[1]!.expectable!.findIndex((c) => c.selector.id === 'row-29')
    const r = agentFlow(swiped, { name: 'l', expect: [{ step: 2, candidate: k }] })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.steps.slice(-3)).toEqual([
      { type: 'scroll', direction: 'down', until: { id: 'row-30' } },
      { type: 'assertVisible', selector: { id: 'row-29', label: 'row-29', exact: true } },
      { type: 'tapOn', selector: { id: 'row-30' } },
    ])
    expect(r.flow.notes.some((n) => n.startsWith('Fragile'))).toBe(false)
  })

  it('refuses a step past where its run_flow failed, and takes the steps before it', () => {
    const block = agentSteps(capture([{ kind: 'flow', at: 1, block: 1, passed: 2, source: { hash: 'h' },
      steps: [{ type: 'launchApp' }, { type: 'tapOn', selector: { id: 'login' } }, { type: 'tapOn', selector: { id: 'gone' } }] }]))
    expect(agentFlow(block, { name: 'l' })).toEqual({ ok: false, refusals: [{ step: 3, reason: 'failed-block' }] })
    const r = agentFlow(block, { name: 'l', to: 2 })
    if (!r.ok) throw new Error('refused')
    expect(r.flow.notes).toContain('Written by the agent (run_flow), not observed: 1 block')
  })
})
