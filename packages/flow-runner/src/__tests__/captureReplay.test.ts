import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BrowserToRelay } from '@tapflowio/protocol'
import type { CaptureEntry } from '@tapflowio/protocol/capture'
import { SessionChannel, type RelayMsg } from '../sessionChannel.js'
import { SessionLeftError, InputRefusedError } from '../sessionErrors.js'
import { segment, replayStep, replaySteps, rangeStartOrientation } from '../capture/index.js'

class MemoryChannel extends SessionChannel {
  readonly sent: Array<{ t: number; msg: BrowserToRelay }> = []
  ack: 'done' | 'error' | null = 'done'
  typeAck: 'done' | 'error' | null = 'done'
  drop(): void { this.connectionLost('the test dropped it') }
  protected send(msg: BrowserToRelay): void {
    this.sent.push({ t: Date.now(), msg })
    const id = 'requestId' in msg ? msg.requestId : undefined
    if (!id || !('sessionId' in msg)) return
    const sessionId = msg.sessionId
    const reply: RelayMsg | null = msg.type === 'input:type'
      ? (this.typeAck === 'done' ? { type: 'input:type-done', sessionId, requestId: id }
        : this.typeAck === 'error' ? { type: 'input:type-error', sessionId, requestId: id, reason: 'failed', message: 'not ASCII' } : null)
      : msg.type.startsWith('input:')
      ? (this.ack === 'done' ? { type: 'input:done', sessionId, requestId: id }
        : this.ack === 'error' ? { type: 'input:error', sessionId, requestId: id, reason: 'failed', message: 'no' } : null)
      : msg.type === 'clipboard:write' ? { type: 'clipboard:write-done', sessionId, requestId: id }
        : msg.type === 'app:install' ? { type: 'app:install-done', sessionId, requestId: id }
          : msg.type === 'app:launch' ? { type: 'app:launch-done', sessionId, requestId: id }
            : null
    if (reply) queueMicrotask(() => this.dispatch(reply))
  }
}

const recorded = (entries: Array<[number, Record<string, unknown>]>): CaptureEntry[] =>
  entries.map(([at, msg]) => ({ at, kind: 'input', msg: { sessionId: 'old', ...msg } as never }))

afterEach(() => { vi.useRealTimers() })

