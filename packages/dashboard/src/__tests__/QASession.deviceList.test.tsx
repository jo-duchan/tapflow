import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, DeviceSummary, SessionInfo } from '@/lib/types'
import { withQuery } from './withQuery'

// #1085: the picker groups devices by OS version with the asker's favourites on top, and an Admin can rename and
// hide devices for the team. The mocks are `QASession.aiHolder.test.tsx`'s; the relay's listing is handed in.
const { send } = vi.hoisted(() => ({ send: vi.fn() }))
let deliver: ((msg: BrowserInbound) => void) | null = null
vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
const { BUILD } = vi.hoisted(() => ({
  BUILD: { id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null, version_name: '1.0', build_number: '1' },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
vi.mock('@/components/DeviceViewer', () => ({ DeviceViewer: () => <div /> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const { QASession } = await import('../pages/QASession')

const device = (id: string, name: string, osVersion: string, extra: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id, name, platform: 'ios', status: 'shutdown', osVersion, sessionId: `s-${id}`, busy: false, ...extra })
const listing = (devices: DeviceSummary[]): SessionInfo[] => [{
  agentName: 'studio-mac', agentKey: 'mac-1', platform: 'ios', capabilities: [],
  admission: { booting: false, overloaded: false, memoryRefuses: [] }, devices,
}]

let role = 'QA'
let requests: Array<{ method: string; url: string; body: unknown }>
beforeEach(() => {
  send.mockClear()
  requests = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/api/v1/auth/me')) return new Response(JSON.stringify({ id: 1, email: 'a@example.test', role }))
    requests.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ ok: true }))
  })
})
afterEach(() => { vi.restoreAllMocks() })

async function open(devices: DeviceSummary[]) {
  const user = userEvent.setup()
  render(withQuery(
    <MemoryRouter initialEntries={['/qa?id=7']}>
      <BreadcrumbProvider><QASession /></BreadcrumbProvider>
    </MemoryRouter>,
  ))
  await vi.waitFor(() => expect(deliver).not.toBeNull())
  await act(async () => { deliver!({ type: 'agents:listed', sessions: listing(devices) }) })
  await user.click(await screen.findByText('studio-mac'))
  return user
}
const list = (devices: DeviceSummary[]) => act(async () => { deliver!({ type: 'agents:listed', sessions: listing(devices) }) })

