import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BrowserToRelay } from '@tapflowio/protocol'
import type { UIElement } from '@tapflowio/agent-core'
import { SessionChannel, newRequestId, type RelayMsg } from '../sessionChannel.js'
import { SocketFlowDriver } from '../SocketFlowDriver.js'
import { RelayClosedError, SessionEndedError, SessionLeftError } from '../sessionErrors.js'
import { runFlow } from '../engine.js'
import { parseFlow } from '../schema.js'

// The channel with no socket under it — what a browser host is. `RelayClient`'s suite covers the same semantics over
// `ws`; this one holds that they need nothing from it.
class MemoryChannel extends SessionChannel {
  readonly sent: BrowserToRelay[] = []
  /** Answers each input's terminal frame as the relay would, when set. */
  autoAck = false

  protected send(msg: BrowserToRelay): void {
    this.sent.push(msg)
    if (this.autoAck && msg.type.startsWith('input:') && 'requestId' in msg && 'sessionId' in msg) {
      const { sessionId, requestId } = msg
      queueMicrotask(() => this.receive({ type: 'input:done', sessionId, requestId }))
    }
  }

  receive(msg: RelayMsg): void {
    this.dispatch(msg)
  }

  lose(why: string): void {
    this.connectionLost(why)
  }
}

const requestIdOf = (m: BrowserToRelay | undefined): string => (m as { requestId: string }).requestId

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SessionChannel without a socket', () => {
  it('a tap sends start and end, and resolves on the ack addressed to its end', async () => {
    const ch = new MemoryChannel()
    const done = ch.tap('s1', 0.25, 0.75)
    expect(ch.sent.map((m) => m.type)).toEqual(['input:touch:start', 'input:touch:end'])
    ch.receive({ type: 'input:done', sessionId: 's1', requestId: 'someone-else' })
    ch.receive({ type: 'input:done', sessionId: 's1', requestId: requestIdOf(ch.sent[1]) })
    await expect(done).resolves.toBeUndefined()
  })

  it('a leave in the middle of a swipe ends the gesture on the device and fails the swipe as left', async () => {
    vi.useFakeTimers()
    const ch = new MemoryChannel()
    const swipe = ch.swipe('s1', [0.5, 0.8], [0.5, 0.2], 400).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    ch.leaveSession('s1')
    await vi.advanceTimersByTimeAsync(400)
    expect(await swipe).toBeInstanceOf(SessionLeftError)
    const types = ch.sent.map((m) => m.type)
    expect(types.slice(-3)).toEqual(['input:touch:cancel', 'input:touch:end', 'session:leave'])
    expect(types.filter((t) => t === 'input:touch:move').length).toBeLessThan(7)
  })

  it('a terminated session settles its own waiters and no other session\'s', async () => {
    const ch = new MemoryChannel()
    const mine = ch.pressKey('s1', 'Enter').catch((e: unknown) => e)
    const other = ch.pressKey('s2', 'Enter')
    ch.receive({ type: 'session:terminated', sessionId: 's1', reason: 'agent-disconnected' })
    expect(await mine).toBeInstanceOf(SessionEndedError)
    ch.receive({ type: 'input:done', sessionId: 's2', requestId: requestIdOf(ch.sent[1]) })
    await expect(other).resolves.toBeUndefined()
  })

  it('a lost connection settles every waiter as closed, with what the relay said about the session', async () => {
    const ch = new MemoryChannel()
    ch.receive({ type: 'session:agent-away', sessionId: 's1' })
    const pending = ch.pressButton('s1', 'home').catch((e: unknown) => e)
    ch.lose('socket gone')
    const err = await pending
    // Wrapped as unconfirmed by the ack wait, with the close and the note inside.
    expect((err as Error).cause).toBeInstanceOf(RelayClosedError)
    expect((err as Error).message).toContain('socket gone')
    expect((err as Error).message).toContain('went away')
  })

  it('mints request ids where crypto.randomUUID does not exist, as on a LAN dashboard', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) })
    expect((globalThis.crypto as Partial<Crypto>).randomUUID).toBeUndefined()
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('SocketFlowDriver over a channel', () => {
  it('runs a flow through the engine with no RelayClient anywhere', async () => {
    const ch = new MemoryChannel()
    ch.autoAck = true
    const ok: UIElement = { role: 'button', label: 'OK', enabled: true, frame: { x: 0.4, y: 0.6, width: 0.2, height: 0.1 } }
    const device = Object.assign(ch, {
      queryUITreeWithTurn: async () => ({ elements: [ok] }),
      screenshot: async () => Buffer.alloc(0),
    })
    const result = await runFlow(parseFlow('steps:\n  - tapOn: OK\n  - pressKey: Enter\n', 'f.yaml'), new SocketFlowDriver(device, 's1'))
    expect(result.status).toBe('passed')
    const touch = ch.sent.find((m) => m.type === 'input:touch:end') as { payload: { x: number; y: number } }
    expect(touch.payload.x).toBeCloseTo(0.5)
    expect(touch.payload.y).toBeCloseTo(0.65)
    expect(ch.sent.some((m) => m.type === 'input:key')).toBe(true)
  })
})
