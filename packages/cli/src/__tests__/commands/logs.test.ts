import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { cmdLogs } from '../../commands/logs.js'

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  }))
}

describe('cmdLogs', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('로그 항목 출력', async () => {
    mockFetch(200, ['[2024-01-01T00:00:00.000Z] agent connected', '[2024-01-01T00:00:01.000Z] session started'])

    await cmdLogs({})
    const joined = output.join('\n')
    expect(joined).toContain('agent connected')
    expect(joined).toContain('session started')
  })

  it('항목 없으면 "No log entries yet" 출력', async () => {
    mockFetch(200, [])

    await cmdLogs({})
    expect(output.join('\n')).toContain('No log entries yet')
  })

  it('fetch 실패(네트워크 오류) 시 exit(1)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(null))

    await expect(cmdLogs({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('relay 응답 오류(non-ok) 시 exit(1)', async () => {
    mockFetch(500, [])

    await expect(cmdLogs({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('기본 URL은 http://localhost:4000/api/v1/logs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdLogs({})
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('http://localhost:4000/api/v1/logs'))
  })

  it('--lines 옵션이 URL에 반영', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdLogs({ lines: 50 })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('lines=50'))
  })

  it('--relay 옵션의 URL 사용', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdLogs({ relay: 'http://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('http://remote:4000'))
  })

  it('ws:// relay URL을 http://로 변환', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
    vi.stubGlobal('fetch', fetchMock)

    await cmdLogs({ relay: 'ws://remote:4000' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('http://remote:4000'))
  })
})
