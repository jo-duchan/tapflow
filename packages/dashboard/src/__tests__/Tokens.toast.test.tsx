import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { TokenSettings } from '@/src/pages/settings/Tokens'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const baseTokens = [
  {
    id: 1,
    name: 'ci-deploy',
    scope: 'builds:write',
    last_used_at: null,
    expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function renderTokens() {
  return render(
    <MemoryRouter>
      <TokenSettings />
    </MemoryRouter>,
  )
}

describe('Tokens — toast feedback', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('TC2: 토큰 생성 실패(서버 에러) 시 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    // 서버가 사유를 내려주면 그대로 보여준다 (#271 — agent 스코프 403 안내)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Server error'),
    )
  })

  it('TC2-1: 서버 에러 body가 없으면 기본 메시지로 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.reject(new Error('no body')) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to create token'),
    )
  })

  it('TC1: 토큰 생성 성공 시 toast.success 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token created'),
    )
  })

  it('TC3: 클립보드 복사 성공 시 toast.success 호출', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await screen.findByText('abc123')
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token copied to clipboard'),
    )
  })

  it('TC4: 클립보드 복사 실패 시 toast.error 호출', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await screen.findByText('abc123')
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to copy — copy manually'),
    )
  })

  it('TC5: revoke 성공 시 toast.success 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(baseTokens) })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await screen.findByText('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /revoke token/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token revoked'),
    )
  })

  it('TC6: revoke 실패(서버 에러) 시 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(baseTokens) })
        .mockResolvedValueOnce({ ok: false }),
    )
    renderTokens()
    await screen.findByText('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /revoke token/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to revoke token'),
    )
  })
})
