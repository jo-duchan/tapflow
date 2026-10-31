import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { TeamSettings } from '@/src/pages/settings/Team'
import { withQuery } from './withQuery'
import { resetTeammateBasesForTests } from '@/lib/publicLink'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

interface InviteReply { token: string; emailSent: boolean; inviteUrl: string | null }
const noHost = { lanHost: null, port: 4000, publicBaseUrl: null, agentRelayUrl: null }

// The page fires several requests at once, so dispatch on URL (dashboard AGENTS.md).
interface ResetReply { token: string; emailSent: boolean; resetUrl: string | null }
const member = { id: 2, email: 'alice@test.local', display_name: 'Alice', role: 'QA', joined_at: '2026-09-01T00:00:00Z' }

function stubFetch(invite: InviteReply | { status: number; error: string }, host: object = noHost, reset?: ResetReply) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/v1/relay/host')) return Promise.resolve({ ok: true, json: () => Promise.resolve(host) })
    if (url.includes('/api/v1/team/invite') && init?.method === 'POST') {
      if ('error' in invite) return Promise.resolve({ ok: false, status: invite.status, json: () => Promise.resolve({ error: invite.error }) })
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve(invite) })
    }
    if (url.includes('/send-reset') && reset) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reset) })
    if (url.includes('/api/v1/team/members')) return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** `undefined` is what a plain-HTTP LAN page has: no `navigator.clipboard` at all. */
function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: writeText ? { writeText } : undefined })
}

async function sendInvite() {
  render(withQuery(<TeamSettings />))
  await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
  await userEvent.type(screen.getByLabelText(/email/i), 'qa@test.local')
  await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
}