describe('replayStep', () => {
  // Review of #1125: typing waits up to 15 s for the agent; Stop during a text step sat out that wait.
  it('gives up waiting on typed text when the replay is stopped', async () => {
    const [text] = segment(recorded([[1000, { type: 'input:key', requestId: 'k', payload: { code: 'KeyA', modifiers: 0 } }]]))
    const ch = new MemoryChannel()
    ch.typeAck = null
    const stop = new AbortController()
    const done = replayStep(ch, 'now', text!, stop.signal)
    const outcome = expect(done).rejects.toBeDefined()
    stop.abort()
    await outcome
  })

  it('sends a swipe as recorded, at its pace, on this session with new correlators', async () => {
    vi.useFakeTimers()
    const [swipe] = segment(recorded([
      [1000, { type: 'input:touch:start', payload: { x: 0.5, y: 0.8, space: 'frame' } }],
      [1016, { type: 'input:touch:move', payload: { x: 0.5, y: 0.6, space: 'frame' } }],
      [1100, { type: 'input:touch:move', payload: { x: 0.5, y: 0.3, space: 'frame' } }],
      [1160, { type: 'input:touch:end', requestId: 'old-id' }],
    ]))
    const ch = new MemoryChannel()
    const start = Date.now()
    const done = replayStep(ch, 'now', swipe!)
    await vi.advanceTimersByTimeAsync(200)
    await expect(done).resolves.toBe('replayed')
    expect(ch.sent.map((s) => [s.msg.type, s.t - start])).toEqual([
      ['input:touch:start', 0], ['input:touch:move', 16], ['input:touch:move', 100], ['input:touch:end', 160],
    ])
    expect(ch.sent.every((s) => 'sessionId' in s.msg && s.msg.sessionId === 'now')).toBe(true)
    const end = ch.sent[3]!.msg as { requestId: string }
    expect(end.requestId).not.toBe('old-id')
    // The frame's space rides along: the agent places the point by the frame it holds now.
    expect(ch.sent[0]!.msg).toMatchObject({ payload: { space: 'frame' } })
  })

  it('ends a gesture it was stopped in the middle of, and says so', async () => {
    vi.useFakeTimers()
    const [hold] = segment(recorded([
      [0, { type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } }],
      [900, { type: 'input:touch:end', requestId: 'x' }],
    ]))
    const ch = new MemoryChannel()
    const abort = new AbortController()
    const done = replayStep(ch, 's', hold!, abort.signal).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300)
    abort.abort()
    await vi.advanceTimersByTimeAsync(700)
    expect(await done).toBeInstanceOf(SessionLeftError)
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:touch:start', 'input:touch:cancel', 'input:touch:end'])
  })

  it('ends a long hold as soon as it is cancelled, not when the hold would have ended', async () => {
    vi.useFakeTimers()
    const [hold] = segment(recorded([
      [0, { type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } }],
      [30_000, { type: 'input:touch:end', requestId: 'x' }],
    ]))
    const ch = new MemoryChannel()
    const abort = new AbortController()
    const done = replayStep(ch, 's', hold!, abort.signal).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    abort.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(await done).toBeInstanceOf(SessionLeftError)
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:touch:start', 'input:touch:cancel', 'input:touch:end'])
  })

  it('sends nothing after a cancel, a clear-state least of all', async () => {
    const [clear] = segment(recorded([[0, { type: 'app:clear-state', requestId: 'c', payload: { bundleId: 'com.x' } }]]))
    const ch = new MemoryChannel()
    const abort = new AbortController()
    abort.abort()
    await expect(replayStep(ch, 's', clear!, abort.signal)).rejects.toThrow()
    expect(ch.sent).toEqual([])
  })

  it('does not replay the keyboard toggle, which is relative', async () => {
    const [toggle] = segment(recorded([[0, { type: 'input:keyboard:toggle' }]]))
    const ch = new MemoryChannel()
    await expect(replayStep(ch, 's', toggle!)).resolves.toBe('not-replayed')
    expect(ch.sent).toEqual([])
  })

  it('lets go of a held button when the session is left in the middle of it', async () => {
    vi.useFakeTimers()
    const [held] = segment(recorded([
      [0, { type: 'input:button', requestId: 'd', payload: { name: 'power', phase: 'down' } }],
      [2000, { type: 'input:button', requestId: 'u', payload: { name: 'power', phase: 'up' } }],
    ]))
    const ch = new MemoryChannel()
    const done = replayStep(ch, 's', held!).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(500)
    ch.leaveSession('s')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await done).toBeInstanceOf(SessionLeftError)
    expect(ch.sent.map((s) => s.msg.type === 'input:button' ? `button:${s.msg.payload.phase}` : s.msg.type))
      .toEqual(['button:down', 'button:up', 'session:leave'])
  })

  it('stops at an input the device refuses now, with its reason', async () => {
    const [key] = segment(recorded([[0, { type: 'input:key', requestId: 'k', payload: { code: 'Enter', modifiers: 0 } }]]))
    const ch = new MemoryChannel()
    ch.ack = 'error'
    await expect(replayStep(ch, 's', key!)).rejects.toBeInstanceOf(InputRefusedError)
  })

  it('installs fresh even when the recording asked to keep the app', async () => {
    const [install] = segment(recorded([[0, { type: 'app:install', requestId: 'i', buildId: 7, keepIfInstalled: true }]]))
    const ch = new MemoryChannel()
    await replayStep(ch, 's', install!)
    expect(ch.sent.map((s) => s.msg)).toEqual([{ type: 'app:install', sessionId: 's', requestId: expect.any(String), buildId: 7 }])
  })

  // The keys' characters depend on the device's layout, which an iOS simulator takes from the Mac's input source.
  const typed = () => segment(recorded([
    [0, { type: 'input:key', requestId: 'a', payload: { code: 'KeyA', modifiers: 0 } }],
    [80, { type: 'input:key', requestId: 'b', payload: { code: 'KeyB', modifiers: 0 } }],
  ]))

  it('types recorded text as the flow types it, whatever the keyboard layout', async () => {
    const [text] = typed()
    expect(text).toMatchObject({ kind: 'text', text: 'ab' })
    const ch = new MemoryChannel()
    await expect(replayStep(ch, 's', text!)).resolves.toBe('replayed')
    expect(ch.sent.map((s) => s.msg)).toEqual([{ type: 'input:type', sessionId: 's', requestId: expect.any(String), payload: { text: 'ab' } }])
  })

  it('sends the keys as recorded when the device refuses the text', async () => {
    const [text] = typed()
    const ch = new MemoryChannel()
    ch.typeAck = 'error'
    await expect(replayStep(ch, 's', text!)).resolves.toBe('replayed')
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:type', 'input:key', 'input:key'])
  })

  it('does not fall back to keys when the text was not refused but lost, so the failure is the connection\'s', async () => {
    const [text] = typed()
    const ch = new MemoryChannel()
    ch.typeAck = null
    const done = replayStep(ch, 's', text!)
    ch.drop()
    await expect(done).rejects.toThrow()
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:type'])
  })

  it('types a run typed with Caps Lock in force as text too, since its keys type by whatever language the device is left in', async () => {
    const [text] = segment(recorded([
      [0, { type: 'input:key', requestId: 'c', payload: { code: 'CapsLock', modifiers: 0 } }],
      [80, { type: 'input:key', requestId: 'a', payload: { code: 'KeyA', modifiers: 0 } }],
    ]))
    expect(text).toMatchObject({ kind: 'text', text: 'a', capsLock: true })
    const ch = new MemoryChannel()
    await expect(replayStep(ch, 's', text!)).resolves.toBe('replayed')
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:type'])
  })

  it('pastes through the clipboard, as the person did', async () => {
    const [paste] = segment(recorded([[0, { type: 'clipboard:write', requestId: 'c', payload: { text: 'Kim', pasteAfter: true } }]]))
    const ch = new MemoryChannel()
    await expect(replayStep(ch, 's', paste!)).resolves.toBe('replayed')
    expect(ch.sent[0]!.msg).toMatchObject({ type: 'clipboard:write', payload: { text: 'Kim', pasteAfter: true } })
  })

  it('sends nothing for a refused input, a network switch or a cut', async () => {
    const entries: CaptureEntry[] = [
      ...recorded([[0, { type: 'input:key', requestId: 'k', payload: { code: 'Enter', modifiers: 0 } }]]),
      { at: 5, kind: 'ack', requestId: 'k', ok: false },
      ...recorded([[10, { type: 'network:set', requestId: 'n', payload: { offline: true } }],
        [20, { type: 'clipboard:read', requestId: 'r', payload: { press: 'cut' } }]]),
    ]
    const ch = new MemoryChannel()
    const outcomes = []
    for (const raw of segment(entries)) outcomes.push(await replayStep(ch, 's', raw))
    expect(outcomes).toEqual(['refused-before', 'not-replayed', 'not-replayed'])
    expect(ch.sent).toEqual([])
  })
})

