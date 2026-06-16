import { describe, it, expect } from 'vitest'
import { buildCorsOrigins, proxyWithoutPublicUrlWarning } from '../lib/proxyConfig.js'
import type { TapflowConfig } from '../lib/config.js'

function cfg(over: Partial<{ trustedProxies: string[]; publicUrl: string; relayUrl: string }> = {}): Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'> {
  return {
    tunnel: over.publicUrl ? ({ provider: 'tailscale', publicUrl: over.publicUrl } as TapflowConfig['tunnel']) : null,
    relay: { url: over.relayUrl ?? null },
    local: { port: 4000, dataDir: '.', wsBackpressureBytes: 1, trustedProxies: over.trustedProxies ?? [] },
  }
}

describe('buildCorsOrigins', () => {
  it('공개 URL 없으면 loopback만', () => {
    expect(buildCorsOrigins(cfg(), 4000)).toEqual(['http://localhost:4000', 'http://127.0.0.1:4000'])
  })

  it('tunnel.publicUrl이 origin으로(경로 제거) 포함된다', () => {
    expect(buildCorsOrigins(cfg({ publicUrl: 'https://tap.example.com/path' }), 4000)).toEqual([
      'https://tap.example.com',
      'http://localhost:4000',
      'http://127.0.0.1:4000',
    ])
  })

  it('relay.url(ws)이 http(s) origin으로 변환돼 포함된다', () => {
    expect(buildCorsOrigins(cfg({ relayUrl: 'wss://relay.example.com:8443' }), 4000)).toContain('https://relay.example.com:8443')
  })

  it('공개 URL 없이 --port 오버라이드면 runtime port loopback만(config port stale 미포함)', () => {
    // cfg()는 local.port=4000인데 runtime port는 8080
    expect(buildCorsOrigins(cfg(), 8080)).toEqual(['http://localhost:8080', 'http://127.0.0.1:8080'])
  })

  it('공개 URL 있으면 --port 오버라이드여도 공개 origin + runtime port loopback', () => {
    expect(buildCorsOrigins(cfg({ publicUrl: 'https://tap.example.com' }), 8080)).toEqual([
      'https://tap.example.com',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
    ])
  })
})

describe('proxyWithoutPublicUrlWarning', () => {
  it('trustedProxies 있고 공개 URL 없으면 경고', () => {
    expect(proxyWithoutPublicUrlWarning(cfg({ trustedProxies: ['127.0.0.1'] }))).toMatch(/TAPFLOW_TRUSTED_PROXIES/)
  })

  it('trustedProxies 있어도 공개 URL 있으면 null', () => {
    expect(proxyWithoutPublicUrlWarning(cfg({ trustedProxies: ['127.0.0.1'], publicUrl: 'https://tap.example.com' }))).toBeNull()
  })

  it('trustedProxies 없으면 null', () => {
    expect(proxyWithoutPublicUrlWarning(cfg())).toBeNull()
  })
})
