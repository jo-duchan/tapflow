import { describe, it, expect, afterEach, vi } from 'vitest'
import { createCertProvider } from '../lib/cert/createCertProvider.js'
import { ImportCertProvider } from '../lib/cert/ImportCertProvider.js'
import { AcmeCertProvider } from '../lib/cert/AcmeCertProvider.js'

describe('createCertProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('import-cert 설정이면 ImportCertProvider', () => {
    const p = createCertProvider({ mode: 'import-cert', certPath: '/a.pem', keyPath: '/b.pem' }, { dataDir: '/tmp/x' })
    expect(p).toBeInstanceOf(ImportCertProvider)
    expect(p.strategy).toBe('import-cert')
  })

  it('byo-api-token 설정이면 AcmeCertProvider (토큰 env 필요)', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token')
    const p = createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'cloudflare' }, { dataDir: '/tmp/x' })
    expect(p).toBeInstanceOf(AcmeCertProvider)
    expect(p.strategy).toBe('byo-api-token')
  })

  it('byo-api-token + vercel 설정이면 AcmeCertProvider (VERCEL_TOKEN 필요)', () => {
    vi.stubEnv('VERCEL_TOKEN', 'vc-token')
    const p = createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'vercel' }, { dataDir: '/tmp/x' })
    expect(p).toBeInstanceOf(AcmeCertProvider)
    expect(p.strategy).toBe('byo-api-token')
  })

  it('vercel인데 VERCEL_TOKEN 미설정이면 throw', () => {
    vi.stubEnv('VERCEL_TOKEN', '')
    expect(() =>
      createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'vercel' }, { dataDir: '/tmp/x' }),
    ).toThrow(/VERCEL_TOKEN/)
  })

  it('byo-api-token인데 CLOUDFLARE_API_TOKEN 미설정이면 throw', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '')
    expect(() =>
      createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'cloudflare' }, { dataDir: '/tmp/x' }),
    ).toThrow(/CLOUDFLARE_API_TOKEN/)
  })

  it('레지스트리에 없는 dnsProvider면 throw (available 목록 안내)', () => {
    expect(() =>
      createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'route66' }, { dataDir: '/tmp/x' }),
    ).toThrow(/unknown dnsProvider .*available/)
  })
})
