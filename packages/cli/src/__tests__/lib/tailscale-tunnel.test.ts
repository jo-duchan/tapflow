import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'child_process'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'

const RUNNING_WITH_DNS = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'my-mac.tailnet-test.ts.net.',
    TailscaleIPs: ['100.64.1.2', 'fd7a::1'],
  },
})

const RUNNING_WITHOUT_DNS = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: '',
    TailscaleIPs: ['100.64.1.2'],
  },
})

const RUNNING_IPV6_ONLY = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: '',
    TailscaleIPs: ['fd7a:115c:a1e0::1'],
  },
})

describe('TailscaleTunnel', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(execSync).mockReturnValue(Buffer.from('') as never)
  })

  it('setupServer() — no-op, execSync 미호출', async () => {
    const tunnel = new TailscaleTunnel({})
    await expect(tunnel.setupServer()).resolves.toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('stop() — no-op, execSync 미호출', async () => {
    const tunnel = new TailscaleTunnel({})
    await expect(tunnel.stop()).resolves.toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('start() — publicUrl 설정 시 tailscale 없이 즉시 반환', async () => {
    const tunnel = new TailscaleTunnel({ publicUrl: 'http://my.custom.url:4000' })
    const result = await tunnel.start(4000)
    expect(result.publicUrl).toBe('http://my.custom.url:4000')
    expect(execSync).not.toHaveBeenCalled()
  })

  it('start() — Tailscale 미설치 → 에러 + 설치 안내', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command not found') })
    const tunnel = new TailscaleTunnel({})
    const error = await tunnel.start(4000).catch((e: Error) => e)
    expect(error.message).toMatch(/not installed/)
    expect(error.message).toMatch(/brew install tailscale/)
  })

  it('start() — Running + MagicDNS → DNS 이름으로 URL 반환 (trailing dot 제거)', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_WITH_DNS) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(4000)
    expect(result.publicUrl).toBe('http://my-mac.tailnet-test.ts.net:4000')
  })

  it('start() — Running + MagicDNS 없음 → tailnet IP로 URL 반환', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_WITHOUT_DNS) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(4000)
    expect(result.publicUrl).toBe('http://100.64.1.2:4000')
  })

  it('start() — IPv6 전용 → 브래킷 URL 반환', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_IPV6_ONLY) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(4000)
    expect(result.publicUrl).toBe('http://[fd7a:115c:a1e0::1]:4000')
  })

  it('start() — IPv4 + IPv6 혼재 → IPv4 우선 선택', async () => {
    const mixed = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: '', TailscaleIPs: ['fd7a::1', '100.64.1.2'] },
    })
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(mixed) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(4000)
    expect(result.publicUrl).toBe('http://100.64.1.2:4000')
  })

  it('start() — BackendState !== Running → 에러 + tailscale up 안내', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(JSON.stringify({ BackendState: 'Stopped', Self: {} })) as never)
    const tunnel = new TailscaleTunnel({})
    const error = await tunnel.start(4000).catch((e: Error) => e)
    expect(error.message).toMatch(/not connected/)
    expect(error.message).toMatch(/tailscale up/)
  })
})
