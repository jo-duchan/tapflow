import { describe, it, expect } from 'vitest'
import { buildInviteBaseUrl } from '../lib/publicUrl'

// #6 — Host 인젝션 차단: 초대 링크 base를 Host 헤더가 아닌 설정값에서만 도출
describe('buildInviteBaseUrl', () => {
  const local = { port: 4000, dataDir: '.tapflow-data', wsBackpressureBytes: 1, trustedProxies: [] }

  it('터널 공개 URL이 있으면 그것을 사용 (trailing slash 제거)', () => {
    expect(buildInviteBaseUrl({ tunnel: { provider: 'tailscale', publicUrl: 'https://mac.ts.net:4000/' }, relay: { url: null }, local }))
      .toBe('https://mac.ts.net:4000')
  })

  it('relay.url ws:// → http:// 변환', () => {
    expect(buildInviteBaseUrl({ tunnel: null, relay: { url: 'ws://192.168.0.9:4000' }, local }))
      .toBe('http://192.168.0.9:4000')
  })

  it('relay.url wss:// → https:// 변환', () => {
    expect(buildInviteBaseUrl({ tunnel: null, relay: { url: 'wss://relay.example.com' }, local }))
      .toBe('https://relay.example.com')
  })

  it('설정이 없으면 localhost:port 폴백', () => {
    expect(buildInviteBaseUrl({ tunnel: null, relay: { url: null }, local }))
      .toBe('http://localhost:4000')
  })

  it('터널 공개 URL이 relay.url보다 우선', () => {
    expect(buildInviteBaseUrl({ tunnel: { provider: 'rathole', serverAddr: 'x:2333', publicUrl: 'https://vps.example.com', ssh: null }, relay: { url: 'ws://localhost:4000' }, local }))
      .toBe('https://vps.example.com')
  })

  it('tailscale 터널이지만 publicUrl 미설정이면 relay.url로 폴백', () => {
    expect(buildInviteBaseUrl({ tunnel: { provider: 'tailscale', publicUrl: undefined }, relay: { url: 'wss://relay.example.com' }, local }))
      .toBe('https://relay.example.com')
  })
})
