import { describe, it, expect } from 'vitest'
import { parseFlow, type CapturedFlow, type CapturedStep, type FlowResult, type RawStep } from '@tapflowio/flow-runner/browser'
import { askedReady, canGoTo, initialState, reduce, stepIndex, withAsked, type CaptureState } from '@/lib/flowCapture/machine'
import { editedCapture, exportedFlow, fileNameOf, flowOf, moveEdge, withEffects, yamlOf } from '@/lib/flowCapture/flow'
import { addMark, markOf } from '@/lib/flowCapture/marks'
import { NO_MARKS } from '@/lib/watchActions'

// Flow Capture's dialog (#1125), the parts with no screen: the order of its states, and what Edit makes of the flow.
const raw = {} as CapturedStep['raw']
const step = (s: CapturedStep['step'], extra: Partial<CapturedStep> = {}): CapturedStep => ({ raw, step: s, ...extra })
const captured: CapturedFlow = {
  launchAdded: true,
  secrets: { PASSWORD: 'hunter2', SECRET: 'other' },
  steps: [
    step({ type: 'tapOn', selector: { text: 'Sign in' } }),
    step({ type: 'inputSecret', name: 'PASSWORD' }),
    step({ type: 'inputSecret', name: 'SECRET' }),
    step(null, { skipped: 'network' }),
  ],
}

describe('the dialog\'s states', () => {
  it('goes Range → Match → Edit → Verify, keeps it all on the way back, and drops it on a new replay', () => {
    let s = reduce(initialState, { type: 'loaded', steps: [], range: { start: 0, end: 3 }, name: '' })
    expect(s.phase).toBe('range')
    s = reduce(s, { type: 'match-started', total: 3 })
    s = reduce(s, { type: 'step-matched', step: captured.steps[0]!, screenshot: 'blob:1' })
    expect(s).toMatchObject({ phase: 'matching', progress: { done: 1, total: 3 }, screenshots: ['blob:1'] })
    s = reduce(s, { type: 'match-finished', captured })
    s = reduce(s, { type: 'remove-step', index: 0 })
    expect(s.phase).toBe('edit')
    s = reduce(s, { type: 'verify-started' })
    expect(stepIndex(s.phase)).toBe(3)
    s = reduce(s, { type: 'verify-finished', result: { status: 'failed', steps: [] } as unknown as FlowResult })
    s = reduce(s, { type: 'go-to', step: 2 })
    expect(s).toMatchObject({ phase: 'edit', removed: [0], verify: { status: 'failed' } })
    s = reduce(s, { type: 'go-to', step: 0 })
    expect(s).toMatchObject({ phase: 'range', matched: [captured.steps[0]], captured, removed: [0] })
    s = reduce(s, { type: 'match-started', total: 3 })
    expect(s).toMatchObject({ phase: 'matching', matched: [], captured: null, removed: [], verify: null })
  })

  it('keeps what matched when the replay stops, so it can still be taken into Edit', () => {
    let s = reduce(initialState, { type: 'match-started', total: 2 })
    s = reduce(s, { type: 'step-matched', step: captured.steps[0]! })
    s = reduce(s, { type: 'match-failed', error: 'stopped' })
    expect(s).toMatchObject({ phase: 'matching', error: 'stopped', matched: [captured.steps[0]] })
  })
})

// #1140: a password typed on the soft keyboard, its value given by the person before Match.
describe('the passwords the person gives', () => {
  const base = { at: 0, endAt: 0, outcome: 'landed', messages: [] }
  const steps = [
    { ...base, kind: 'tap', point: [0.5, 0.5] },
    { ...base, kind: 'text', text: '', replace: true, fieldRead: 'secure', askValue: true },
    { ...base, kind: 'text', text: 'ab', replace: true, fieldRead: 'secure', askValue: true },
  ] as unknown as RawStep[]
  const loaded = reduce(initialState, { type: 'loaded', steps, range: { start: 0, end: 3 }, name: '' })

  it('holds Match until each one in the range has a value, starting from what the computer\'s keyboard typed', () => {
    expect(askedReady(loaded)).toBe(false)
    expect(askedReady({ ...loaded, range: { start: 2, end: 3 } })).toBe(true)
    const given = reduce(loaded, { type: 'set-asked', index: 1, value: 's3cret' })
    expect(askedReady(given)).toBe(true)
    expect(askedReady(reduce(given, { type: 'set-asked', index: 2, value: '' }))).toBe(false)
  })

  it('replays the value given, and forgets them all when another recording loads', () => {
    const given = reduce(loaded, { type: 'set-asked', index: 1, value: 's3cret' })
    expect(withAsked(given).map((s) => (s.kind === 'text' ? s.text : s.kind))).toEqual(['tap', 's3cret', 'ab'])
    expect(reduce(given, { type: 'loaded', steps, range: { start: 0, end: 3 }, name: '' }).asked).toEqual({})
  })
})

