import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { config } from '@tapflowio/relay'
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

  it('relay 응답 오류(non-ok) 시 exit(1), naming the status', async () => {
    mockFetch(500, [])

    await expect(cmdLogs({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('answered 500')
    expect(output.join('\n')).not.toContain('Could not reach')
  })

  // The relay serves logs only to its own host; the message says where to run it instead of
  // "could not reach", which would send the user to check a relay that is up. Mutation: collapsing
  // 403 into the generic branch turns this red.
  it('403 → says the relay serves logs only to its host, and how to read them there', async () => {
    mockFetch(403, { error: 'Logs are only available on the relay host.' })

    await expect(cmdLogs({ relay: 'http://remote:4000' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    const joined = output.join('\n')
    expect(joined).toContain('own host')
    expect(joined).toContain('--relay http://localhost:')
    expect(joined).toContain('docker compose logs')
    expect(joined).not.toContain('Could not reach')
  })

  // Mutation: defaulting to `relay.url` again turns this red.
  it('defaults to this machine even when relay.url names a remote relay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue([]) })
    vi.stubGlobal('fetch', fetchMock)
    const saved = config.relay.url
    config.relay.url = 'wss://relay.example.com'
    try {
      await cmdLogs({})
    } finally {
      config.relay.url = saved
    }
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:${config.local.port}/api/v1/logs?lines=100`)
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