describe('rangeStartOrientation', () => {
  it('reads how the device was held when the range began, so the host can put it back before replaying', () => {
    const entries: CaptureEntry[] = [
      { at: 0, kind: 'chrome', chrome: { bodyRotation: 90 } },
      ...recorded([[10, { type: 'input:rotate', payload: { direction: 'clockwise' } }]]),
      { at: 20, kind: 'chrome', chrome: { bodyRotation: 180 } },
      ...recorded([[30, { type: 'input:keyboard:toggle' }]]),
    ]
    const steps = segment(entries)
    expect(rangeStartOrientation(steps, { start: 0, end: 2 })).toBe('landscape')
    expect(rangeStartOrientation(steps, { start: 1, end: 2 })).toBeUndefined()
  })
})

describe('replaySteps', () => {
  it('stops between steps when cancelled while the host was reading the screen', async () => {
    const steps = segment(recorded([
      [0, { type: 'input:key', requestId: 'a', payload: { code: 'Enter', modifiers: 0 } }],
      [10, { type: 'app:clear-state', requestId: 'c', payload: { bundleId: 'com.x' } }],
    ]))
    const ch = new MemoryChannel()
    const abort = new AbortController()
    const run = replaySteps(ch, 's', steps, { signal: abort.signal, afterStep: async () => { abort.abort() } })
    await expect(run).rejects.toThrow()
    expect(ch.sent.map((s) => s.msg.type)).toEqual(['input:key'])
  })

  it('reads the screen around each step, and stops when the host says to', async () => {
    const steps = segment(recorded([
      [0, { type: 'input:key', requestId: 'a', payload: { code: 'Enter', modifiers: 0 } }],
      [10, { type: 'input:key', requestId: 'b', payload: { code: 'Tab', modifiers: 0 } }],
    ]))
    const ch = new MemoryChannel()
    const seen: string[] = []
    const run = replaySteps(ch, 's', steps, {
      beforeStep: async (i) => { seen.push(`before ${i}`); if (i === 1) throw new Error('the pause lapsed') },
      afterStep: async (i, _raw, outcome) => { seen.push(`after ${i} ${outcome}`) },
    })
    await expect(run).rejects.toThrow('the pause lapsed')
    expect(seen).toEqual(['before 0', 'after 0 replayed', 'before 1'])
    expect(ch.sent).toHaveLength(1)
  })
})
