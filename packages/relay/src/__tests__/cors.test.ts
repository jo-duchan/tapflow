import { describe, it, expect } from 'vitest'
import { resolveCorsHeaders } from '../lib/cors'

// #4 — CORS 출처 제한: 허용 목록에 든 origin만 에코, PAT의 cross-origin 사용 차단
describe('resolveCorsHeaders', () => {
  const allowed = new Set(['https://vps.example.com', 'http://localhost:4000'])

  it('Origin 헤더 없음(same-origin/CLI) → CORS 헤더 없음', () => {
    expect(resolveCorsHeaders(undefined, allowed)).toBeNull()
  })

  it('허용 목록에 든 origin → 그 origin을 에코', () => {
    const h = resolveCorsHeaders('https://vps.example.com', allowed)
    expect(h?.['Access-Control-Allow-Origin']).toBe('https://vps.example.com')
    expect(h?.['Vary']).toBe('Origin')
  })

  it('허용 목록 밖의 origin → null (CORS 헤더 미부여 → 브라우저 차단)', () => {
    expect(resolveCorsHeaders('https://evil.example.com', allowed)).toBeNull()
  })

  it('와일드카드(*)를 절대 반환하지 않는다 (PAT cross-origin 차단)', () => {
    const h = resolveCorsHeaders('http://localhost:4000', allowed)
    expect(h?.['Access-Control-Allow-Origin']).not.toBe('*')
    expect(h?.['Access-Control-Allow-Origin']).toBe('http://localhost:4000')
  })

  it('빈 allowlist → 모든 origin 거부', () => {
    expect(resolveCorsHeaders('https://vps.example.com', new Set())).toBeNull()
  })
})