describe('Match\'s count', () => {
  // Review: a tap the replay added on the field typed into is not one of the range's steps.
  it('does not count a step the replay added', () => {
    let s = reduce(initialState, { type: 'match-started', total: 2 })
    s = reduce(s, { type: 'step-matched', step: captured.steps[0]!, inserted: true })
    s = reduce(s, { type: 'step-matched', step: captured.steps[0]! })
    expect(s.progress.done).toBe(1)
    expect(s.matched).toHaveLength(2)
  })
})

describe('a verification as it runs', () => {
  it('records each step as it starts and ends, timed, and counts the ended ones', () => {
    let s = reduce(initialState, { type: 'verify-started' })
    s = reduce(s, { type: 'verify-step', mark: { index: 0, name: 'launchApp', phase: 'start' }, at: 1000 })
    expect(s.verify?.live).toEqual([{ index: 0, name: 'launchApp', status: 'running', startedAt: 1000 }])
    s = reduce(s, { type: 'verify-step', mark: { index: 0, name: 'launchApp (cold)', phase: 'end', status: 'failed' }, at: 2500 })
    expect(s.verify?.live).toEqual([{ index: 0, name: 'launchApp (cold)', status: 'failed', startedAt: 1000, durationMs: 1500 }])
    expect(s.verify?.done).toBe(1)
  })
})

describe('the steps the stepper goes to', () => {
  const loaded = reduce(initialState, { type: 'loaded', steps: [], range: { start: 0, end: 3 }, name: '' })
  const offered = (s: CaptureState) => [0, 1, 2, 3, 4].filter((i) => canGoTo(s, i))
  const passed = { status: 'passed', steps: [] } as unknown as FlowResult
  const edit = reduce(reduce(loaded, { type: 'match-started', total: 3 }), { type: 'match-finished', captured })
  const exported = reduce(reduce(reduce(edit, { type: 'verify-started' }), { type: 'verify-finished', result: passed }), { type: 'to-export' })

  it('offers none while the device is replaying or verifying, and Range once either stops', () => {
    const matching = reduce(loaded, { type: 'match-started', total: 3 })
    expect(offered(matching)).toEqual([])
    expect(offered(reduce(matching, { type: 'match-failed', error: 'stopped' }))).toEqual([0])
    const verifying = reduce(edit, { type: 'verify-started' })
    expect(offered(verifying)).toEqual([])
    // A verification that threw stays `running`, with the reason beside it.
    expect(offered(reduce(verifying, { type: 'match-failed', error: 'lost' }))).toEqual([0, 2])
  })

  it('keeps everything on a step back, and offers the way forward again — never Match', () => {
    expect(offered(exported)).toEqual([0, 2, 3])
    const back = reduce(reduce(exported, { type: 'rename-secret', from: 'SECRET', to: 'SECRET' }), { type: 'go-to', step: 0 })
    expect(back).toMatchObject({ phase: 'range', verify: { status: 'passed' }, captured })
    expect(offered(back)).toEqual([2, 3, 4])
    expect(reduce(back, { type: 'go-to', step: 3 })).toMatchObject({ phase: 'verifying', verify: { status: 'passed' } })
    expect(reduce(back, { type: 'go-to', step: 1 }).phase).toBe('range')
  })

  it('offers nothing forward once the range moves off the one replayed, and again once it is put back', () => {
    const back = reduce(exported, { type: 'go-to', step: 0 })
    const moved = reduce(back, { type: 'set-range', range: { start: 0, end: 2 } })
    expect(offered(moved)).toEqual([])
    expect(reduce(moved, { type: 'go-to', step: 2 }).phase).toBe('range')
    expect(offered(reduce(moved, { type: 'set-range', range: { start: 0, end: 3 } }))).toEqual([2, 3, 4])
  })

  it('drops a verification once the flow is edited, and keeps renames through a new replay', () => {
    const renamed = reduce(reduce(exported, { type: 'go-to', step: 2 }), { type: 'rename-secret', from: 'PASSWORD', to: 'PASS' })
    expect(renamed.verify).toBeNull()
    expect(offered(renamed)).toEqual([0])
    const removed = reduce(reduce(exported, { type: 'go-to', step: 2 }), { type: 'remove-step', index: 0 })
    expect(offered(removed)).toEqual([0])
    const again = reduce(reduce(removed, { type: 'go-to', step: 0 }), { type: 'match-started', total: 3 })
    expect(again).toMatchObject({ removed: [], captured: null, verify: null })
    expect(reduce(renamed, { type: 'match-started', total: 3 }).renamed).toEqual({ PASSWORD: 'PASS' })
  })
})

