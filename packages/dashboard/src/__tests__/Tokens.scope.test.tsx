import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { TokenSettings } from '@/src/pages/settings/Tokens'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function renderTokens() {
  return render(
    <MemoryRouter>
      <TokenSettings />
    </MemoryRouter>,
  )
}

// #271 — 토큰 타입 선택(API/Agent)과 agent 스코프 발급 플로우
describe('Tokens — scope selection', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  async function openDialogAndType(name: string) {
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), name)
  }

  async function selectAgentType() {
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: /agent/i }))
  }

  it('Agent 타입 선택 시 POST body에 scope=agent 가 포함된다', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tflw_pat_x' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
    vi.stubGlobal('fetch', fetchMock)
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(createCall[1].body as string)).toMatchObject({ scope: 'agent' })
  })

  it('기본(API) 타입은 scope를 보내지 않는다 — 서버 기본값 유지(BC)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tflw_pat_x' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
    vi.stubGlobal('fetch', fetchMock)
    renderTokens()
    await openDialogAndType('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(createCall[1].body as string)).not.toHaveProperty('scope')
  })

  it('agent 토큰 생성 성공 화면에 agent start 커맨드를 보여준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tflw_pat_abc' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    const cmd = await screen.findByText(/tapflow agent start --relay/)
    expect(cmd.textContent).toContain('--token tflw_pat_abc')
  })

  it('비-Admin의 agent 스코프 발급 거절(403) 시 서버 사유를 토스트로 보여준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "'agent' scope requires the Admin role" }) }),
    )
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("'agent' scope requires the Admin role"),
    )
  })
})
