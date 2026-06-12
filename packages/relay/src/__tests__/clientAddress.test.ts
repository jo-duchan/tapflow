import { describe, it, expect } from 'vitest'
import { resolveClientAddress, parseTrustedProxies } from '../lib/clientAddress'

// ⑤ trusted-proxy — same-host 리버스 프록시 뒤에서 loopback 무인증 우회 차단
describe('resolveClientAddress', () => {
  it('1. 설정 없음(기본) — loopback 소켓은 그대로 로컬 (BC)', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: undefined, trustedProxies: [] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: true })
  })

  it('2. 신뢰 프록시 + XFF 사설 IP → 원격(PAT 요구)', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '192.168.0.9', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '192.168.0.9', isLocal: false })
  })

  it('3. 신뢰 프록시 + XFF loopback → 진짜 로컬 경유', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: true })
  })

  it('4. 비신뢰 출발지의 XFF 스푸핑 → XFF 무시', () => {
    const r = resolveClientAddress({ socketAddr: '203.0.113.5', forwardedFor: '127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '203.0.113.5', isLocal: false })
  })

  it('5. 신뢰 프록시 + XFF 없음 → 안전 기본(원격 간주)', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: undefined, trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: false })
  })

  it('6. XFF 체인 다중 IP → 최좌측(원 클라이언트) 사용', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '192.168.0.9, 10.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '192.168.0.9', isLocal: false })
  })

  it('7. IPv4-mapped IPv6 소켓 → loopback으로 정규화', () => {
    const r = resolveClientAddress({ socketAddr: '::ffff:127.0.0.1', forwardedFor: undefined, trustedProxies: [] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: true })
  })

  it('8. (회귀) 직접 LAN 연결 — 설정 무관하게 원격 (#271 동작 유지)', () => {
    const r = resolveClientAddress({ socketAddr: '192.168.0.9', forwardedFor: undefined, trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '192.168.0.9', isLocal: false })
  })

  it('IPv6 loopback ::1 도 로컬', () => {
    expect(resolveClientAddress({ socketAddr: '::1', forwardedFor: undefined, trustedProxies: [] }))
      .toEqual({ addr: '::1', isLocal: true })
  })

  it('신뢰 프록시가 IPv4-mapped IPv6로 도착해도 매칭', () => {
    const r = resolveClientAddress({ socketAddr: '::ffff:127.0.0.1', forwardedFor: '192.168.0.9', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '192.168.0.9', isLocal: false })
  })

  it('신뢰 프록시 + XFF에 IPv4-mapped 원 IP → 정규화 후 판정', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '::ffff:127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: true })
  })
})

describe('parseTrustedProxies', () => {
  it('미설정/빈 문자열 → 빈 배열 (기본 비활성)', () => {
    expect(parseTrustedProxies(undefined)).toEqual([])
    expect(parseTrustedProxies('')).toEqual([])
    expect(parseTrustedProxies('   ')).toEqual([])
  })

  it('콤마 구분 목록을 정규화해 파싱', () => {
    expect(parseTrustedProxies('127.0.0.1, ::1')).toEqual(['127.0.0.1', '::1'])
  })

  it('IPv4-mapped IPv6 항목을 정규화', () => {
    expect(parseTrustedProxies('::ffff:127.0.0.1')).toEqual(['127.0.0.1'])
  })
})
