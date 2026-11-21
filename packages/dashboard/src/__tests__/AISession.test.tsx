import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { BrowserToRelay } from '@tapflowio/protocol'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import type { MachineTouch } from '@/lib/touchMarks'
import { withQuery } from './withQuery'

/**
 * **The AI session watch page: watching an agent's device, read-only.** What matters most is what these pages
 * never send — a watch page that sent `device:shutdown` or `session:start` could end or take the session an
 * agent is in the middle of — and that a watch, once ended, stays ended across a reconnect.
 */
const { send, relay } = vi.hoisted(() => ({
  send: vi.fn<(msg: BrowserToRelay) => void>(),
  relay: { deliver: null as ((msg: BrowserInbound) => void) | null, setConnected: null as ((c: boolean) => void) | null },
}))

vi.mock('@/hooks/useRelay', async () => {
  const React = await import('react')
  return {
    useRelay: (onMessage: (msg: BrowserInbound) => void) => {
      const [connected, setConnected] = React.useState(true)
      relay.deliver = onMessage
      relay.setConnected = setConnected
      return { send, connected }
    },
  }
})
vi.mock('@/components/device/WatchedDevice', () => ({
  WatchedDevice: ({ platform, touch }: { platform: string; touch?: MachineTouch | null }) => (
    <div
      data-testid="watched-device" data-platform={platform}
      data-touch={touch === undefined ? 'none' : touch === null ? '' : touch.kind === 'tap' ? `tap:${touch.point.x},${touch.point.y}` : 'swipe'}
    />
  ),
}))

const { AISessionWatch } = await import('../pages/AISessionWatch')

const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac', platform: 'ios', capabilities: [], admission: { booting: false, overloaded: false, memoryRefuses: [] },
  devices: [
    { id: 'dev-a', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3', sessionId: 'sess-a', busy: true, holder: { kind: 'mcp', user: 'qa@example.test' } },
    { id: 'dev-b', name: 'iPhone SE', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3', sessionId: 'sess-b', busy: true },
    { id: 'dev-c', name: 'iPhone 14', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3', sessionId: 'sess-c', busy: false },
  ],
}]

const sentTypes = () => send.mock.calls.map(([m]) => m.type)

function renderAt(path: string) {
  return render(withQuery(
    <MemoryRouter initialEntries={[path]}>
      <BreadcrumbProvider>
        <Routes>
          <Route path="/automation/sessions/:sessionId" element={<AISessionWatch />} />
        </Routes>
      </BreadcrumbProvider>
    </MemoryRouter>,
  ))
}

const deliver = async (msg: BrowserInbound) => { await act(async () => { relay.deliver!(msg) }) }
const reconnect = async () => {
  await act(async () => { relay.setConnected!(false) })
  await act(async () => { relay.setConnected!(true) })
}

beforeEach(() => {
  send.mockClear()
  relay.deliver = null
  relay.setConnected = null
})

// A2: what the agent does, as it does it — a list beside the device and a mark on it.
describe('the watch page\'s actions', () => {
  const action = (a: Record<string, unknown>, at = 1_700_000_000_000) =>
    deliver({ type: 'watch:action', sessionId: 'sess-a', at, action: a } as BrowserInbound)

  it('lists what the agent does as it happened, under the step it belongs to, and hands its latest touch to the device', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    expect(screen.getByText(/Nothing yet/)).toBeTruthy()
    await action({ kind: 'label', label: 'step 3: tapOn("Sign in")' })
    await action({ kind: 'tap', x: 0.5, y: 0.8 })
    await action({ kind: 'type', chars: 8 })
    // The step is a row that opens onto its actions; the latest step is open.
    const step = screen.getByRole('button', { name: 'step 3: tapOn("Sign in")' })
    expect(step.getAttribute('aria-expanded')).toBe('true')
    const inside = within(document.getElementById(step.getAttribute('aria-controls')!)!).getAllByRole('listitem')
    expect(inside.map((li) => li.textContent)).toEqual(['Tap at 50%, 80%', 'Typed 8 characters'])
    // The time is there for whoever asks, not on every line.
    expect(inside[0]!.firstElementChild!.getAttribute('title')).toMatch(/\d/)
    expect(screen.getByRole('heading', { name: 'Agent activity' })).toBeTruthy()
    // The latest touch is handed to the device to play; how long it shows is the touch marks' own timing.
    expect(screen.getByTestId('watched-device').dataset.touch).toBe('tap:0.5,0.8')
  })

  it('opens every step, and keeps one someone closed closed', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await action({ kind: 'label', label: 'step 1: tapOn("A")' })
    await action({ kind: 'tap', x: 0.1, y: 0.1 })
    await action({ kind: 'label', label: 'step 2: tapOn("B")' })
    await action({ kind: 'tap', x: 0.2, y: 0.2 })
    const first = screen.getByRole('button', { name: 'step 1: tapOn("A")' })
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Tap at 10%, 10%')).toBeTruthy()
    await act(async () => { first.click() })
    expect(screen.queryByText('Tap at 10%, 10%')).toBeNull()
    await action({ kind: 'label', label: 'step 3: tapOn("C")' })
    expect(screen.getByRole('button', { name: 'step 1: tapOn("A")' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'step 2: tapOn("B")' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the last picture and the activity once the watch ends', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await action({ kind: 'label', label: 'step 1: launchApp' })
    await action({ kind: 'launch' })
    await deliver({ type: 'watch:ended', sessionId: 'sess-a', reason: 'session-ended' })
    expect(screen.getByTestId('watched-device')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'step 1: launchApp' })).toBeTruthy()
    expect(screen.getByText('Launched the app')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Back to App Center/ })).toBeTruthy()
  })

  it('ignores another session\'s actions', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'watch:action', sessionId: 'sess-b', at: 1, action: { kind: 'tap', x: 0.1, y: 0.1 } } as BrowserInbound)
    expect(screen.getByText(/Nothing yet/)).toBeTruthy()
  })

  it('keeps the last hundred', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    for (let i = 0; i < 105; i++) await action({ kind: 'key', key: `F${i}` })
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(100)
    expect(screen.getByText('Key F104')).toBeTruthy()
    expect(screen.queryByText('Key F4')).toBeNull()
  })
})