describe('Team — the invite link a teammate gets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTeammateBasesForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a dialog opened and abandoned says nothing, and closes on the first press', async () => {
    // **The reported bug was a dialog one, and the regression tests for it were on a page.** Radix
    // autofocuses the first control when this dialog opens — nothing else in the app does, the four
    // auth *pages* do not — so leaving without typing is one pointer move away. Under the old
    // `mode: 'onBlur'` that drew `Enter a valid email`, and the inserted line moved what was below
    // it, so the press that should have dismissed the dialog landed on nothing and it took a second.
    stubFetch({ token: 't', emailSent: false, inviteUrl: null })
    render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
    const email = screen.getByLabelText(/email/i)
    expect(email).toHaveFocus()

    await userEvent.tab()
    expect(screen.queryByText(/valid email/i)).toBeNull()

    // The first press, not the second: this is the half a "no message appears" assertion misses.
    // The dialog's close is the header X, whose accessible name is its `sr-only` "Close".
    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows and copies the link the relay mailed, not the browser address (#788)', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    const field = await screen.findByDisplayValue('http://192.168.219.113:4000/invite?token=t')
    expect(writeText).toHaveBeenCalledWith('http://192.168.219.113:4000/invite?token=t')
    expect(screen.queryByDisplayValue(/localhost:3000/)).not.toBeInTheDocument()
    // The form and its focused button are gone; focus lands on the link, where it can be selected by hand.
    await waitFor(() => expect(field).toHaveFocus())
  })

  it('shows the warning in the invite form without taking focus from the email field', async () => {
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, { ...noHost, publicUrlWarning: 'container-without-public-url' })
    render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))

    const email = screen.getByLabelText(/email/i)
    const note = await screen.findByRole('note', { name: /teammates cannot open this relay's public url/i })
    expect(email).toHaveFocus()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(note).toHaveTextContent('TAPFLOW_RELAY_URL')
  })

  it('loads the warning even when the relay supplied the invite URL, without moving focus when it arrives', async () => {
    let resolveHost: (value: unknown) => void = () => {}
    const hostResponse = new Promise<unknown>((resolve) => { resolveHost = resolve })
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/relay/host')) return hostResponse.then((body) => ({ ok: true, json: () => Promise.resolve(body) }))
      if (url.includes('/api/v1/team/invite') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ token: 't', emailSent: false, inviteUrl: 'http://localhost:4000/invite?token=t' }) })
      }
      if (url.includes('/api/v1/team/members')) return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
    await userEvent.type(screen.getByLabelText(/email/i), 'qa@test.local')
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))

    const field = await screen.findByDisplayValue('http://localhost:4000/invite?token=t')
    await waitFor(() => expect(field).toHaveFocus())
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/relay/host'))).toBe(true)

    resolveHost({ ...noHost, publicUrlWarning: 'container-without-public-url' })
    const note = await screen.findByRole('note', { name: /teammates cannot open this relay's public url/i })
    expect(field).toHaveAttribute('aria-describedby', note.id)
    expect(note).toHaveTextContent('TAPFLOW_RELAY_URL')
    expect(note.querySelector('a')).toHaveAttribute('href', 'https://www.tapflow.dev/operate/docker')
    expect(field).toHaveFocus()
  })

  it('does not let an invite request from a closed dialog overwrite the reopened form', async () => {
    let resolveInvite: (value: unknown) => void = () => {}
    const inviteResponse = new Promise<unknown>((resolve) => { resolveInvite = resolve })
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/relay/host')) return Promise.resolve({ ok: true, json: () => Promise.resolve(noHost) })
      if (url.includes('/api/v1/team/invite') && init?.method === 'POST') {
        return inviteResponse.then((body) => ({ ok: true, status: 201, json: () => Promise.resolve(body) }))
      }
      if (url.includes('/api/v1/team/members')) return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
    await userEvent.type(screen.getByLabelText(/email/i), 'first@test.local')
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /invite member/i }))
    expect(screen.getByLabelText(/email/i)).toHaveValue('')

    await act(async () => {
      resolveInvite({ token: 'old', emailSent: false, inviteUrl: 'https://relay.example.com/invite?token=old' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByLabelText(/email/i)).toHaveValue('')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not copy or toast a late invite response after the settings page unmounts', async () => {
    let resolveInvite: (value: unknown) => void = () => {}
    const inviteResponse = new Promise<unknown>((resolve) => { resolveInvite = resolve })
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/relay/host')) return Promise.resolve({ ok: true, json: () => Promise.resolve(noHost) })
      if (url.includes('/api/v1/team/invite') && init?.method === 'POST') {
        return inviteResponse.then((body) => ({ ok: true, status: 201, json: () => Promise.resolve(body) }))
      }
      if (url.includes('/api/v1/team/members')) return Promise.resolve({ ok: true, json: () => Promise.resolve([member]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
    await userEvent.type(screen.getByLabelText(/email/i), 'late@test.local')
    await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))

    unmount()
    await act(async () => {
      resolveInvite({ token: 'late', emailSent: false, inviteUrl: 'https://relay.example.com/invite?token=late' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(writeText).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('builds the link from the teammate base when the relay offers none', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, { ...noHost, lanHost: '192.168.0.50' })

    await sendInvite()

    expect(await screen.findByDisplayValue('http://192.168.0.50:4000/invite?token=t')).toBeInTheDocument()
  })

  it('says the link was copied only when it was', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    expect(await screen.findByText(/invite link copied to clipboard:/i)).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/copied/i))
    // Toasts render outside the dialog, which hides them from assistive technology; the dialog says it too.
    expect(screen.getByRole('status')).toHaveTextContent(/invite link copied to clipboard\./i)
  })

  it('does not claim a copy the browser refused', async () => {
    stubClipboard(vi.fn(async (_text: string) => { throw new Error('denied') }))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    // Wait for the outcome of the copy before asserting what was not said.
    expect(await screen.findByText(/copy this invite link/i)).toBeInTheDocument()
    expect(screen.queryByText(/invite link copied to clipboard/i)).not.toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0][0]).not.toMatch(/copied/i)
    expect(screen.getByRole('status')).toHaveTextContent(/copy the invite link/i)
    expect(screen.getByRole('status')).not.toHaveTextContent(/copied/i)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('treats a page with no clipboard API (plain HTTP) as a refused copy, not a failed invite', async () => {
    stubClipboard(undefined)
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    expect(await screen.findByText(/copy this invite link/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('http://192.168.219.113:4000/invite?token=t')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says a failed invite inside the dialog, where assistive technology can hear it', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(
      url.includes('/api/v1/team/invite') && init?.method === 'POST'
        ? { ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }
        : { ok: true, json: () => Promise.resolve([]) },
    )))

    await sendInvite()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed to create invite link.'))
    expect(toast.error).toHaveBeenCalledWith('Failed to create invite link')
  })

  // The dialog clears on the way in (the trigger's onOpenChange(true)), not on close, so it stays unchanged
  // while it animates out. Removing that reset would reopen on the last invite.
  it('opens on a fresh form after Done, not on the previous invite or its status', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })
    await sendInvite()
    await screen.findByDisplayValue('http://192.168.219.113:4000/invite?token=t')

    await userEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /invite member/i }))

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(/invite\?token=t/)).not.toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

