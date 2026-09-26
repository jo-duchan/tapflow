import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { TokenSettings } from '@/src/pages/settings/Tokens'
import type { ApiToken } from '@/lib/types'
import { withQuery } from './withQuery'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const WARNING = /stays valid until you revoke it/i

function renderTokens() {
  return render(withQuery(
    <MemoryRouter>
      <TokenSettings />
    </MemoryRouter>),
  )
}

function stubFetch(list: ApiToken[] = []) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tflw_pat_x' }) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve(list) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function wasPosted(fetchMock: ReturnType<typeof stubFetch>): boolean {
  return fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
}

function postedBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  if (!call) throw new Error('no POST was sent')
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
}

async function openDialog(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
  await userEvent.type(screen.getByLabelText(/^name$/i), name)
}

async function chooseExpiry(option: RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: /expiration/i }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

async function submit() {
  await userEvent.click(screen.getByRole('button', { name: /create token/i }))
}

describe('Tokens — optional expiry', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to 30 days and sends it', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    expect(screen.getByRole('combobox', { name: /expiration/i })).toHaveTextContent('30 days')
    await submit()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(postedBody(fetchMock)).toMatchObject({ expires_in_days: 30 })
  })

  it('No expiration sends no expires_in_days, which the API reads as no expiry', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    await chooseExpiry(/no expiration/i)
    await submit()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(postedBody(fetchMock)).not.toHaveProperty('expires_in_days')
  })

  it('shows the recommendation only for No expiration, as the description of the choice', async () => {
    stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()

    await chooseExpiry(/no expiration/i)
    const trigger = screen.getByRole('combobox', { name: /expiration/i })
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    expect(trigger).toHaveAccessibleDescription(WARNING)

    await chooseExpiry(/^90 days$/i)
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()
    expect(trigger).not.toHaveAccessibleDescription(WARNING)
  })

  it('Custom asks for a number of days and still holds it to 1–365', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    expect(screen.queryByLabelText(/expires in \(days\)/i)).not.toBeInTheDocument()
    await chooseExpiry(/custom/i)
    const days = screen.getByLabelText(/expires in \(days\)/i)

    await userEvent.clear(days)
    await userEvent.type(days, '366')
    await submit()
    expect(await screen.findByText('Must be between 1 and 365')).toBeInTheDocument()
    expect(wasPosted(fetchMock)).toBe(false)

    await userEvent.clear(days)
    await userEvent.type(days, '365')
    await submit()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(postedBody(fetchMock)).toMatchObject({ expires_in_days: 365 })
  })

  it('a preset chosen after Custom sends the preset, not the stale custom number', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    await chooseExpiry(/custom/i)
    const days = screen.getByLabelText(/expires in \(days\)/i)
    await userEvent.clear(days)
    await userEvent.type(days, '5')
    await chooseExpiry(/^60 days$/i)
    await submit()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(postedBody(fetchMock)).toMatchObject({ expires_in_days: 60 })
  })

  it('an invalid custom number does not block No expiration once Custom is left', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    await chooseExpiry(/custom/i)
    const days = screen.getByLabelText(/expires in \(days\)/i)
    await userEvent.clear(days)
    await userEvent.type(days, '366')
    await submit()
    expect(await screen.findByText('Must be between 1 and 365')).toBeInTheDocument()
    await chooseExpiry(/no expiration/i)
    await submit()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(postedBody(fetchMock)).not.toHaveProperty('expires_in_days')
  })

  it('Custom reads an exponent number as its value, not as 1 (1e3 is out of range)', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialog('ci-deploy')
    await chooseExpiry(/custom/i)
    const days = screen.getByLabelText(/expires in \(days\)/i)
    await userEvent.clear(days)
    // A fraction never reaches the schema: the number input's step blocks the submit first. Set in one
    // change, because typing it key by key passes through "1e", which the input empties.
    fireEvent.change(days, { target: { value: '1e3' } })
    await submit()
    expect(await screen.findByText('Must be between 1 and 365')).toBeInTheDocument()
    expect(wasPosted(fetchMock)).toBe(false)
  })

  it('marks a token with no expiry in the list, so it can be found and revoked', async () => {
    stubFetch([
      { id: 1, name: 'forever', scope: 'view', last_used_at: null, expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'dated', scope: 'view', last_used_at: null, expires_at: '2999-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    ])
    renderTokens()
    const forever = (await screen.findByText('forever')).closest('tr')
    const dated = screen.getByText('dated').closest('tr')
    if (!forever || !dated) throw new Error('rows not rendered')
    expect(within(forever).getByText('No expiration')).toBeInTheDocument()
    expect(within(dated).queryByText('No expiration')).not.toBeInTheDocument()
  })
})