describe('what Edit makes of the flow', () => {
  const state = { captured, removed: [2], renamed: { PASSWORD: 'LOGIN_PASSWORD' }, made: {}, name: 'Sign in', tags: 'smoke, login' }

  it('drops removed steps, renames secrets, and keeps only the values of secrets still used', () => {
    const edited = editedCapture(state)!
    expect(edited.steps.map((s) => s.step)).toEqual([
      { type: 'tapOn', selector: { text: 'Sign in' } }, { type: 'inputSecret', name: 'LOGIN_PASSWORD' }, null,
    ])
    expect(edited.secrets).toEqual({ LOGIN_PASSWORD: 'hunter2' })
  })

  it('writes a file that starts from a cleared app and reads back with its appId', () => {
    const flow = flowOf(state, 'com.example.app')!
    expect(flow).toMatchObject({ name: 'Sign in', appId: 'com.example.app', tags: ['smoke', 'login'] })
    expect(flow.steps.map((s) => s.type)).toEqual(['clearState', 'launchApp', 'tapOn', 'inputSecret'])
    const yaml = yamlOf(flow)
    expect(parseFlow(yaml, 'x.yaml').steps).toEqual(flow.steps)
    expect(yaml).not.toContain('hunter2')
  })

  it('without a bundle id, clears nothing and names no app', () => {
    const flow = flowOf(state, null)!
    expect(flow.appId).toBeUndefined()
    expect(flow.steps[0]!.type).toBe('launchApp')
  })

  it.each([['Sign in and open an order', 'flows/sign-in-and-open-an-order.yaml'], ['  ', 'flows/captured-flow.yaml'], ['로그인', 'flows/captured-flow.yaml']])(
    'names %j %s', (name, file) => expect(fileNameOf(name)).toBe(file),
  )

  it('moves one handle, and stops it a step short of the other and at the ends', () => {
    const range = { start: 2, end: 8 }
    expect(moveEdge(range, 'start', 0, 10)).toEqual({ start: 0, end: 8 })
    expect(moveEdge(range, 'start', 5, 10)).toEqual({ start: 5, end: 8 })
    expect(moveEdge(range, 'start', 9, 10)).toEqual({ start: 7, end: 8 })
    expect(moveEdge(range, 'start', -3, 10)).toEqual({ start: 0, end: 8 })
    expect(moveEdge(range, 'end', 10, 10)).toEqual({ start: 2, end: 10 })
    expect(moveEdge(range, 'end', 14, 10)).toEqual({ start: 2, end: 10 })
    expect(moveEdge(range, 'end', 1, 10)).toEqual({ start: 2, end: 3 })
  })
})

