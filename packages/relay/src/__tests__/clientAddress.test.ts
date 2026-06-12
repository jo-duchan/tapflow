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

  it('3. 신뢰 프록시 목록에 loopback 포함 시 XFF loopback도 프록시로 간주 → 안전하게 원격', () => {
    // trustedProxies=[127.0.0.1]이면 XFF의 127.0.0.1이 프록시인지 진짜 로컬인지 구분 불가.
    // 안전 우선: 우측부터 벗겨내고 남는 게 없으면 원격으로 본다(스푸핑한 loopback을 신뢰하지 않는다).
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: false })
  })

  it('4. 비신뢰 출발지의 XFF 스푸핑 → XFF 무시', () => {
    const r = resolveClientAddress({ socketAddr: '203.0.113.5', forwardedFor: '127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '203.0.113.5', isLocal: false })
  })

  it('5. 신뢰 프록시 IP지만 XFF 없음 → 직접 접근으로 간주(프록시는 항상 XFF 추가), 소켓 판정', () => {
    // 호스트에서 직접 붙는 admin init / CLI / agent가 막히지 않도록 loopback 소켓은 로컬.
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: undefined, trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: true })
  })

  it('6. XFF 체인 다중 IP → 우측(프록시 관찰)부터 비신뢰 첫 IP 사용 (최좌측은 클라이언트가 스푸핑 가능)', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '192.168.0.9, 10.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '10.0.0.1', isLocal: false })
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

  it('신뢰 프록시 + XFF가 정규화 후 신뢰 프록시와 동일(loopback) → 프록시로 간주, 원격', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '::ffff:127.0.0.1', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '127.0.0.1', isLocal: false })
  })

  it('보안: 공격자가 XFF에 loopback 주입(프록시가 실제 IP를 append) → 우측 실제 IP 사용, 스푸핑 무력화', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '127.0.0.1, 203.0.113.5', trustedProxies: ['127.0.0.1'] })
    expect(r).toEqual({ addr: '203.0.113.5', isLocal: false })
  })

  it('다중 신뢰 프록시 체인 → 우측부터 모두 벗기고 첫 비신뢰 IP', () => {
    const r = resolveClientAddress({ socketAddr: '127.0.0.1', forwardedFor: '203.0.113.5, 10.0.0.1', trustedProxies: ['127.0.0.1', '10.0.0.1'] })
    expect(r).toEqual({ addr: '203.0.113.5', isLocal: false })
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
