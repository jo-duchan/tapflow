import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import { withQuery } from './withQuery'

// The mocks are `QASession.reset.test.tsx`'s, deliberately — the point here is the device list, not the socket.
const { send } = vi.hoisted(() => ({ send: vi.fn() }))
let deliver: ((msg: BrowserInbound) => void) | null = null
vi.mock('@/hooks/useRelay', () => ({
  // One `send` for the file: a fresh function per render re-runs every effect that depends on it.
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
// One object for the file: a fresh `build` per call is a new dependency every render, and the page's
// effects on it then render forever — the worker ran out of memory on exactly that.
const { BUILD } = vi.hoisted(() => ({
  BUILD: { id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null, version_name: '1.0', build_number: '1' },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
vi.mock('@/components/DeviceViewer', () => ({ DeviceViewer: () => <div /> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const { QASession } = await import('../pages/QASession')

const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac', platform: 'ios', capabilities: [],
  devices: [
    { id: 'dev-a', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3', sessionId: 'sess-a', busy: true, holder: { kind: 'mcp', user: 'qa@example.test' } },
    { id: 'dev-b', name: 'iPhone SE', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3', sessionId: 'sess-b', busy: true },
  ],
}]

describe('QASession — a device an AI agent is driving', () => {
  // A person's in-use device stays disabled; only one an AI agent holds — `holder` set — opens its watch page.
  it('becomes a link to watch it, and a person\'s stays disabled', async () => {
    const user = userEvent.setup()
    render(withQuery(
      <MemoryRouter initialEntries={['/qa?id=7']}>
        <BreadcrumbProvider><QASession /></BreadcrumbProvider>
      </MemoryRouter>,
    ))
    await vi.waitFor(() => expect(deliver).not.toBeNull())
    await act(async () => { deliver!({ type: 'agents:listed', sessions: AGENTS }) })
    await user.click(await screen.findByText('studio-mac'))
    const watch = await screen.findByRole('link', { name: /iPhone 15/ })
    expect(watch.getAttribute('href')).toBe('/automation/sessions/sess-a')
    expect(watch.textContent).toContain('Coding agent is driving it · Watch')
    expect(screen.getByRole('button', { name: /iPhone SE/ })).toHaveProperty('disabled', true)
  })
})
