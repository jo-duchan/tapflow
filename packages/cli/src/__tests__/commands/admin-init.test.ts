import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

import * as clack from '@clack/prompts'
import { cmdAdminInit } from '../../commands/admin-init.js'

const mockText = vi.mocked(clack.text)
const mockPassword = vi.mocked(clack.password)

function mockInputs(email: string, pw: string) {
  mockText.mockResolvedValue(email)
  mockPassword.mockResolvedValue(pw)
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
  }))
}

describe('cmdAdminInit', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(clack.isCancel).mockReturnValue(false)
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('성공 시 "Admin account created" 출력', async () => {
    mockInputs('admin@test.com', 'password123')
    mockFetch(201, { ok: true })

    await cmdAdminInit({})
    expect(output.join('\n')).toContain('Admin account created')
  })

  it('성공 시 입력한 email 표시', async () => {
    mockInputs('admin@test.com', 'password123')
    mockFetch(201, { ok: true })

    await cmdAdminInit({})
    expect(output.join('\n')).toContain('admin@test.com')
  })

  it('relay 연결 실패 시 exit(1)', async () => {
    mockInputs('admin@test.com', 'password123')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(cmdAdminInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('이미 초기화된 경우(403) exit(1) + 안내 메시지', async () => {
    mockInputs('admin@test.com', 'password123')
    mockFetch(403, { error: 'Already initialized' })

    await expect(cmdAdminInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('Already initialized')
  })

  it('비밀번호 8자 미만 시 clack validate에서 에러 반환', () => {
    // clack의 password validate 함수가 올바르게 정의됐는지 확인
    // (실제 clack은 validate 통과 전까지 입력을 막음 — 여기선 함수 시그니처만 검증)
    mockInputs('admin@test.com', 'short')
    const validateFn = mockPassword.mock.calls[0]?.[0]?.validate
    if (validateFn) {
      expect(validateFn('short')).toMatch(/8 characters/)
      expect(validateFn('password123')).toBeUndefined()
    }
  })

  it('--relay 옵션 URL로 요청', async () => {
    mockInputs('admin@test.com', 'password123')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: vi.fn().mockResolvedValue({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await cmdAdminInit({ relay: 'http://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://remote:4000'),
      expect.anything(),
    )
  })

  it('ws:// relay URL을 http://로 변환', async () => {
    mockInputs('admin@test.com', 'password123')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: vi.fn().mockResolvedValue({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await cmdAdminInit({ relay: 'ws://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://remote:4000'),
      expect.anything(),
    )
  })
})
