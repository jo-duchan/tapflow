import { describe, it, expect } from 'vitest'
import { CaptureStore, type CapturedMessage, type Holder } from '../capture/CaptureStore'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import type { ChromePayload } from '@tapflowio/protocol'

// The rules of Flow Capture's in-memory record (#1125). `flowCaptureRelay.test.ts` holds the wiring through the relay.

const ALICE: Holder = { kind: 'dashboard', user: '1' }
const BOB: Holder = { kind: 'dashboard', user: '2' }

function store(over: Partial<ConstructorParameters<typeof CaptureStore>[0]> = {}, enabled = new Set(['1', '2'])) {
  let t = 1_000
  const s = new CaptureStore({ isEnabled: (u) => enabled.has(u), now: () => t, ...over })
  return { s, tick: (ms: number) => { t += ms }, enabled }
}

const tap = (requestId = 'r1'): CapturedMessage[] => [
  { type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } },
  { type: 'input:touch:end', sessionId: 's', requestId, payload: { x: 0.5, y: 0.5 } },
]
const move = (y: number): CapturedMessage => ({ type: 'input:touch:move', sessionId: 's', payload: { x: 0.5, y } })
const launch: CapturedMessage = { type: 'app:launch', sessionId: 's', requestId: 'l', buildId: 1 }

const entries = (s: CaptureStore, user = '1') => s.takeSnapshot('s', user)?.entries ?? []
const types = (s: CaptureStore) => entries(s).map((e) => (e.kind === 'input' ? e.msg.type : e.kind))

describe('what is recorded', () => {
  it('keeps a person\'s inputs in order, stamped with the relay\'s clock', () => {
    const { s, tick } = store()
    const [start, end] = tap()
    s.recordInput('s', ALICE, start!)
    tick(80)
    s.recordInput('s', ALICE, end!)
    expect(entries(s).map((e) => e.at)).toEqual([1_000, 1_080])
    expect(types(s)).toEqual(['input:touch:start', 'input:touch:end'])
  })

  it.each([
    ['an automation client', { kind: 'flow-runner', user: '1' }],
    ['MCP (PR2)', { kind: 'mcp', user: '1' }],
    ['a client that declared nothing', { kind: null, user: '1' }],
    ['an anonymous loopback socket', { kind: 'dashboard', user: 'anon' }],
    ['an unidentified socket', { kind: 'dashboard', user: 'unidentified:x' }],
  ] as const)('records nothing for %s', (_name, holder) => {
    // Every one of these users has capturing on, so only the holder itself can be what refuses it.
    const { s } = store({}, new Set(['1', 'anon', 'unidentified:x']))
    for (const m of tap()) s.recordInput('s', holder as Holder, m)
    expect(s.takeSnapshot('s', holder.user ?? '')).toBeNull()
  })

  it('keeps a paste and a cut, not a copy or a clipboard write that only fills the clipboard', () => {
    const { s } = store()
    s.recordInput('s', ALICE, { type: 'clipboard:write', sessionId: 's', requestId: 'a', payload: { text: 'x' } })
    s.recordInput('s', ALICE, { type: 'clipboard:write', sessionId: 's', requestId: 'b', payload: { text: 'x', pasteAfter: true } })
    s.recordInput('s', ALICE, { type: 'clipboard:read', sessionId: 's', requestId: 'c', payload: { press: 'copy' } })
    s.recordInput('s', ALICE, { type: 'clipboard:read', sessionId: 's', requestId: 'd' })
    s.recordInput('s', ALICE, { type: 'clipboard:read', sessionId: 's', requestId: 'e', payload: { press: 'cut' } })
    expect(entries(s).map((e) => e.kind === 'input' && 'requestId' in e.msg && e.msg.requestId)).toEqual(['b', 'e'])
  })

  it('records the agent\'s answer to an input, and a chrome change', () => {
    const { s } = store()
    for (const m of tap('r9')) s.recordInput('s', ALICE, m)
    s.recordAck('s', ALICE, 'r9', false)
    s.recordChrome('s', ALICE, { platform: 'ios' })
    expect(entries(s).slice(2)).toEqual([
      { at: 1_000, kind: 'ack', requestId: 'r9', ok: false },
      { at: 1_000, kind: 'chrome', chrome: { platform: 'ios' } },
    ])
  })

  it('records nothing for a person who turned it off', () => {
    const { s } = store()
    for (const m of tap()) s.recordInput('s', { kind: 'dashboard', user: '3' }, m)
    expect(s.takeSnapshot('s', '3')).toBeNull()
  })

  it('starts with the chrome the relay holds, so its first points have a frame', () => {
    const { s } = store({ chromeOf: () => ({ streamRotation: 90 }) })
    s.recordInput('s', ALICE, tap()[0]!)
    expect(entries(s)[0]).toMatchObject({ kind: 'chrome', chrome: { streamRotation: 90 } })
  })

  // A bezel is hundreds of kilobytes of base64; kept, every turn would eat the budget and push out the steps.
  it('keeps the chrome\'s geometry and drops its pictures, on both ways in', () => {
    const iosChrome = {
      framePng: 'x'.repeat(200_000), streamRotation: 90, screenCornerRadius: 40,
      buttons: [{ name: 'action', buttonPng: 'y'.repeat(10_000), pressedPng: 'z'.repeat(10_000), anchor: 'left' }],
    }
    const { s } = store({ chromeOf: () => iosChrome })
    s.recordInput('s', ALICE, tap()[0]!)
    s.recordChrome('s', ALICE, iosChrome)
    for (const e of entries(s).filter((x) => x.kind === 'chrome')) {
      const chrome = (e as { chrome: Record<string, unknown> }).chrome
      expect(chrome).toMatchObject({ framePng: '', streamRotation: 90, screenCornerRadius: 40, buttons: [{ name: 'action', anchor: 'left' }] })
      expect(JSON.stringify(chrome).length).toBeLessThan(500)
      // Still read as iOS chrome: the key is what says so.
      expect(chromeOrientation(chrome as unknown as ChromePayload)).toBe('landscape')
    }
    expect(iosChrome.framePng).toHaveLength(200_000)
  })

  it('never throws into the input path', () => {
    const { s } = store({ isEnabled: () => { throw new Error('db gone') } })
    expect(() => s.recordInput('s', ALICE, tap()[0]!)).not.toThrow()
    expect(() => s.recordAck('s', ALICE, 'r', true)).not.toThrow()
    expect(() => s.recordChrome('s', ALICE, {})).not.toThrow()
  })
})

