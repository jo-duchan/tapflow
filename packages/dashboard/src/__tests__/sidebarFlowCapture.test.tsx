import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AppSidebar } from '@/components/AppSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { withQuery } from './withQuery'

// Flow Capture (#1125): each person turns step capturing on or off for themselves, from the account menu — every
// role, a Viewer included, because a Viewer tests on devices too.

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 3, email: 'vic@test.local', displayName: 'Vic', avatarUrl: null, role: 'Viewer', flowCapture: true, ...over })

function relay(me: Record<string, unknown>, preferences: { status: number }) {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/api/v1/auth/me')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(me) })
    if (url.endsWith('/api/v1/me/preferences')) {
      const ok = preferences.status === 200
      return Promise.resolve({ ok, status: preferences.status, json: () => Promise.resolve(ok ? { flowCapture: false } : { error: 'no' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }))
  return calls
}

function renderSidebar() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
  render(withQuery(
    <MemoryRouter>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  ))
}

describe('Capture my steps in the account menu', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a checkbox named by its first line, and turning it off saves false', async () => {
    const calls = relay(user(), { status: 200 })
    renderSidebar()
    await userEvent.click(await screen.findByRole('button', { name: /Vic/ }))
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Capture my steps' })
    expect(item).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(item)
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/api/v1/me/preferences'))?.body).toEqual({ flowCapture: false }))
    // The menu stays open, and the item shows the new state.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Capture my steps' })).toHaveAttribute('aria-checked', 'false')
  })

  it('goes back to what it was when the relay refuses', async () => {
    relay(user(), { status: 500 })
    renderSidebar()
    await userEvent.click(await screen.findByRole('button', { name: /Vic/ }))
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Capture my steps' }))
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'Capture my steps' })).toHaveAttribute('aria-checked', 'true'))
  })

  it('is not offered by a relay that predates it', async () => {
    relay(user({ flowCapture: undefined }), { status: 200 })
    renderSidebar()
    await userEvent.click(await screen.findByRole('button', { name: /Vic/ }))
    await screen.findByRole('menuitem', { name: /Log out/ })
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })
})
