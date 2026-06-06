import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const mockTunnel = { setupServer: vi.fn(), start: vi.fn(), stop: vi.fn() }
vi.mock('../../lib/rathole-tunnel.js', () => ({
  RatholeTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))
vi.mock('../../lib/tailscale-tunnel.js', () => ({
  TailscaleTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))

import { RatholeTunnel } from '../../lib/rathole-tunnel.js'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'
import { startConfiguredTunnel } from '../../lib/tunnel-runner.js'

describe('startConfiguredTunnel', () => {
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockTunnel.setupServer.mockResolvedValue(undefined)
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://vps.example.com' })
    mockTunnel.stop.mockResolvedValue(undefined)
    vi.mocked(RatholeTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(TailscaleTunnel).mockImplementation(function () { return mockTunnel as never })
  })

  afterEach(() => vi.restoreAllMocks())

  it('tailscale: TailscaleTunnel 생성 후 publicUrl 반환 (토큰 불필요)', async () => {
    mockTunnel.start.mockResolvedValue({ publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    const res = await startConfiguredTunnel({ provider: 'tailscale' }, 4000)
    expect(TailscaleTunnel).toHaveBeenCalledWith({ publicUrl: undefined })
    expect(RatholeTunnel).not.toHaveBeenCalled()
    expect(res.publicUrl).toBe('http://my-mac.tailnet.ts.net:4000')
    expect(res.tunnel).toBe(mockTunnel)
  })

  it('rathole: 토큰 있으면 setupServer → start 순서 + publicUrl 반환', async () => {
    vi.stubEnv('TAPFLOW_TUNNEL_TOKEN', 'secret-token')
    const order: string[] = []
    mockTunnel.setupServer.mockImplementation(async () => { order.push('setupServer') })
    mockTunnel.start.mockImplementation(async () => { order.push('start'); return { publicUrl: 'https://vps.example.com' } })

    const res = await startConfiguredTunnel(
      { provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', ssh: null },
      4000,
    )

    expect(RatholeTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverAddr: 'vps.example.com:2333', token: 'secret-token' }))
    expect(order).toEqual(['setupServer', 'start'])
    expect(res.publicUrl).toBe('https://vps.example.com')
    vi.unstubAllEnvs()
  })

  it('rathole: TAPFLOW_TUNNEL_TOKEN 없으면 warn 후 fallback 반환 (exit 안 함)', async () => {
    vi.unstubAllEnvs()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await startConfiguredTunnel(
      { provider: 'rathole', serverAddr: 'a:1', publicUrl: 'https://a', ssh: null },
      4000,
    )

    expect(exitSpy).not.toHaveBeenCalled()
    expect(RatholeTunnel).not.toHaveBeenCalled()
    expect(res).toEqual({ tunnel: null, publicUrl: null })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TAPFLOW_TUNNEL_TOKEN'))
  })

  it('터널 기동 실패 시 warn 후 { tunnel: null, publicUrl: null } 반환', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTunnel.start.mockRejectedValue(new Error('connection refused'))

    const res = await startConfiguredTunnel({ provider: 'tailscale' }, 4000)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
    expect(res.tunnel).toBeNull()
    expect(res.publicUrl).toBeNull()
  })
})