describe('when a capture ends', () => {
  it('survives the same person coming back in a dashboard', () => {
    const { s } = store()
    for (const m of tap()) s.recordInput('s', ALICE, m)
    s.noteJoin('s', ALICE)
    expect(entries(s)).toHaveLength(2)
  })

  it.each([
    ['someone else', BOB],
    ['the same person\'s flow run', { kind: 'flow-runner', user: '1' }],
    ['the same person\'s MCP client', { kind: 'mcp', user: '1' }],
  ] as const)('is sealed when %s joins', (_name, holder) => {
    const { s } = store()
    for (const m of tap()) s.recordInput('s', ALICE, m)
    s.noteJoin('s', holder as Holder)
    expect(s.takeSnapshot('s', '1')).toBeNull()
  })

  it('is sealed for every session of a person who turns capturing off', () => {
    const { s } = store()
    s.recordInput('a', ALICE, tap()[0]!)
    s.recordInput('b', ALICE, tap()[0]!)
    s.recordInput('c', BOB, tap()[0]!)
    s.sealUser('1')
    expect([s.takeSnapshot('a', '1'), s.takeSnapshot('b', '1')]).toEqual([null, null])
    expect(s.takeSnapshot('c', '2')).not.toBeNull()
  })

  it('starts afresh after a seal', () => {
    const { s } = store()
    s.recordInput('s', ALICE, launch)
    s.seal('s')
    for (const m of tap()) s.recordInput('s', ALICE, m)
    expect(types(s)).toEqual(['input:touch:start', 'input:touch:end'])
  })

  it('is answered only to its owner', () => {
    const { s } = store()
    s.recordInput('s', ALICE, launch)
    expect(s.takeSnapshot('s', '2')).toBeNull()
    expect(s.pause('s', '2')).toBe(false)
    expect(s.dropSnapshot('s', '2')).toBe(false)
  })
})

