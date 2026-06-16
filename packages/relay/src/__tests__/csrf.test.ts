import { describe, it, expect } from 'vitest'
import { isCsrfBlocked } from '../lib/csrf'

// #5 — CSRF: 쿠키 인증 상태변경은 same-origin 또는 신뢰 allowlist만 허용
describe('isCsrfBlocked', () => {
  const allowed = new Set(['https://vps.example.com'])
  const cookie = 'tapflow_token=abc'

  it('안전 메서드(GET/HEAD/OPTIONS)는 항상 통과', () => {
    expect(isCsrfBlocked('GET', { cookie, origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(false)
    expect(isCsrfBlocked('HEAD', { cookie }, allowed)).toBe(false)
    expect(isCsrfBlocked('OPTIONS', { cookie }, allowed)).toBe(false)
  })

  it('쿠키 + 상태변경 + same-origin(Origin host == Host) → 통과 (LAN/프록시 대시보드)', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'http://192.168.0.9:4000', host: '192.168.0.9:4000' }, allowed)).toBe(false)
  })

  it('loopback origin은 Host가 달라도 통과 (Vite dev proxy :3001 → relay :4000)', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'http://localhost:3001', host: 'localhost:4000' }, allowed)).toBe(false)
    expect(isCsrfBlocked('POST', { cookie, origin: 'http://127.0.0.1:5173', host: 'localhost:4000' }, allowed)).toBe(false)
    expect(isCsrfBlocked('POST', { cookie, origin: 'http://[::1]:3001', host: 'localhost:4000' }, allowed)).toBe(false)
  })

  it('loopback 예외가 원격 공격 origin을 풀어주지 않는다 (Origin은 위조 불가)', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'https://evil.com', host: 'localhost:4000' }, allowed)).toBe(true)
  })

  it('쿠키 + 상태변경 + cross-origin → 차단', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'https://evil.com', host: '192.168.0.9:4000' }, allowed)).toBe(true)
    expect(isCsrfBlocked('PATCH', { cookie, origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(true)
    expect(isCsrfBlocked('DELETE', { cookie, origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(true)
  })

  it('Origin이 신뢰 allowlist에 있으면 통과 (프록시가 Host를 바꿔도)', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'https://vps.example.com', host: 'localhost:4000' }, allowed)).toBe(false)
  })

  it('PAT(Authorization) 인증은 면제', () => {
    expect(isCsrfBlocked('POST', { authorization: 'Bearer tflw_pat_x', origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(false)
  })

  it('쿠키 없음(미인증/login/init) → 차단하지 않음', () => {
    expect(isCsrfBlocked('POST', { origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(false)
    expect(isCsrfBlocked('POST', { cookie: 'other=1', origin: 'https://evil.com', host: 'x:4000' }, allowed)).toBe(false)
  })

  it('Origin 헤더 없음(비-브라우저) → 차단하지 않음', () => {
    expect(isCsrfBlocked('POST', { cookie, host: 'x:4000' }, allowed)).toBe(false)
  })

  it('malformed Origin → cross-origin으로 간주, 차단', () => {
    expect(isCsrfBlocked('POST', { cookie, origin: 'not-a-url', host: 'x:4000' }, allowed)).toBe(true)
  })
})
