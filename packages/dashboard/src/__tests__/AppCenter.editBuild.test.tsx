// Edit build (#1084): the label, version and build number of a build, from its row's ⋯ menu. A version edit moves the
// row into another release, which React draws as a new row under another parent, so the dialog lives in App Center and
// finds the row's ⋯ again when it closes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App, Build } from '@/lib/types'
import type { BuildEdit } from '@/lib/queries'

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: vi.fn() } }))

const api = vi.hoisted(() => ({
  getApps: vi.fn(), getBuilds: vi.fn(), updateBuildDetails: vi.fn(),
  updateBuildStatus: vi.fn(), scheduleBuildDeletion: vi.fn(), cancelBuildDeletion: vi.fn(),
}))
vi.mock('@/lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries')>()),
  ...api,
}))

import { AppCenter } from '@/src/pages/AppCenter'

const APPS = [
  { id: 1, name: 'Coffee', bundle_id_key: 'com.a.coffee', bundle_ids: { ios: 'com.a.coffee', android: null }, build_platforms: ['ios'], platform: 'ios' },
] as unknown as App[]

function build(id: number, version: string | null, extra: Partial<Build> = {}): Build {
  return {
    id, app_id: 1, version_name: version, build_number: String(id), version_label: null, platform: 'ios',
    status_label: null, uploaded_at: '2026-09-21T00:00:00Z', uploader: `uploader-${id}`, delete_after: null,
    binary: { version_name: version, build_number: String(id) }, ...extra,
  } as unknown as Build
}

/** A server that searches and saves the way the relay does: an empty version goes back to the file's. */
let db: Build[] = []
function serve(rows: Build[]) {
  db = rows
  // SQLite `LIKE` folds ASCII case only.
  const fold = (v: string) => v.replace(/[A-Z]/g, (c) => c.toLowerCase())
  api.getBuilds.mockImplementation(async ({ search }: { search: string }) => db.filter((b) =>
    !search || [b.version_name, b.version_label].some((v) => v !== null && fold(v).includes(fold(search)))))
  api.updateBuildDetails.mockImplementation(async (id: number, edit: BuildEdit) => {
    db = db.map((b) => (b.id === id ? {
      ...b, version_label: edit.version_label,
      version_name: edit.version_name ?? b.binary.version_name, build_number: edit.build_number ?? b.binary.build_number,
    } : b))
  })
}

function renderAppCenter() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 }, mutations: { retry: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/app-center?appId=1']}>
        <Routes><Route path="/app-center" element={<AppCenter />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const menu = (id: number, version: string) => screen.getByRole('button', { name: `Actions for ios build ${id}, ${version}` })

async function openEdit(id: number, version: string) {
  await userEvent.click(menu(id, version))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit build' }))
  return screen.findByRole('dialog', { name: 'Edit build' })
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  api.getApps.mockResolvedValue(APPS)
})
afterEach(() => vi.restoreAllMocks())

describe('Edit build (#1084)', () => {
  it('moves the build into its new release, opens it, and puts focus on the build\'s ⋯ there', async () => {
    serve([build(2, '2.0.0'), build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')

    // 1.0.0 is closed by default (only the newest opens); its row is reached by opening it.
    await userEvent.click(screen.getByRole('button', { name: /^1\.0\.0/ }))
    const dialog = await openEdit(1, '1.0.0')
    expect(within(dialog).getByLabelText('Version')).toHaveValue('')
    expect(within(dialog).getByLabelText('Version')).toHaveAttribute('placeholder', '1.0.0')
    await userEvent.type(within(dialog).getByLabelText('Version'), '3.0.0')
    await userEvent.type(within(dialog).getByLabelText('Label'), 'staging')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(api.updateBuildDetails).toHaveBeenCalledWith(1, { version_label: 'staging', version_name: '3.0.0', build_number: null })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(menu(1, '3.0.0')))
    expect(screen.getByRole('button', { name: /^3\.0\.0/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('staging')).toBeInTheDocument()
    expect(screen.getByText('Edited')).toBeInTheDocument()
  })

  it('sends an empty version as the file\'s, which takes the mark away', async () => {
    serve([build(1, '9.9.9', { binary: { version_name: '1.0.0', build_number: '1' } })])
    renderAppCenter()
    await screen.findByText('Edited')
    const dialog = await openEdit(1, '9.9.9')
    expect(within(dialog).getByLabelText('Version')).toHaveValue('9.9.9')
    await userEvent.clear(within(dialog).getByLabelText('Version'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(api.updateBuildDetails).toHaveBeenCalledWith(1, { version_label: null, version_name: null, build_number: null })
    await waitFor(() => expect(document.activeElement).toBe(menu(1, '1.0.0')))
    expect(screen.queryByText('Edited')).toBeNull()
  })

  it('says a refused save inside the dialog and keeps it open', async () => {
    serve([build(1, '1.0.0')])
    api.updateBuildDetails.mockRejectedValueOnce(new Error('version_name must be text of at most 100 characters'))
    renderAppCenter()
    await screen.findByText('uploader-1')
    const dialog = await openEdit(1, '1.0.0')
    await userEvent.type(within(dialog).getByLabelText('Version'), '2.0')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('at most 100 characters'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('returns focus to the row\'s ⋯ when cancelled', async () => {
    serve([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    const dialog = await openEdit(1, '1.0.0')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(menu(1, '1.0.0')))
  })

  it('opens with what the build holds, not what was typed and cancelled last time', async () => {
    serve([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    let dialog = await openEdit(1, '1.0.0')
    await userEvent.type(within(dialog).getByLabelText('Label'), 'typo')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openEdit(1, '1.0.0')
    expect(within(dialog).getByLabelText('Label')).toHaveValue('')
  })

  // A search the build no longer matches takes it off the list on the refetch; focus goes to a neighbour, as for a
  // status change under a filter (#833).
  it('hands focus to a neighbour when the edit takes the build out of the search', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await userEvent.type(screen.getByLabelText(/^Search versions/), '1.0')
    await waitFor(() => expect(api.getBuilds).toHaveBeenCalledWith(expect.objectContaining({ search: '1.0' })))

    const dialog = await openEdit(1, '1.0.0')
    await userEvent.type(within(dialog).getByLabelText('Version'), '2.5.0')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Status for ios build 2, 1.0.0' })))
  })
})
