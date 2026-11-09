import { describe, it, expect } from 'vitest'
import { parseFlow, type CapturedFlow, type CapturedStep, type FlowResult } from '@tapflowio/flow-runner/browser'
import { canGoTo, initialState, reduce, stepIndex, type CaptureState } from '@/lib/flowCapture/machine'
import { editedCapture, fileNameOf, flowOf, moveEdge, yamlOf } from '@/lib/flowCapture/flow'

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
  const state = { captured, removed: [2], renamed: { PASSWORD: 'LOGIN_PASSWORD' }, name: 'Sign in', tags: 'smoke, login' }

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
