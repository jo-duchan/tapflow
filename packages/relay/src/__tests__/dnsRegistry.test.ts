import { describe, it, expect, afterEach, vi } from 'vitest'
import { dnsProviders } from '../lib/cert/dnsRegistry.js'
import { CloudflareDnsProvider } from '../lib/cert/CloudflareDnsProvider.js'

describe('dnsProviders registry', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('빌트인 cloudflare/vercel이 등록돼 있다', () => {
    expect(dnsProviders.has('cloudflare')).toBe(true)
    expect(dnsProviders.has('vercel')).toBe(true)
    expect(dnsProviders.names()).toEqual(expect.arrayContaining(['cloudflare', 'vercel']))
  })

  it('각 엔트리는 라벨·힌트·envVars를 들고 있다(wizard용)', () => {
    const cf = dnsProviders.get('cloudflare')
    expect(cf?.label).toBeTruthy()
    expect(cf?.envVars).toContain('CLOUDFLARE_API_TOKEN')
  })

  it('알 수 없는 provider는 undefined / has=false', () => {
    expect(dnsProviders.has('nope')).toBe(false)
    expect(dnsProviders.get('nope')).toBeUndefined()
  })

  it('fromEnv가 env에서 DnsProvider를 만든다', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token')
    const dns = dnsProviders.get('cloudflare')!.fromEnv()
    expect(dns).toBeInstanceOf(CloudflareDnsProvider)
    expect(dns.name).toBe('cloudflare')
  })

  it('register로 커스텀 provider를 추가할 수 있다(OCP)', () => {
    const fake = { name: 'fake-dns', setTxtRecord: async () => {}, removeTxtRecord: async () => {} }
    dnsProviders.register({ name: 'fake-dns', label: 'Fake', hint: 'h', envVars: ['FAKE_TOKEN'], fromEnv: () => fake })
    expect(dnsProviders.has('fake-dns')).toBe(true)
    expect(dnsProviders.get('fake-dns')!.fromEnv().name).toBe('fake-dns')
  })
})
