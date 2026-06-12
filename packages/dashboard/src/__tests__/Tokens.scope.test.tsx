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

// 컴포넌트가 동시에 여러 fetch를 날리므로 URL 기반 디스패치로 모킹한다 (dashboard AGENTS.md)
function stubFetch(opts: {
  createRes?: { ok: boolean; body: unknown }
  lanHost?: string | null
} = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/v1/relay/host')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ lanHost: opts.lanHost ?? null, port: 4000 }) })
    }
    if (init?.method === 'POST') {
      const r = opts.createRes ?? { ok: true, body: { token: 'tflw_pat_x' } }
      return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) // GET /api/v1/tokens
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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
    const fetchMock = stubFetch()
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const createCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!
    expect(JSON.parse((createCall[1] as RequestInit).body as string)).toMatchObject({ scope: 'agent' })
  })

  it('기본(API) 타입은 scope를 보내지 않고 relay/host도 조회하지 않는다 (BC)', async () => {
    const fetchMock = stubFetch()
    renderTokens()
    await openDialogAndType('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const createCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!
    expect(JSON.parse((createCall[1] as RequestInit).body as string)).not.toHaveProperty('scope')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/relay/host'))).toBe(false)
  })

  // jsdom 뷰어 주소는 localhost:3000 — localhost 뷰어는 릴레이가 알려준 LAN 주소로 치환해야
  // "에이전트 Mac에서 실행" 커맨드가 깨지지 않는다 (#271 follow-up)
  it('localhost 뷰어의 agent 커맨드는 릴레이 LAN 주소로 치환된다', async () => {
    stubFetch({ createRes: { ok: true, body: { token: 'tflw_pat_abc' } }, lanHost: '192.168.0.50' })
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    const cmd = await screen.findByText(/tapflow agent start --relay/)
    expect(cmd.textContent).toContain('--relay ws://192.168.0.50:4000')
    expect(cmd.textContent).toContain('--token tflw_pat_abc')
  })

  it('릴레이가 LAN 주소를 모르면 뷰어 주소로 폴백한다', async () => {
    stubFetch({ createRes: { ok: true, body: { token: 'tflw_pat_abc' } }, lanHost: null })
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    const cmd = await screen.findByText(/tapflow agent start --relay/)
    expect(cmd.textContent).toContain(`--relay ws://${window.location.host}`)
  })

  it('비-Admin의 agent 스코프 발급 거절(403) 시 서버 사유를 토스트로 보여준다', async () => {
    stubFetch({ createRes: { ok: false, body: { error: "'agent' scope requires the Admin role" } } })
    renderTokens()
    await openDialogAndType('agent-mac-1')
    await selectAgentType()
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("'agent' scope requires the Admin role"),
    )
  })
})