describe('the watch page', () => {
  it('asks to watch, and sends nothing that would join, boot or shut the device down', async () => {
    renderAt('/automation/sessions/sess-a')
    await vi.waitFor(() => expect(sentTypes()).toContain('watch:start'))
    expect(send).toHaveBeenCalledWith({ type: 'watch:start', sessionId: 'sess-a' })
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'device:ready', payload: { deviceId: 'dev-a' } })
    await reconnect()
    expect(sentTypes().filter((t) => t === 'watch:start')).toHaveLength(2)
    expect(sentTypes().filter((t) => t === 'session:start' || t.startsWith('device:'))).toEqual([])
  })

  it('names the device and who is driving it', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'agents:listed', sessions: AGENTS })
    expect(await screen.findByRole('heading', { name: 'iPhone 15' })).toBeTruthy()
    expect(screen.getByText('Coding agent · qa@example.test')).toBeTruthy()
  })

  // Mutation: let a reconnect start a new watch. The relay ended it because the session became someone
  // else's — a fresh watch would be refused at best.
  it('stays ended across a reconnect, and offers the way back', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'watch:ended', sessionId: 'sess-a', reason: 'holder-changed' })
    expect(screen.getByRole('status').textContent).toBe('Someone else picked up this device, so the watch ended.')
    expect(screen.getByRole('link', { name: /Back to App Center/ })).toBeTruthy()
    // The last picture stays to be looked at (no frames come any more); the activity beside it stays too.
    expect(screen.getByTestId('watched-device')).toBeTruthy()
    send.mockClear()
    await reconnect()
    expect(sentTypes()).not.toContain('watch:start')
  })

  it('says why a watch was refused', async () => {
    renderAt('/automation/sessions/sess-b')
    await deliver({ type: 'watch:refused', sessionId: 'sess-b', reason: 'not-watchable', message: 'x' })
    expect(screen.getByRole('status').textContent).toBe('This device is not being driven by an AI agent, so it cannot be watched.')
  })

  it('keeps the picture when the agent disconnects, and says so', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'device:ready', payload: { deviceId: 'dev-a' } })
    await deliver({ type: 'watch:holder-left', sessionId: 'sess-a' })
    // A foldable re-sends its chrome on a screen change whoever holds it; that is not the holder coming back.
    await deliver({ type: 'session:chrome', sessionId: 'sess-a', payload: { buttons: [], streamType: 'h264', screenWidth: 1080, screenHeight: 2400 } })
    expect(screen.getByRole('status').textContent).toBe('The AI client disconnected. The device stays as it was until it comes back.')
    expect(screen.getByTestId('watched-device')).toBeTruthy()
  })

  // The relay says nothing to watchers when the same client re-joins, and a booted device sends no chrome or
  // ready — the listing naming a live holder is what says it is back. Mutation: drop that branch.
  it('clears the disconnect notice once the listing shows the driver back', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'device:ready', payload: { deviceId: 'dev-a' } })
    await deliver({ type: 'watch:holder-left', sessionId: 'sess-a' })
    await deliver({ type: 'agents:listed', sessions: AGENTS })
    expect(screen.getByRole('status').textContent).toBe('Watching. Nothing you do here reaches the device.')
  })

  it('ignores what another session says', async () => {
    renderAt('/automation/sessions/sess-a')
    await deliver({ type: 'watch:started', sessionId: 'sess-a' })
    await deliver({ type: 'watch:ended', sessionId: 'other', reason: 'session-ended' })
    expect(screen.getByTestId('watched-device')).toBeTruthy()
  })
})
