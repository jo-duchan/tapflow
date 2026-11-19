import { describe, it, expect, vi } from 'vitest'
import type { AndroidChrome, BrowserInbound, BrowserToRelay, PosturesPayload } from '@tapflowio/protocol'
import { DashboardSessionChannel } from '@/lib/flowCapture/channel'
import type { CaptureTap } from '@/lib/flowCapture/tap'

// The dialog's channel rides the viewer's socket (#1125): what the viewer hears, it hears; what it sends, the viewer
// sends; and what the relay said before it existed, it is told.
function fakeTap(over: Partial<{ open: boolean; chrome: AndroidChrome | null; postures: PosturesPayload }> = {}) {
  const sent: BrowserToRelay[] = []
  const listeners = new Set<(m: BrowserInbound) => void>()
  const lost = new Set<() => void>()
  const state = { open: over.open ?? true }
  const tap: CaptureTap = {
    sessionId: 's1', platform: 'android', buildId: 7,
    send: (m) => { if (!state.open) return false; sent.push(m); return true },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    onConnectionLost: (l) => { lost.add(l); return () => lost.delete(l) },
    connected: () => state.open,
    chrome: () => over.chrome ?? null,
    postures: () => over.postures ?? { postures: [], currentId: null },
    surface: () => null,
  }
  return { tap, sent, state, deliver: (m: BrowserInbound) => { for (const l of listeners) l(m) }, drop: () => { for (const l of lost) l() }, listeners }
}

const bodyChrome = (bodyRotation: 0 | 90): AndroidChrome =>
  ({ buttons: [], streamType: 'h264', bodyRotation } as unknown as AndroidChrome)

describe('DashboardSessionChannel', () => {
  it('sends through the viewer and settles on what the viewer hears', async () => {
    const f = fakeTap()
    const ch = new DashboardSessionChannel(f.tap)
    const done = ch.pressKey('s1', 'Enter')
    const sent = f.sent[0] as { requestId: string }
    f.deliver({ type: 'input:done', sessionId: 's1', requestId: sent.requestId } as BrowserInbound)
    await expect(done).resolves.toBeUndefined()
  })

  it('fails a request at once when the socket is not open, rather than waiting for an answer that cannot come', async () => {
    const f = fakeTap({ open: false })
    const ch = new DashboardSessionChannel(f.tap)
    await expect(ch.pressKey('s1', 'Enter')).rejects.toThrow(/not open/)
  })

  it('fails what is waiting when the socket closes', async () => {
    const f = fakeTap()
    const ch = new DashboardSessionChannel(f.tap)
    const done = ch.pressKey('s1', 'Enter')
    f.drop()
    await expect(done).rejects.toThrow(/connection to the relay closed/)
  })

  it('knows the chrome the viewer already had, so a turn already made sends nothing', async () => {
    const f = fakeTap({ chrome: bodyChrome(90) })
    const ch = new DashboardSessionChannel(f.tap)
    await ch.setOrientation('s1', 'landscape', 50)
    expect(f.sent).toEqual([])
  })

  it('stops listening when closed', () => {
    const f = fakeTap()
    const ch = new DashboardSessionChannel(f.tap)
    expect(f.listeners.size).toBe(1)
    ch.close()
    expect(f.listeners.size).toBe(0)
  })

  it('reads the tree over the browser\'s fetch with the cookie, and calls a 502 transient', async () => {
    const f = fakeTap()
    const ch = new DashboardSessionChannel(f.tap)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [], interfaceTurn: 90 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
    await expect(ch.queryUITreeWithTurn('s1')).resolves.toEqual({ elements: [], interfaceTurn: 90 })
    expect(fetchMock.mock.calls[0]).toEqual(['/api/v1/sessions/s1/ui-tree', { credentials: 'include' }])
    await expect(ch.queryUITreeWithTurn('s1')).rejects.toMatchObject({ name: 'TransientQueryError' })
    fetchMock.mockRestore()
  })

  it('calls a read that never answered transient, as RelayClient does: a deadline cut it, or there was no connection', async () => {
    const ch = new DashboardSessionChannel(fakeTap().tap)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(ch.queryUITreeWithTurn('s1', AbortSignal.timeout(1))).rejects.toMatchObject({ name: 'TransientQueryError' })
    await expect(ch.queryUITreeWithTurn('s1')).rejects.toMatchObject({ name: 'TransientQueryError' })
    fetchMock.mockRestore()
  })
})
