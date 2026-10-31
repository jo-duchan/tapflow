import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App } from '@/lib/types'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { AppsCard } from '@/components/settings/AppsCard'

/** Renaming and deleting live behind each app's menu, so the card shows names and bundle IDs and nothing to type into. */
const app = (id: number, name: string, ios: string): App => ({
  id, name, bundle_id_key: ios, bundle_ids: { ios, android: null }, build_platforms: ['ios'], platform: 'ios',
  latest_build_id: null, version_name: null, build_number: null, status_label: null, latest_uploaded_at: null,
})
const APPS = [app(1, 'Coffee', 'com.coffee'), app(2, 'Tea', 'com.tea')]

let fetchMock: ReturnType<typeof vi.spyOn>
let answer: Response
beforeEach(() => {
  answer = new Response(JSON.stringify({ ok: true }))
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer)
})
afterEach(() => vi.restoreAllMocks())

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return render(<QueryClientProvider client={client}><AppsCard apps={APPS} /></QueryClientProvider>)
}

async function pick(user: ReturnType<typeof userEvent.setup>, appName: string, item: 'Edit' | 'Delete') {
  await user.click(screen.getByRole('button', { name: `Actions for ${appName}` }))
  await user.click(await screen.findByRole('menuitem', { name: item }))
}

describe('app menu', () => {
  it('renames an app from Edit, and puts focus back on its menu', async () => {
    const user = userEvent.setup()
    renderCard()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await pick(user, 'Coffee', 'Edit')

    const field = await screen.findByLabelText('App name')
    expect(field).toHaveValue('Coffee')
    await user.clear(field)
    await user.type(field, '  Espresso {Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/v1/apps/1')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: 'Espresso' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Coffee' })))
  })

  it('says a failed rename inside the dialog and keeps it open', async () => {
    answer = new Response('{}', { status: 500 })
    const user = userEvent.setup()
    renderCard()
    await pick(user, 'Coffee', 'Edit')
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Failed to update app'))
  })

  it('will not save an empty name', async () => {
    const user = userEvent.setup()
    renderCard()
    await pick(user, 'Coffee', 'Edit')
    await user.clear(await screen.findByLabelText('App name'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('deletes an app from Delete after asking, and puts focus on the next app', async () => {
    const user = userEvent.setup()
    renderCard()
    await pick(user, 'Coffee', 'Delete')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('permanently delete Coffee')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/v1/apps/1')
    expect((init as RequestInit).method).toBe('DELETE')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Tea' })))
  })
})
