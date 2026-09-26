// What Default settings shows from the relay, pinned before its three loads move from effects to
// TanStack Query (#845). Held on both sides of that move, so the page is wrapped in a provider now.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AuthUser } from '@/hooks/useAuth'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const auth = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user, loading: false }) }))

import { DefaultSettings } from '@/src/pages/settings/Default'

const user = (role: string): AuthUser => ({ id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: '/avatars/1.png', role })

let fetchMock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/v1/settings') return new Response(JSON.stringify({ team_name: 'QA Team', logo_url: '/logos/team.png' }))
    if (url === '/api/v1/apps') {
      return new Response(JSON.stringify({ items: [{ id: 7, name: 'Coffee', bundle_id_key: 'com.a.coffee', platform: 'ios' }] }))
    }
    return new Response('{}', { status: 404 })
  })
})
afterEach(() => vi.restoreAllMocks())

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><DefaultSettings /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Default settings — what it loads', () => {
  it('fills the workspace from the relay for an admin', async () => {
    auth.user = user('Admin')
    renderPage()
    await waitFor(() => expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('QA Team'))
    expect(screen.getByAltText('Workspace logo').getAttribute('src')).toBe('/logos/team.png')
  })

  it('fills the profile from the signed-in user', async () => {
    auth.user = user('Member')
    renderPage()
    await waitFor(() => expect((screen.getByLabelText('Nickname') as HTMLInputElement).value).toBe('Duchan'))
    expect(screen.getByAltText('Profile avatar').getAttribute('src')).toBe('/avatars/1.png')
  })

  it('lists the apps for someone who can edit them', async () => {
    auth.user = user('Developer')
    renderPage()
    expect(await screen.findByDisplayValue('Coffee')).toBeInTheDocument()
  })

  // QA manages apps like Developer; Viewer is the one role that does not.
  // Mutation: drop 'QA' from `canEditApps` → this fails; the Viewer twin below holds the other side.
  it('lists the apps for QA', async () => {
    auth.user = user('QA')
    renderPage()
    expect(await screen.findByDisplayValue('Coffee')).toBeInTheDocument()
  })

  it('does not ask for the apps for a Viewer', async () => {
    auth.user = user('Viewer')
    renderPage()
    await waitFor(() => expect((screen.getByLabelText('Nickname') as HTMLInputElement).value).toBe('Duchan'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const asked = fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(asked).not.toContain('/api/v1/apps')
    expect(screen.queryByDisplayValue('Coffee')).toBeNull()
  })

  it('asks for neither the workspace nor the apps for a member', async () => {
    // The twin of the two above: same fixture, only the role differs.
    auth.user = user('Member')
    renderPage()
    await waitFor(() => expect((screen.getByLabelText('Nickname') as HTMLInputElement).value).toBe('Duchan'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const asked = fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(asked).not.toContain('/api/v1/settings')
    expect(asked).not.toContain('/api/v1/apps')
    expect(screen.queryByLabelText('Team name')).toBeNull()
  })
})
