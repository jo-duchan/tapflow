import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// next-themes 모킹
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

import { Setup } from '@/src/pages/Setup'

function renderSetup(initialPath = '/setup') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Setup 페이지', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('미초기화 상태 → 폼 렌더링', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: false }), { status: 200 }),
    )
    renderSetup()
    expect(screen.getByLabelText(/admin email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument()
  })

  it('이미 초기화됨 → /login 리다이렉트', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: true }), { status: 200 }),
    )
    renderSetup()
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
  })

  it('폼 제출 성공 → /api/v1/auth/init 호출 후 /login 이동', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialized: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))

    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'securepass')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'securepass')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/auth/init', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
  })

  it('비밀번호 불일치 → 에러 메시지, API 미호출', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: false }), { status: 200 }),
    )
    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'password1')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'password2')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() => expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument())
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // status check만
  })

  it('API 실패 → 에러 메시지 표시', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialized: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Already initialized' }), { status: 403 }))

    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'securepass')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'securepass')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() => expect(screen.getByText('Already initialized')).toBeInTheDocument())
  })
})
