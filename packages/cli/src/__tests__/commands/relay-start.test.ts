import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@tapflowio/relay', () => ({
  RelayServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
  initDb: vi.fn(),
  config: { local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576 }, relay: { url: null }, tunnel: null },
}))

const mockTunnel = { start: vi.fn(), stop: vi.fn() }
vi.mock('../../lib/rathole-tunnel.js', () => ({
  RatholeTunnel: vi.fn().mockImplementation(() => mockTunnel),
}))

import { RelayServer, initDb, config } from '@tapflowio/relay'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'
import { cmdRelayStart } from '../../commands/relay-start.js'

describe('cmdRelayStart', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.mocked(RelayServer).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never))
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://vps.example.com' })
    mockTunnel.stop.mockResolvedValue(undefined)
    vi.mocked(RatholeTunnel).mockImplementation(() => mockTunnel as never)
    vi.mocked(config).tunnel = null
  })

  afterEach(() => vi.restoreAllMocks())

  it('기본 포트 4000으로 RelayServer 기동', async () => {
    await cmdRelayStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(() => {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdRelayStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
  })

  it('--port 옵션으로 포트 변경', async () => {
    await cmdRelayStart({ port: 8080 })
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })

  it('SIGINT 시 process.exit(0) 호출', async () => {
    const onSpy = vi.spyOn(process, 'on')
    await cmdRelayStart({})
    const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
    expect(call).toBeDefined()
    const handler = call![1] as () => void
    expect(() => handler()).toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('기동 완료 후 포트 번호가 출력에 포함됨', async () => {
    await cmdRelayStart({ port: 9999 })
    expect(output.join('\n')).toContain('9999')
  })

  it('기본 포트 출력에 localhost:4000 포함', async () => {
    await cmdRelayStart({})
    expect(output.join('\n')).toContain('localhost:4000')
  })

  it('포트 범위 초과(99999) → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 99999 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('포트 0 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 0 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('NaN 포트 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: NaN })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  describe('--tunnel 옵션', () => {
    beforeEach(() => {
      vi.stubEnv('TAPFLOW_TUNNEL_TOKEN', 'secret-token')
      vi.mocked(config).tunnel = { provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com' }
    })

    afterEach(() => vi.unstubAllEnvs())

    it('config.tunnel 설정 → RatholeTunnel 기동 + 공개 URL 출력', async () => {
      await cmdRelayStart({})
      expect(RatholeTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverAddr: 'vps.example.com:2333', token: 'secret-token' }))
      expect(mockTunnel.start).toHaveBeenCalledWith(4000)
      expect(output.join('\n')).toContain('https://vps.example.com')
    })

    it('--tunnel 플래그 없고 config.tunnel도 없음 → 터널 기동 안 함', async () => {
      vi.mocked(config).tunnel = null
      await cmdRelayStart({})
      expect(RatholeTunnel).not.toHaveBeenCalled()
    })

    it('TAPFLOW_TUNNEL_TOKEN 없음 → exit(1)', async () => {
      vi.unstubAllEnvs()
      await expect(cmdRelayStart({})).rejects.toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('SIGINT 시 relay + tunnel 모두 종료', async () => {
      const onSpy = vi.spyOn(process, 'on')
      await cmdRelayStart({})
      const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
      const handler = call![1] as () => void
      expect(() => handler()).toThrow('process.exit')
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('터널 기동 실패 → relay는 계속 동작', async () => {
      mockTunnel.start.mockRejectedValue(new Error('connection refused'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(RelayServer).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
    })
  })
})