describe('the replay pause', () => {
  it('records nothing while held and keeps the snapshot as it was taken', () => {
    const { s } = store()
    s.recordInput('s', ALICE, launch)
    const snap = s.takeSnapshot('s', '1')!
    expect(s.pause('s', '1')).toBe(true)
    for (const m of tap()) s.recordInput('s', ALICE, m)
    s.recordAck('s', ALICE, 'r1', true)
    expect(s.resume('s', '1')).toBe(true)
    expect(s.snapshot('s', '1')).toEqual(snap)
    s.recordInput('s', ALICE, tap()[0]!)
    expect(types(s)).toEqual(['app:launch', 'input:touch:start'])
  })

  it('runs out on its own when nobody renews it, and a renewal extends it', () => {
    const { s, tick } = store({ pauseTtlMs: 100 })
    s.recordInput('s', ALICE, launch)
    s.pause('s', '1')
    tick(90)
    s.pause('s', '1')
    tick(90)
    s.recordInput('s', ALICE, tap()[0]!)
    expect(types(s)).toEqual(['app:launch'])
    tick(20)
    s.recordInput('s', ALICE, tap()[0]!)
    expect(types(s)).toEqual(['app:launch', 'input:touch:start'])
  })

  it('cannot be released by someone else, and goes with a seal', () => {
    const { s } = store()
    s.recordInput('s', ALICE, launch)
    s.pause('s', '1')
    expect(s.resume('s', '2')).toBe(false)
    s.seal('s')
    s.recordInput('s', ALICE, launch)
    expect(types(s)).toEqual(['app:launch'])
  })
})

describe('the budget', () => {
  it('thins moves first and keeps every gesture\'s ends', () => {
    const { s } = store({ maxEntries: 40 })
    s.recordInput('s', ALICE, tap()[0]!)
    for (let i = 0; i < 60; i++) s.recordInput('s', ALICE, move(i / 100))
    s.recordInput('s', ALICE, tap()[1]!)
    const t = types(s)
    expect(t[0]).toBe('input:touch:start')
    expect(t.at(-1)).toBe('input:touch:end')
    expect(t.length).toBeLessThanOrEqual(40)
    expect(s.takeSnapshot('s', '1')!.thinned).toBe(true)
  })

  it('then cuts whole gestures off the head and never drops a launch', () => {
    const { s } = store({ maxEntries: 20 })
    s.recordInput('s', ALICE, launch)
    for (let i = 0; i < 30; i++) for (const m of tap(`r${i}`)) s.recordInput('s', ALICE, m)
    const t = types(s)
    expect(t[0]).toBe('app:launch')
    // After the anchor, the first kept entry opens a gesture rather than ending one.
    expect(t[1]).toBe('input:touch:start')
    expect(t.length).toBeLessThanOrEqual(20)
  })

  // No moves to thin, so the head is cut — and one key ahead of the taps puts the cut on a tap's end. It must move on
  // to where a gesture begins rather than keep an end with no start.
  it('never keeps the end of a gesture whose start it cut', () => {
    const { s } = store({ maxEntries: 20 })
    s.recordInput('s', ALICE, { type: 'input:key', sessionId: 's', requestId: 'k', payload: { code: 'KeyA', modifiers: 0 } })
    for (let i = 0; i < 10; i++) for (const m of tap(`r${i}`)) s.recordInput('s', ALICE, m)
    expect(types(s)[0]).toBe('input:touch:start')
  })

  // A turn early on, then enough taps to cut it off the head: the points that are left are still in its frame.
  it('keeps the last chrome before a head cut', () => {
    const { s } = store({ maxEntries: 20 })
    s.recordChrome('s', ALICE, { turn: 0 })
    s.recordChrome('s', ALICE, { turn: 90 })
    for (let i = 0; i < 12; i++) for (const m of tap(`r${i}`)) s.recordInput('s', ALICE, m)
    const kept = entries(s).filter((e) => e.kind === 'chrome')
    expect(kept).toEqual([expect.objectContaining({ chrome: { turn: 90 } })])
  })

  it('bounds every capture together, trimming the largest', () => {
    const { s } = store({ maxTotalBytes: 6_000 })
    for (let i = 0; i < 40; i++) s.recordInput('a', ALICE, move(i / 100))
    for (let i = 0; i < 40; i++) s.recordInput('b', BOB, move(i / 100))
    const a = s.takeSnapshot('a', '1')!.entries.length
    const b = s.takeSnapshot('b', '2')!.entries.length
    expect(a + b).toBeLessThan(80)
  })
})