describe('QASession — the device list (#1085)', () => {
  it('heads each OS version, newest first, with favourites above them', async () => {
    await open([device('a', 'iPhone 15', 'iOS 18.3'), device('b', 'iPhone 17', 'iOS 26.5'), device('c', 'iPad Air', 'iOS 18.3', { favourite: true })])
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Favourites', 'iOS 26.5', 'iOS 18.3'])
  })

  it('stars a device, keeps focus on the star as the card moves, and asks for the new listing', async () => {
    const user = await open([device('a', 'iPhone 15', 'iOS 18.3'), device('b', 'iPhone 17', 'iOS 26.5')])
    const star = screen.getByRole('button', { name: 'Add iPhone 15 to favourites' })
    await user.click(star)
    expect(requests).toContainEqual({ method: 'PUT', url: '/api/v1/device-favourites', body: { agent: 'mac-1', deviceId: 'a' } })
    expect(send).toHaveBeenLastCalledWith({ type: 'agents:list' })

    await list([device('a', 'iPhone 15', 'iOS 18.3', { favourite: true }), device('b', 'iPhone 17', 'iOS 26.5')])
    const starred = screen.getByRole('button', { name: 'Remove iPhone 15 from favourites' })
    expect(starred).toHaveAttribute('aria-pressed', 'true')
    expect(document.activeElement).toBe(starred)
  })

  // Un-starring moves the card later in the grid, which React does by moving the node itself — dropping focus.
  it('keeps focus on the star when a device is taken out of favourites', async () => {
    const user = await open([device('a', 'iPhone 15', 'iOS 18.3', { favourite: true }), device('b', 'iPhone 17', 'iOS 26.5')])
    await user.click(screen.getByRole('button', { name: 'Remove iPhone 15 from favourites' }))
    expect(requests).toContainEqual({ method: 'DELETE', url: '/api/v1/device-favourites', body: { agent: 'mac-1', deviceId: 'a' } })
    await list([device('a', 'iPhone 15', 'iOS 18.3'), device('b', 'iPhone 17', 'iOS 26.5')])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add iPhone 15 to favourites' }))
  })

  it('shows a renamed device under its new name with its own beneath', async () => {
    await open([device('a', 'iPhone 15', 'iOS 18.3', { displayName: 'Release phone' })])
    const card = screen.getByRole('button', { name: /^Release phone/ })
    expect(card.textContent).toContain('iPhone 15')
  })

  it('keeps hidden devices and the team menu from everyone but an Admin', async () => {
    await open([device('a', 'iPhone 15', 'iOS 18.3', { hidden: true }), device('b', 'iPhone 17', 'iOS 26.5')])
    expect(screen.queryByRole('button', { name: /^iPhone 15/ })).toBeNull()
    expect(screen.queryByLabelText(/Show hidden/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Actions for iPhone 17' })).toBeNull()
  })

  describe('as an Admin', () => {
    beforeEach(() => { role = 'Admin' })
    afterEach(() => { role = 'QA' })

    it('brings hidden devices back on request, marked', async () => {
      const user = await open([device('a', 'iPhone 15', 'iOS 18.3', { hidden: true }), device('b', 'iPhone 17', 'iOS 26.5')])
      const toggle = await screen.findByLabelText('Show hidden (1)')
      expect(screen.queryByRole('button', { name: /^iPhone 15/ })).toBeNull()
      await user.click(toggle)
      expect(screen.getByRole('button', { name: /^iPhone 15/ }).textContent).toContain('Hidden')
    })

    it('hides a device, moving focus off the card before it goes', async () => {
      const user = await open([device('a', 'iPhone 15', 'iOS 18.3'), device('b', 'iPhone 17', 'iOS 26.5')])
      await user.click(await screen.findByRole('button', { name: 'Actions for iPhone 15' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Hide' }))
      await vi.waitFor(() => expect(requests).toContainEqual({ method: 'PUT', url: '/api/v1/device-prefs', body: { agent: 'mac-1', deviceId: 'a', hidden: true } }))
      await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search devices')))
    })

    // With hidden devices shown the card stays, so focus has no reason to leave it.
    it('leaves focus alone when hiding a device that stays on screen', async () => {
      const user = await open([device('a', 'iPhone 15', 'iOS 18.3', { hidden: true }), device('b', 'iPhone 17', 'iOS 26.5')])
      await user.click(await screen.findByLabelText('Show hidden (1)'))
      await user.click(screen.getByRole('button', { name: 'Actions for iPhone 17' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Hide' }))
      await vi.waitFor(() => expect(requests).toContainEqual({ method: 'PUT', url: '/api/v1/device-prefs', body: { agent: 'mac-1', deviceId: 'b', hidden: true } }))
      await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for iPhone 17' })))
    })

    it('renames a device, and an empty name goes back to its own', async () => {
      const user = await open([device('a', 'iPhone 15', 'iOS 18.3', { displayName: 'Release phone' })])
      await user.click(await screen.findByRole('button', { name: 'Actions for Release phone' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
      const dialog = await screen.findByRole('dialog')
      const field = within(dialog).getByLabelText('Device name')
      expect(field).toHaveValue('Release phone')
      await user.clear(field)
      await user.click(within(dialog).getByRole('button', { name: 'Save' }))
      await vi.waitFor(() => expect(requests).toContainEqual({ method: 'PUT', url: '/api/v1/device-prefs', body: { agent: 'mac-1', deviceId: 'a', displayName: null } }))
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Release phone' }))
    })
  })
})