describe('Team — inviting an existing member', () => {
  beforeEach(() => { vi.clearAllMocks(); resetTeammateBasesForTests() })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the refusal on the email field and stays on the form', async () => {
    stubFetch({ status: 409, error: 'Already a member' })
    await sendInvite()
    expect(await screen.findByText(/already a member/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /generate invite link/i })).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('Team — the reset link an Admin hands over', () => {
  beforeEach(() => { vi.clearAllMocks(); resetTeammateBasesForTests() })
  afterEach(() => vi.unstubAllGlobals())

  async function pressReset() {
    render(withQuery(<TeamSettings />))
    await userEvent.click(await screen.findByRole('button', { name: /reset pwd/i }))
  }

  it('without mail, shows and copies the link, and says mail was not sent', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, noHost, { token: 'r', emailSent: false, resetUrl: 'http://192.168.0.50:4000/reset-password?token=r' })
    await pressReset()
    const field = await screen.findByDisplayValue('http://192.168.0.50:4000/reset-password?token=r')
    expect(writeText).toHaveBeenCalledWith('http://192.168.0.50:4000/reset-password?token=r')
    expect(screen.getByRole('dialog')).toHaveTextContent(/email could not be sent to alice@test\.local/i)
    expect(screen.getByText(/reset link copied to clipboard:/i)).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/copied/i))
    await waitFor(() => expect(field).toHaveFocus())
    // The button keeps its name; the outcome is in the dialog and the toast, not in the button text.
    expect(screen.getByRole('button', { name: /reset pwd/i, hidden: true })).toBeInTheDocument()
  })

  it('returns focus to the row\'s Reset pwd button when the dialog closes', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, noHost, { token: 'r', emailSent: true, resetUrl: 'https://relay.example.com/reset-password?token=r' })
    await pressReset()
    await screen.findByDisplayValue('https://relay.example.com/reset-password?token=r')
    await userEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /reset pwd/i })).toHaveFocus())
  })

  it('with mail, says it was sent and still offers the link', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, noHost, { token: 'r', emailSent: true, resetUrl: 'https://relay.example.com/reset-password?token=r' })
    await pressReset()
    expect(await screen.findByDisplayValue('https://relay.example.com/reset-password?token=r')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Reset email sent to alice@test.local')
  })

  it('builds the link from the teammate base when the relay offers none, and admits a refused copy', async () => {
    stubClipboard(undefined)
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, { ...noHost, lanHost: '192.168.0.50' }, { token: 'r', emailSent: false, resetUrl: null })
    await pressReset()
    expect(await screen.findByDisplayValue('http://192.168.0.50:4000/reset-password?token=r')).toBeInTheDocument()
    expect(screen.getByText(/copy this reset link:/i)).toBeInTheDocument()
    expect(vi.mocked(toast.warning).mock.calls[0][0]).not.toMatch(/copied/i)
  })

  it('a failure is a toast, and no dialog opens', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
      url.includes('/send-reset')
        ? { ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }
        : { ok: true, json: () => Promise.resolve(url.includes('/team/members') ? [member] : []) },
    )))
    await pressReset()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to create reset link'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
