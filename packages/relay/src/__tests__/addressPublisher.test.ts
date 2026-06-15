import { describe, it, expect, vi } from 'vitest'
import { startAddressPublisher } from '../lib/cert/addressPublisher.js'
import type { DnsProvider } from '../lib/cert/DnsProvider.js'

function mockProvider(upsert?: (fqdn: string, ip: string) => Promise<void>): DnsProvider {
  return {
    name: 'mock',
    setTxtRecord: async () => {},
    removeTxtRecord: async () => {},
    ...(upsert ? { upsertAddressRecord: upsert } : {}),
  }
}

const tls = { domain: 'tap.example.com', dnsProvider: 'cloudflare' as const }

describe('startAddressPublisher', () => {
  it('부팅 시 감지한 LAN IP로 A 레코드를 1회 발행한다', async () => {
    const upsert = vi.fn(async () => {})
    const stop = startAddressPublisher(tls, { provider: mockProvider(upsert), getIp: async () => '192.168.1.50' })
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledWith('tap.example.com', '192.168.1.50'))
    expect(upsert).toHaveBeenCalledTimes(1)
    stop()
  })

  it('IP가 바뀌면 재발행한다', async () => {
    const upsert = vi.fn(async () => {})
    let ip = '192.168.1.50'
    const stop = startAddressPublisher(tls, { provider: mockProvider(upsert), getIp: async () => ip, intervalMs: 10 })
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    ip = '192.168.1.99'
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledWith('tap.example.com', '192.168.1.99'))
    stop()
  })

  it('같은 IP면 중복 발행하지 않는다', async () => {
    const upsert = vi.fn(async () => {})
    const stop = startAddressPublisher(tls, { provider: mockProvider(upsert), getIp: async () => '192.168.1.50', intervalMs: 10 })
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 40))
    expect(upsert).toHaveBeenCalledTimes(1)
    stop()
  })

  it('같은 IP라도 reassertEveryTicks마다 재발행해 외부 변경을 self-heal한다', async () => {
    const upsert = vi.fn(async () => {})
    const stop = startAddressPublisher(tls, {
      provider: mockProvider(upsert),
      getIp: async () => '192.168.1.50',
      intervalMs: 5,
      reassertEveryTicks: 2,
    })
    // 같은 IP인데도 재확정으로 2회 이상 발행된다(dedup만이면 1회에서 멈춤).
    await vi.waitFor(() => expect(upsert.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 1000 })
    stop()
  })

  it('IP를 못 구하면 발행하지 않는다', async () => {
    const upsert = vi.fn(async () => {})
    const stop = startAddressPublisher(tls, { provider: mockProvider(upsert), getIp: async () => null })
    await new Promise((r) => setTimeout(r, 20))
    expect(upsert).not.toHaveBeenCalled()
    stop()
  })

  it('provider가 upsertAddressRecord를 지원하지 않으면 아무 것도 안 한다(throw 없음)', async () => {
    const stop = startAddressPublisher(tls, { provider: mockProvider(undefined), getIp: async () => '192.168.1.50' })
    expect(stop).toBeTypeOf('function')
    await new Promise((r) => setTimeout(r, 20))
    expect(() => stop()).not.toThrow()
  })

  it('발행 실패 시 throw하지 않고 onError를 호출한다', async () => {
    const err = new Error('api down')
    const upsert = vi.fn(async () => {
      throw err
    })
    const onError = vi.fn()
    const stop = startAddressPublisher(tls, { provider: mockProvider(upsert), getIp: async () => '192.168.1.50', onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err))
    stop()
  })
})
