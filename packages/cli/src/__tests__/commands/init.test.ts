import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}))

import * as readline from 'node:readline/promises'
import { cmdInit } from '../../commands/init.js'

const mockCreateInterface = vi.mocked(readline.createInterface)

function mockRl(email: string, password: string) {
  mockCreateInterface.mockReturnValue({
    question: vi.fn()
      .mockResolvedValueOnce(email)
      .mockResolvedValueOnce(password),
    close: vi.fn(),
  } as never)
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  }))
}

describe('cmdInit', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    mockCreateInterface.mockReturnValue({
      question: vi.fn().mockResolvedValue(''),
      close: vi.fn(),
    } as never)
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
    mockRl('admin@test.com', 'password123')
    mockFetch(201, { ok: true })

    await cmdInit({})
    expect(output.join('\n')).toContain('Admin account created')
  })

  it('성공 시 입력한 email 표시', async () => {
    mockRl('admin@test.com', 'password123')
    mockFetch(201, { ok: true })

    await cmdInit({})
    expect(output.join('\n')).toContain('admin@test.com')
  })

  it('relay 연결 실패 시 exit(1)', async () => {
    mockRl('admin@test.com', 'password123')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(cmdInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('이미 초기화된 경우(403) exit(1) + 안내 메시지', async () => {
    mockRl('admin@test.com', 'password123')
    mockFetch(403, { error: 'Already initialized' })

    await expect(cmdInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('Already initialized')
  })

  it('비밀번호 8자 미만 시 exit(1)', async () => {
    mockRl('admin@test.com', 'short')

    await expect(cmdInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('8 characters')
  })

  it('이메일 미입력 시 exit(1)', async () => {
    mockRl('', 'password123')

    await expect(cmdInit({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('--relay 옵션 URL로 요청', async () => {
    mockRl('admin@test.com', 'password123')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdInit({ relay: 'http://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://remote:4000'),
      expect.anything(),
    )
  })

  it('ws:// relay URL을 http://로 변환', async () => {
    mockRl('admin@test.com', 'password123')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdInit({ relay: 'ws://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://remote:4000'),
      expect.anything(),
    )
  })
})
