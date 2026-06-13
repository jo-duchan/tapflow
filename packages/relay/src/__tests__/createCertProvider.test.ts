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

  it('byo-api-token인데 CLOUDFLARE_API_TOKEN 미설정이면 throw', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '')
    expect(() =>
      createCertProvider({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'cloudflare' }, { dataDir: '/tmp/x' }),
    ).toThrow(/CLOUDFLARE_API_TOKEN/)
  })
})