// What the dialog draws over a step's picture and the device, as the MCP watch view draws an agent's touches.
// #1125: what Verify saw each touch do goes into the file beside it, so a run fails when the touch stops doing it.
describe('what Verify saw, in the exported flow', () => {
  const flow = { name: 'f', steps: [{ type: 'launchApp' }, { type: 'tapOn', selector: { text: 'Save' } }, { type: 'tapOn', selector: { text: 'Back' } }] } as const
  const seen = { appear: [{ text: 'Saved', role: 'text' }] }
  const verified = (observed: unknown[]) => ({
    name: 'f', status: 'passed', durationMs: 1,
    steps: observed.map((o, index) => ({ index, name: `s${index}`, status: 'passed', durationMs: 1, ...(o === undefined ? {} : { observed: o }) })),
  }) as unknown as FlowResult

  it('writes a touch\'s effect beside it, and nothing beside one that changed nothing', () => {
    const out = withEffects(flow as never, verified([undefined, seen, null]))
    expect(out.steps).toEqual([flow.steps[0], { ...flow.steps[1], expect: seen }, flow.steps[2]])
    expect(parseFlow(yamlOf(out), 'f.yaml').steps[1]).toEqual({ ...flow.steps[1], expect: seen })
  })

  it('pins the flow to the screen Verify ran on, when it said one', () => {
    const result = { ...verified([undefined, seen, null]), viewport: { width: 402, height: 874 } } as FlowResult
    expect(withEffects(flow as never, result).viewport).toEqual({ width: 402, height: 874 })
    expect(withEffects(flow as never, verified([undefined, seen, null]))).not.toHaveProperty('viewport')
  })

  // Research for #1125: two looks minutes apart tell a number that changes by itself from the touch's effect.
  it('writes only what Match saw too, where Match watched the touch', () => {
    const saved = { appear: [{ text: 'Saved', role: 'text' }] }
    const both = { appear: [{ text: 'Saved', role: 'text' }, { id: 'presence', text: '3 online' }] }
    const matched = [
      { raw: {}, step: flow.steps[1], observed: { appear: [{ text: 'Saved', role: 'text' }, { id: 'presence', text: '5 online' }] } },
      { raw: {}, step: flow.steps[2], observed: null },
    ] as unknown as CapturedStep[]
    const out = withEffects(flow as never, verified([undefined, both, saved]), matched)
    expect(out.steps).toEqual([flow.steps[0], { ...flow.steps[1], expect: saved }, flow.steps[2]])
  })

  it('is what Export gets: the edited flow, with what Verify and Match both saw', () => {
    const tapSave = { type: 'tapOn', selector: { text: 'Save' } } as const
    const captured = { steps: [{ raw: {}, step: tapSave, observed: { appear: [{ text: 'Saved', role: 'text' }] } }], launchAdded: false, secrets: {} }
    const result = { name: 'f', status: 'passed', durationMs: 1, steps: [{ index: 0, name: 's', status: 'passed', durationMs: 1, observed: { appear: [{ text: 'Saved', role: 'text' }, { text: 'Extra', role: 'text' }] } }] }
    const state = { ...initialState, captured, name: 'f', verify: { status: 'passed', done: 1, live: [], result } } as unknown as CaptureState
    expect(exportedFlow(state, null)?.steps).toEqual([{ ...tapSave, expect: { appear: [{ text: 'Saved', role: 'text' }] } }])
  })

  it('writes nothing from a Verify of other steps, or with no Verify', () => {
    expect(withEffects(flow as never, verified([undefined, seen]))).toBe(flow)
    expect(withEffects(flow as never, undefined)).toBe(flow)
  })
})

describe('the touches drawn', () => {
  const base = { at: 0, endAt: 0, outcome: 'landed', messages: [] }

  it('marks a tap, a key, a long press and a swipe, and nothing else', () => {
    expect(markOf({ ...base, kind: 'tap', point: [0.2, 0.3] } as unknown as RawStep)).toEqual({ kind: 'tap', x: 0.2, y: 0.3 })
    expect(markOf({ ...base, kind: 'keyboardKey', point: [0.5, 0.9] } as unknown as RawStep)).toEqual({ kind: 'tap', x: 0.5, y: 0.9 })
    expect(markOf({ ...base, kind: 'swipe', from: [0.1, 0.8], to: [0.1, 0.2], durationMs: 200 } as unknown as RawStep))
      .toEqual({ kind: 'swipe', from: [0.1, 0.8], to: [0.1, 0.2] })
    expect(markOf({ ...base, kind: 'text', text: 'a' } as unknown as RawStep)).toBeNull()
  })

  it('marks nothing on a turned device, whose points are in another frame than its picture', () => {
    const turned = { ...base, kind: 'tap', point: [0.2, 0.3], chrome: { bodyRotation: 90, streamRotation: 0 } }
    expect(markOf(turned as unknown as RawStep)).toBeNull()
  })

  it('moves the cursor to each touch and keeps the last few trails', () => {
    let m = NO_MARKS
    for (let i = 1; i <= 6; i++) m = addMark(m, i, { kind: 'tap', x: i / 10, y: 0.5 })
    expect(m.cursor).toEqual({ x: 0.6, y: 0.5 })
    expect(m.trails.map((t) => t.id)).toEqual([3, 4, 5, 6])
    expect(addMark(m, 7, { kind: 'swipe', from: [0, 0], to: [1, 1] }).cursor).toEqual({ x: 1, y: 1 })
  })
})
