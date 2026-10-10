import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { BrowserToRelay } from '@tapflowio/protocol'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import { withQuery } from './withQuery'

/**
 * **The AI session pages: watching an agent's device, read-only.** What matters most is what these pages
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
  WatchedDevice: ({ platform }: { platform: string }) => <div data-testid="watched-device" data-platform={platform} />,
}))

const { AISessionWatch } = await import('../pages/AISessionWatch')
const { AISessions } = await import('../pages/AISessions')

const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac', platform: 'ios', capabilities: [],
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
          <Route path="/automation/sessions" element={<AISessions />} />
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
    expect(screen.getByRole('link', { name: /Back to AI Sessions/ })).toBeTruthy()
    expect(screen.queryByTestId('watched-device')).toBeNull()
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

describe('the AI Sessions list', () => {
  it('lists only devices an AI agent is driving, each a link to watch it', async () => {
    renderAt('/automation/sessions')
    await deliver({ type: 'agents:listed', sessions: AGENTS })
    const link = screen.getByRole('link', { name: /iPhone 15, watch/ })
    expect(link.getAttribute('href')).toBe('/automation/sessions/sess-a')
    expect(screen.queryByText('iPhone SE')).toBeNull()
    expect(screen.queryByText('iPhone 14')).toBeNull()
  })

  it('says when no agent is driving anything', async () => {
    renderAt('/automation/sessions')
    await deliver({ type: 'agents:listed', sessions: [{ ...AGENTS[0]!, devices: [AGENTS[0]!.devices[2]!] }] })
    expect(screen.getByText('No AI agent is driving a device right now.')).toBeTruthy()
  })
})
