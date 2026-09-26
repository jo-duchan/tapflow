import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App, Build } from '@/lib/types'
import type { AuthUser } from '@/hooks/useAuth'
import { withQuery } from './withQuery'

// App Center reads the role once and hands `canWrite` down. Viewer is read-only: the two create
// buttons stay and explain themselves in a toast, and the rows draw no control that changes a build.
// QA is the twin — the same fixture with every control live.
//
// Mutation: `canWrite = true` in AppCenter (the role never read) → every Viewer case fails.
// Mutation: `canWrite = user?.role === 'Admin' || user?.role === 'Developer'` → the QA case fails.
// Mutation: the empty-state line ignores `canWrite` → the Viewer empty-state case fails.
// Mutation: the `RoleRefusedError` branch in `optimisticRows.onError` removed → the demoted-mid-session
// case fails (generic toast, `/me` never re-read).

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn(), promise: vi.fn() } }))

const auth = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user, loading: false }) }))

const { getApps, getBuilds, createApp, updateBuildStatus } = vi.hoisted(() => ({
  getApps: vi.fn(), getBuilds: vi.fn(), createApp: vi.fn(), updateBuildStatus: vi.fn(),
}))
vi.mock('@/lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries')>()),
  getApps,
  getBuilds,
  createApp,
  updateBuildStatus,
}))

import { AppCenter } from '@/src/pages/AppCenter'
import { RoleRefusedError, queryKeys } from '@/lib/queries'

const user = (role: string): AuthUser => ({ id: 1, email: 'a@b.c', displayName: 'A', avatarUrl: null, role })

const APPS = [{ id: 1, name: 'Coffee', bundle_id_key: 'com.a.coffee', platform: 'ios' }] as unknown as App[]
const BUILDS = [{
  id: 1, app_id: 1, version_name: '1.0.0', build_number: '7', platform: 'ios', status_label: 'Backlog',
  uploaded_at: '2026-09-21T00:00:00Z', uploader: 'ci', delete_after: null,
}] as unknown as Build[]

function renderAppCenter() {
  render(withQuery(
    <MemoryRouter initialEntries={['/app-center?appId=1']}>
      <Routes><Route path="/app-center" element={<AppCenter />} /></Routes>
    </MemoryRouter>,
  ))
}

beforeEach(() => {
  vi.clearAllMocks()
  getApps.mockResolvedValue(APPS)
  getBuilds.mockResolvedValue(BUILDS)
})

describe('App Center — Viewer is read-only', () => {
  beforeEach(() => { auth.user = user('Viewer') })

  it('rows show the status but draw no status Select or deletion button', async () => {
    renderAppCenter()
    expect(await screen.findByRole('button', { name: 'Start QA on ios build 7, 1.0.0' })).toBeInTheDocument()
    expect(screen.getByText('Backlog', { selector: '[class*="text-xs"]' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /^Status for/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /deletion of/ })).toBeNull()
  })

  it('Add App raises the toast and opens nothing', async () => {
    renderAppCenter()
    await userEvent.click(await screen.findByRole('button', { name: /add app/i }))
    expect(toastError).toHaveBeenCalledWith("Viewers can't add apps. Ask an Admin for QA or Developer access.")
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createApp).not.toHaveBeenCalled()
  })

  it('an app with no builds does not tell a Viewer to upload one', async () => {
    getBuilds.mockResolvedValue([])
    renderAppCenter()
    expect(await screen.findByText('Builds appear here once a teammate uploads one.')).toBeInTheDocument()
    expect(screen.queryByText('Upload the first build to get started.')).toBeNull()
  })

  it('Upload build raises the toast and opens nothing', async () => {
    renderAppCenter()
    await userEvent.click(await screen.findByRole('button', { name: /upload build/i }))
    expect(toastError).toHaveBeenCalledWith("Viewers can't upload builds. Ask an Admin for QA or Developer access.")
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('App Center — QA can write', () => {
  beforeEach(() => { auth.user = user('QA') })

  it('rows draw the status Select and deletion button, and both dialogs open', async () => {
    renderAppCenter()
    expect(await screen.findByRole('combobox', { name: 'Status for ios build 7, 1.0.0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedule deletion of ios build 7, 1.0.0' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /upload build/i }))
    expect(await screen.findByRole('dialog', { name: 'Upload build' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByRole('button', { name: /add app/i }))
    expect(await screen.findByRole('dialog', { name: 'Add App' })).toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('App Center — a role change mid-session', () => {
  beforeEach(() => { auth.user = user('QA') })

  it('an empty app still invites QA to upload the first build', async () => {
    getBuilds.mockResolvedValue([])
    renderAppCenter()
    expect(await screen.findByText('Upload the first build to get started.')).toBeInTheDocument()
  })

  // Demoted to Viewer after the page loaded: the controls are still drawn, and the relay refuses.
  it('a 403 on a status change re-reads the role and says the server\'s reason', async () => {
    updateBuildStatus.mockRejectedValue(new RoleRefusedError('Viewers have read-only access'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 }, mutations: { retry: 0 } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app-center?appId=1']}>
          <Routes><Route path="/app-center" element={<AppCenter />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await userEvent.click(await screen.findByRole('combobox', { name: 'Status for ios build 7, 1.0.0' }))
    await userEvent.click(screen.getByRole('option', { name: 'Done' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Viewers have read-only access'))
    expect(toastError).not.toHaveBeenCalledWith('Failed to update status')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.me })
  })
})
