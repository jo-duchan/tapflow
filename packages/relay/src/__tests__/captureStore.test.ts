import { describe, it, expect, vi, afterEach } from 'vitest'
import { CaptureStore, FIELD_IDLE_MS, HOME_READ_MS, HOME_READS, KEYBOARD_SETTLE_MS, SNAPSHOT_READ_WAIT_MS, type CapturedMessage, type FieldRead, type Holder } from '../capture/CaptureStore'
import type { KeyboardState } from '@tapflowio/protocol'
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

  it('keeps each gesture\'s last move, which is where the finger lifted', () => {
    // The dashboard's end carries no point. Thinned by alternation across the whole capture, a two-move flick lost
    // its last move about half the time and read as a tap.
    const { s } = store({ maxEntries: 40 })
    for (let i = 0; i < 15; i++) {
      s.recordInput('s', ALICE, tap(`r${i}`)[0]!)
      s.recordInput('s', ALICE, move(0.4))
      s.recordInput('s', ALICE, move(0.2 + i / 100))
      s.recordInput('s', ALICE, tap(`r${i}`)[1]!)
    }
    const entries = s.takeSnapshot('s', '1')!.entries
    expect(entries.length).toBeLessThanOrEqual(40)
    const lifts = entries.flatMap((e, i) => {
      if (e.kind !== 'input' || e.msg.type !== 'input:touch:end') return []
      const before = entries[i - 1]
      return before?.kind === 'input' && before.msg.type === 'input:touch:move' ? [before.msg.payload.y] : []
    })
    // Every gesture the cut kept still ends on its own last move.
    const ends = entries.filter((e) => e.kind === 'input' && e.msg.type === 'input:touch:end').length
    expect(ends).toBeGreaterThan(0)
    expect(lifts).toHaveLength(ends)
    expect(lifts.at(-1)).toBeCloseTo(0.34)
  })

  it('keeps each gesture\'s first move, whose time tells a swipe from a drag after a hold', () => {
    const { s } = store({ maxEntries: 40 })
    for (let i = 0; i < 6; i++) {
      s.recordInput('s', ALICE, tap(`r${i}`)[0]!)
      for (let k = 0; k < 8; k++) s.recordInput('s', ALICE, move(0.6 - k / 100 - i / 1000))
      s.recordInput('s', ALICE, tap(`r${i}`)[1]!)
    }
    const entries = s.takeSnapshot('s', '1')!.entries
    expect(s.takeSnapshot('s', '1')!.thinned).toBe(true)
    // Every start the cut kept is still followed by that gesture's first move.
    const firsts = entries.flatMap((e, i) => e.kind === 'input' && e.msg.type === 'input:touch:start' ? [entries[i + 1]] : [])
    expect(firsts.length).toBeGreaterThan(0)
    for (const f of firsts) expect(f?.kind === 'input' && f.msg.type === 'input:touch:move' && f.msg.payload.y).toBeGreaterThan(0.59)
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

describe('reading the field a person typed into (#1135)', () => {
  afterEach(() => { vi.useRealTimers() })

  const key = (code: string, requestId = code): CapturedMessage => ({ type: 'input:key', sessionId: 's', requestId, payload: { code, modifiers: 0 } })
  const field = { identifier: 'form.email', placeholder: 'Email', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false }

  // A clock and timers that move together; each read answers `answer` after `lagMs`.
  function typingStore(answer: () => FieldRead = () => ({ field: { ...field, value: 'ab' } }), lagMs = 50) {
    vi.useFakeTimers()
    const asked: number[] = []
    const { s, tick } = store({
      now: () => Date.now(),
      readField: () => { asked.push(Date.now()); return new Promise((r) => setTimeout(() => r(answer()), lagMs)) },
    })
    const wait = async (ms: number) => { tick(ms); await vi.advanceTimersByTimeAsync(ms) }
    return { s, asked, wait }
  }
  const reads = (s: CaptureStore) => entries(s).flatMap((e) => (e.kind === 'field' ? [e] : []))

  it('reads which field at the first key, and what it holds once typing pauses', async () => {
    const { s, wait } = typingStore()
    s.recordInput('s', ALICE, key('KeyA'))
    await wait(100)
    s.recordInput('s', ALICE, key('KeyB'))
    await wait(FIELD_IDLE_MS + 100)
    expect(reads(s).map((r) => r.phase)).toEqual(['focus', 'value'])
    const [, value] = reads(s)
    // Asked after the last key, answered after it was asked: what lets a reader judge the read.
    expect(value!.requestedAt).toBeGreaterThan(entries(s).filter((e) => e.kind === 'input').at(-1)!.at)
    expect(value!.at).toBeGreaterThan(value!.requestedAt)
    expect(value!.field?.value).toBe('ab')
  })

  it('reads the value once per pause, and an edit key restarts the pause', async () => {
    const { s, asked, wait } = typingStore()
    s.recordInput('s', ALICE, key('KeyA'))
    await wait(FIELD_IDLE_MS - 100)
    s.recordInput('s', ALICE, key('Backspace'))
    await wait(FIELD_IDLE_MS - 100)
    expect(asked).toHaveLength(1)
    await wait(200)
    expect(asked).toHaveLength(2)
  })

  // Review: one value read per key at a 250 ms pause queued on the iOS runner (0.45 s a read), and the last answered
  // after the next input. One at a time; one asked meanwhile is made when it answers, still after the last key.
  it('reads the value one at a time, and once more after the last key if keys came while one was out', async () => {
    const { s, asked, wait } = typingStore(undefined, 450)
    s.recordInput('s', ALICE, key('KeyA'))
    await wait(FIELD_IDLE_MS + 10)                      // focus read + value read 1 out
    s.recordInput('s', ALICE, key('KeyB'))
    await wait(FIELD_IDLE_MS + 10)                      // value read 2 asked while 1 is out: held
    expect(asked).toHaveLength(2)
    await wait(500)                                     // 1 answers, the held one goes
    expect(asked).toHaveLength(3)
    const last = reads(s).filter((r) => r.phase === 'value').at(-1)
    await wait(500)
    expect(reads(s).filter((r) => r.phase === 'value').at(-1)!.requestedAt)
      .toBeGreaterThan(entries(s).filter((e) => e.kind === 'input').at(-1)!.at)
    expect(last).toBeDefined()
  })

  it('ends the run at any other input: no read after it, and the next key asks which field again', async () => {
    const { s, wait } = typingStore()
    s.recordInput('s', ALICE, key('KeyA'))
    await wait(100)
    for (const m of tap()) s.recordInput('s', ALICE, m)
    await wait(FIELD_IDLE_MS + 100)
    expect(reads(s).map((r) => r.phase)).toEqual(['focus'])
    s.recordInput('s', ALICE, key('KeyC'))
    await wait(FIELD_IDLE_MS + 100)
    expect(reads(s).map((r) => r.phase)).toEqual(['focus', 'focus', 'value'])
  })

  it('asks again which field at the key after Tab, Enter or a chord, which move focus or act on the app', async () => {
    const { s, wait } = typingStore()
    for (const end of ['Tab', 'Enter', 'Escape']) {
      s.recordInput('s', ALICE, key('KeyA', `a-${end}`))
      await wait(100)
      s.recordInput('s', ALICE, key(end))
      await wait(100)
    }
    s.recordInput('s', ALICE, key('KeyA', 'a-chord'))
    await wait(100)
    s.recordInput('s', ALICE, { type: 'input:key', sessionId: 's', requestId: 'chord', payload: { code: 'KeyV', modifiers: 0x08 } })
    await wait(100)
    s.recordInput('s', ALICE, key('KeyB'))
    await wait(100)
    expect(reads(s).filter((r) => r.phase === 'focus')).toHaveLength(5)
  })

  it('asks which field at the very time of the first key, so a one-key run still owns its read', async () => {
    vi.useFakeTimers()
    // A clock that moves on every reading, as one does across the work between recording a key and asking.
    let t = 1_000
    const { s } = store({ now: () => t++, readField: () => Promise.resolve({ field: null }) })
    s.recordInput('s', ALICE, key('KeyA'))
    await vi.advanceTimersByTimeAsync(10)
    const [input] = entries(s).filter((e) => e.kind === 'input')
    expect(reads(s)[0]!.requestedAt).toBe(input!.at)
  })

  it('keeps no read that answers after the person stopped being recorded', async () => {
    const { s, wait } = typingStore(undefined, 300)
    s.recordInput('s', ALICE, key('KeyA'))
    s.pause('s', '1')
    await wait(FIELD_IDLE_MS + 400)
    s.resume('s', '1')
    expect(reads(s)).toEqual([])
  })

  it('asks nothing when the agent cannot answer, and nothing for a person not recorded', async () => {
    vi.useFakeTimers()
    const readField = vi.fn(() => null)
    const { s } = store({ readField })
    s.recordInput('s', ALICE, key('KeyA'))
    await vi.advanceTimersByTimeAsync(FIELD_IDLE_MS + 100)
    expect(reads(s)).toEqual([])
    const asked = vi.fn(() => Promise.resolve({ field: null }))
    const other = store({ readField: asked }, new Set())
    other.s.recordInput('s', ALICE, key('KeyA'))
    await vi.advanceTimersByTimeAsync(FIELD_IDLE_MS + 100)
    expect(asked).not.toHaveBeenCalled()
  })

  it('before a snapshot, reads a field still being typed in and waits for the answer', async () => {
    const { s, wait } = typingStore()
    s.recordInput('s', ALICE, key('KeyA'))
    await wait(100)
    const settled = s.settleReads('s', '1')
    await wait(60)
    await settled
    expect(reads(s).map((r) => r.phase)).toEqual(['focus', 'value'])
  })

  it('does not wait past its bound for a read that never answers', async () => {
    vi.useFakeTimers()
    const { s } = store({ readField: () => new Promise(() => {}) })
    s.recordInput('s', ALICE, key('KeyA'))
    let done = false
    void s.settleReads('s', '1').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(SNAPSHOT_READ_WAIT_MS - 10)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(done).toBe(true)
  })
})

describe('reading the soft keyboard around a person\'s inputs (#1135)', () => {
  afterEach(() => { vi.useRealTimers() })

  const SHOWN: KeyboardState = { shown: true, rect: { x: 0, y: 0.6, width: 1, height: 0.4 }, frameRect: { x: 0.6, y: 0, width: 0.4, height: 1 } }
  const at = (x: number, y: number, requestId = 'k', space?: 'frame'): CapturedMessage[] => [
    { type: 'input:touch:start', sessionId: 's', payload: { x, y, ...(space ? { space } : {}) } },
    { type: 'input:touch:end', sessionId: 's', requestId, payload: { x, y } },
  ]

  // Keyboard reads answer `state()` after `lagMs`; field reads answer at once.
  function keyboardStore(state: () => KeyboardState = () => SHOWN, lagMs = 20) {
    vi.useFakeTimers()
    const asked: number[] = []
    const fieldAsked: string[] = []
    const { s, tick } = store({
      now: () => Date.now(),
      readKeyboard: () => { asked.push(Date.now()); return new Promise((r) => setTimeout(() => r(state()), lagMs)) },
      readField: () => { fieldAsked.push('read'); return Promise.resolve({ field: null, reason: 'no-focus' }) },
    })
    const wait = async (ms: number) => { tick(ms); await vi.advanceTimersByTimeAsync(ms) }
    return { s, asked, fieldAsked, wait }
  }
  const kbReads = (s: CaptureStore) => entries(s).flatMap((e) => (e.kind === 'keyboard' ? [e] : []))
  const fieldReads = (s: CaptureStore) => entries(s).flatMap((e) => (e.kind === 'field' ? [e] : []))

  it('reads the keyboard after a gesture ends, not at its start or moves', async () => {
    const { s, asked, wait } = keyboardStore()
    s.recordInput('s', ALICE, { type: 'input:touch:start', sessionId: 's', payload: { x: 0.5, y: 0.5 } })
    s.recordInput('s', ALICE, move(0.4))
    await wait(50)
    expect(asked).toHaveLength(0)
    s.recordInput('s', ALICE, { type: 'input:touch:end', sessionId: 's', requestId: 'e', payload: { x: 0.5, y: 0.4 } })
    await wait(30)
    expect(asked).toHaveLength(1)
    const [read] = kbReads(s)
    expect(read!.requestedAt).toBeGreaterThanOrEqual(entries(s).filter((e) => e.kind === 'input').at(-1)!.at)
    expect(read).toMatchObject({ keyboard: SHOWN, settled: false })
  })

  it('reads one at a time: inputs while one is out ask for one more, not one each', async () => {
    const { s, asked, wait } = keyboardStore(undefined, 100)
    s.recordInput('s', ALICE, launch)
    await wait(10)
    for (const k of ['KeyA', 'KeyB', 'KeyC']) s.recordInput('s', ALICE, { type: 'input:key', sessionId: 's', requestId: k, payload: { code: k } })
    await wait(95)
    expect(asked).toHaveLength(2)
    await wait(100)
    expect(asked).toHaveLength(2)
  })

  it('reads again once the person stops, and marks the read that matches the one before it settled', async () => {
    const { s, asked, wait } = keyboardStore()
    s.recordInput('s', ALICE, launch)
    await wait(30 + KEYBOARD_SETTLE_MS + 30)
    expect(asked).toHaveLength(2)
    expect(kbReads(s).map((r) => r.settled)).toEqual([false, true])
    await wait(KEYBOARD_SETTLE_MS * 3)
    expect(asked).toHaveLength(2)
  })

  it('stops reading a keyboard that never comes to rest', async () => {
    let y = 0.6
    const { s, asked, wait } = keyboardStore(() => ({ shown: true, rect: { x: 0, y: (y -= 0.05), width: 1, height: 0.4 } }))
    s.recordInput('s', ALICE, launch)
    await wait(10 * (KEYBOARD_SETTLE_MS + 30))
    expect(asked).toHaveLength(4)
    expect(kbReads(s).every((r) => !r.settled)).toBe(true)
  })

  // An app opened from its icon can take seconds to come up. Reads that stopped while the home screen was still in front
  // would leave it as the last word before the first tap in the app, and the default range would leave that tap out.
  it('keeps reading while the home screen is in front, until the app comes up', async () => {
    let home = true
    const { s, asked, wait } = keyboardStore(() => (home ? { shown: null, onHome: true } : { shown: false, onHome: false }))
    s.recordInput('s', ALICE, launch)
    await wait(30 + 4 * (HOME_READ_MS + 30))
    expect(asked.length).toBeGreaterThan(4)
    home = false
    await wait(HOME_READ_MS + 30)
    expect(kbReads(s).at(-1)!.keyboard).toEqual({ shown: false, onHome: false })
    // The app's own keyboard then gets the reads it needs to settle: an app that opens a field at launch shows it late.
    await wait(KEYBOARD_SETTLE_MS * 4)
    expect(kbReads(s).at(-1)).toMatchObject({ keyboard: { shown: false, onHome: false }, settled: true })
    const after = asked.length
    await wait(KEYBOARD_SETTLE_MS * 4)
    expect(asked).toHaveLength(after)
  })

  // Measured shape: the install is recorded as it is sent, and the read it starts answers in ~30 ms about the screen
  // before it — the previous build, open. Without a read after the install is done, that is the last word before the
  // person's swipe on the home screen.
  it('reads again once an install or launch is done', async () => {
    let screen: KeyboardState = { shown: false, onHome: false }
    const { s, wait } = keyboardStore(() => screen)
    const install: CapturedMessage = { type: 'app:install', sessionId: 's', requestId: 'i', buildId: 1 }
    s.recordInput('s', ALICE, install)
    await wait(30 + 3 * (KEYBOARD_SETTLE_MS + 30))
    screen = { shown: false, onHome: true }
    s.noteAppDone('s', ALICE, 'i')
    await wait(30)
    expect(kbReads(s).at(-1)!.keyboard).toEqual({ shown: false, onHome: true })
  })

  it('reads nothing again for a request that changes no app', async () => {
    const { s, asked, wait } = keyboardStore()
    for (const m of at(0.5, 0.3, 't')) s.recordInput('s', ALICE, m)
    await wait(30 + 3 * (KEYBOARD_SETTLE_MS + 30))
    const before = asked.length
    s.noteAppDone('s', ALICE, 't')
    await wait(KEYBOARD_SETTLE_MS * 2)
    expect(asked).toHaveLength(before)
  })

  it('stops reading a screen that keeps flipping between home and an app', async () => {
    let n = 0
    const { s, asked, wait } = keyboardStore(() => (n++ % 2 ? { shown: false, onHome: false } : { shown: false, onHome: true }))
    s.recordInput('s', ALICE, launch)
    await wait(HOME_READS * (HOME_READ_MS + 30) * 4)
    expect(asked.length).toBeLessThanOrEqual(HOME_READS + 4)
  })

  it('stops reading a home screen nobody leaves', async () => {
    const { s, asked, wait } = keyboardStore(() => ({ shown: false, onHome: true }))
    s.recordInput('s', ALICE, launch)
    await wait(HOME_READS * (HOME_READ_MS + 30) * 2)
    expect(asked).toHaveLength(HOME_READS + 1)
  })

  it('takes a tap that starts on the keyboard as typing: one focus read, and the value read after the pause', async () => {
    const { s, wait } = keyboardStore()
    s.recordInput('s', ALICE, launch)
    await wait(30)
    for (const [i, m] of [...at(0.2, 0.8, 'a'), ...at(0.5, 0.8, 'b'), ...at(0.7, 0.9, 'c')].entries()) {
      s.recordInput('s', ALICE, m)
      if (i % 2) await wait(120)
    }
    await wait(FIELD_IDLE_MS + 50)
    expect(fieldReads(s).map((r) => r.phase)).toEqual(['focus', 'value'])
  })

  it('judges a point sent in the frame\'s space by the keyboard in that space', async () => {
    const { s, wait } = keyboardStore()
    s.recordInput('s', ALICE, launch)
    await wait(30)
    // On the screen's keyboard (y 0.6–1) but not on the frame's (x 0.6–1): a frame point, so not a key.
    for (const m of at(0.2, 0.8, 'f', 'frame')) s.recordInput('s', ALICE, m)
    await wait(FIELD_IDLE_MS + 50)
    expect(fieldReads(s)).toEqual([])
    for (const m of at(0.8, 0.2, 'g', 'frame')) s.recordInput('s', ALICE, m)
    await wait(FIELD_IDLE_MS + 50)
    expect(fieldReads(s).map((r) => r.phase)).toEqual(['focus', 'value'])
  })

  it('ends the run at a tap off the keyboard, and at any tap while the keyboard is hidden or unknown', async () => {
    // A hidden keyboard is not typed on, whatever rect it last had.
    for (const state of [SHOWN, { shown: false }, { shown: null }, { shown: false, rect: SHOWN.rect }] as KeyboardState[]) {
      const { s, wait } = keyboardStore(() => state)
      s.recordInput('s', ALICE, launch)
      await wait(30)
      s.recordInput('s', ALICE, { type: 'input:key', sessionId: 's', requestId: 'a', payload: { code: 'KeyA' } })
      await wait(100)
      for (const m of at(0.5, state === SHOWN ? 0.3 : 0.8, 't')) s.recordInput('s', ALICE, m)
      await wait(FIELD_IDLE_MS + 50)
      expect(fieldReads(s).map((r) => r.phase)).toEqual(['focus'])
      vi.useRealTimers()
    }
  })

  it('reads nothing while a replay holds the pause, nor for an agent that cannot answer', async () => {
    const { s, asked, wait } = keyboardStore()
    s.recordInput('s', ALICE, launch)
    await wait(30 + KEYBOARD_SETTLE_MS + 30)
    const before = asked.length
    s.pause('s', '1')
    for (const m of at(0.5, 0.8)) s.recordInput('s', ALICE, m)
    await wait(KEYBOARD_SETTLE_MS * 2)
    expect(asked).toHaveLength(before)
    vi.useRealTimers()
    vi.useFakeTimers()
    const readKeyboard = vi.fn(() => null)
    const quiet = store({ readKeyboard })
    for (const m of at(0.5, 0.8)) quiet.s.recordInput('s', ALICE, m)
    await vi.advanceTimersByTimeAsync(KEYBOARD_SETTLE_MS * 2)
    expect(kbReads(quiet.s)).toEqual([])
  })

  it('before a snapshot, takes the settling read at once and waits for it', async () => {
    let n = 0
    const { s, wait } = keyboardStore(() => (n++ === 0 ? SHOWN : { shown: false }))
    s.recordInput('s', ALICE, launch)
    await wait(30)
    const settled = s.settleReads('s', '1')
    await wait(30)
    await settled
    expect(kbReads(s).map((r) => [r.keyboard.shown, r.settled])).toEqual([[true, false], [false, false]])
  })

  it('keeps no keyboard read that answers after a replay took the pause', async () => {
    const { s, wait } = keyboardStore(undefined, 100)
    s.recordInput('s', ALICE, launch)
    await wait(10)
    s.pause('s', '1')
    await wait(KEYBOARD_SETTLE_MS * 2)
    s.resume('s', '1')
    expect(kbReads(s)).toEqual([])
  })

  it('keeps the keyboard and its language beside a field read', async () => {
    vi.useFakeTimers()
    const { s } = store({
      readField: () => Promise.resolve({ field: null, reason: 'no-focus', keyboard: SHOWN, language: '한국어 (두벌식)' }),
    })
    s.recordInput('s', ALICE, { type: 'input:key', sessionId: 's', requestId: 'a', payload: { code: 'KeyA' } })
    await vi.advanceTimersByTimeAsync(10)
    expect(fieldReads(s)[0]).toMatchObject({ keyboard: SHOWN, language: '한국어 (두벌식)' })
  })
})
