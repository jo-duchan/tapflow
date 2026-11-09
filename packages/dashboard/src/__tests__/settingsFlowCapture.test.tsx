import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DefaultSettings } from '@/src/pages/settings/Default'
import { withQuery } from './withQuery'

// Flow Capture (#1125): each person turns step capturing on or off for themselves, in Settings › Default beside
// Profile and Password — every role, a Viewer included, because a Viewer tests on devices too.

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light', theme: 'light', setTheme: () => {} }) }))

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 3, email: 'vic@test.local', displayName: 'Vic', avatarUrl: null, role: 'Viewer', flowCapture: true, ...over })

function relay(me: Record<string, unknown>, preferences: { status: number }) {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (url.endsWith('/api/v1/auth/me')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(me) })
    if (url.endsWith('/api/v1/me/preferences')) {
      const ok = preferences.status === 200
      return Promise.resolve({ ok, status: preferences.status, json: () => Promise.resolve(ok ? { flowCapture: false } : { error: 'no' }) })
    }
    if (url.endsWith('/api/v1/apps')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }))
  return calls
}

const renderSettings = () => render(withQuery(<MemoryRouter><DefaultSettings /></MemoryRouter>))

describe('Capture my steps in Settings › Default', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a switch a Viewer can turn off, and turning it off saves false', async () => {
    const calls = relay(user(), { status: 200 })
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Capture my steps' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(/Remember taps, swipes and typing/)
    await userEvent.click(toggle)
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/api/v1/me/preferences'))?.body).toEqual({ flowCapture: false }))
    expect(screen.getByRole('switch', { name: 'Capture my steps' })).toHaveAttribute('aria-checked', 'false')
  })

  it('goes back to what it was when the relay refuses', async () => {
    relay(user(), { status: 500 })
    renderSettings()
    await userEvent.click(await screen.findByRole('switch', { name: 'Capture my steps' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Capture my steps' })).toHaveAttribute('aria-checked', 'true'))
  })

  // Review of #1144: two changes in flight could land at the relay in either order, and the switch keep the last answer.
  it('sends one change at a time, and takes the next once it is answered', async () => {
    let answer: () => void = () => {}
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(user()) })
      if (url.endsWith('/api/v1/me/preferences')) {
        const body = JSON.parse(String(init?.body))
        calls.push(body)
        return new Promise((resolve) => { answer = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }) })
      }
      if (url.endsWith('/api/v1/apps')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Capture my steps' })
    // Two clicks in one tick: the second comes before `isPending` is rendered, which is why a ref holds the guard.
    act(() => { fireEvent.click(toggle); fireEvent.click(toggle) })
    await waitFor(() => expect(calls).toEqual([{ flowCapture: false }]))
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    answer()
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled', 'true'))
    await userEvent.click(toggle)
    await waitFor(() => expect(calls).toEqual([{ flowCapture: false }, { flowCapture: true }]))
  })

  it('is not offered by a relay that predates it', async () => {
    relay(user({ flowCapture: undefined }), { status: 200 })
    renderSettings()
    // Once the user has loaded, so the absence is not just the page before it knows who is signed in.
    await waitFor(() => expect(screen.getByLabelText('Nickname')).toHaveValue('Vic'))
    expect(screen.queryByRole('switch', { name: 'Capture my steps' })).toBeNull()
  })
})
