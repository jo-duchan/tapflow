import { describe, it, expect } from 'vitest'
import { createRateLimiter } from '../middleware/rateLimit'

// P0-1 — 무차별 대입 방어: IP+계정 실패 카운터 + 지수 백오프
describe('createRateLimiter', () => {
  it('처음에는 허용', () => {
    const rl = createRateLimiter()
    expect(rl.check('k', 0)).toEqual({ allowed: true, retryAfterMs: 0 })
  })

  it('maxAttempts 미만 실패는 잠금 없음', () => {
    const rl = createRateLimiter({ maxAttempts: 5 })
    for (let i = 0; i < 4; i++) rl.recordFailure('k', 0)
    expect(rl.check('k', 0).allowed).toBe(true)
  })

  it('maxAttempts 도달 시 잠금 (다음 시도 거부)', () => {
    const rl = createRateLimiter({ maxAttempts: 5, baseDelayMs: 1000 })
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    const d = rl.check('k', 0)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(1000)
  })

  it('잠금 윈도 경과 후 재허용', () => {
    const rl = createRateLimiter({ maxAttempts: 5, baseDelayMs: 1000 })
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    expect(rl.check('k', 1001).allowed).toBe(true)
  })

  it('연속 실패 시 백오프가 지수적으로 증가', () => {
    const rl = createRateLimiter({ maxAttempts: 5, baseDelayMs: 1000 })
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    expect(rl.check('k', 0).retryAfterMs).toBe(1000) // 5회: base
    rl.recordFailure('k', 0)
    expect(rl.check('k', 0).retryAfterMs).toBe(2000) // 6회: base*2
    rl.recordFailure('k', 0)
    expect(rl.check('k', 0).retryAfterMs).toBe(4000) // 7회: base*4
  })

  it('백오프는 maxDelayMs 상한을 넘지 않음', () => {
    const rl = createRateLimiter({ maxAttempts: 1, baseDelayMs: 1000, maxDelayMs: 5000 })
    for (let i = 0; i < 20; i++) rl.recordFailure('k', 0)
    expect(rl.check('k', 0).retryAfterMs).toBe(5000)
  })

  it('서로 다른 키는 독립적으로 카운트 (한 계정 잠금이 무관한 계정을 막지 않음)', () => {
    const rl = createRateLimiter({ maxAttempts: 5 })
    for (let i = 0; i < 5; i++) rl.recordFailure('ip1|alice', 0)
    expect(rl.check('ip1|alice', 0).allowed).toBe(false)
    expect(rl.check('ip2|bob', 0).allowed).toBe(true)
  })

  it('reset 후 카운터 초기화 (성공 로그인 시)', () => {
    const rl = createRateLimiter({ maxAttempts: 5 })
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    rl.reset('k')
    expect(rl.check('k', 0).allowed).toBe(true)
  })

  it('retention 경과 후 항목 자동 만료 (메모리 누수 방지)', () => {
    const rl = createRateLimiter({ maxAttempts: 1, retentionMs: 1000 })
    rl.recordFailure('k', 0)
    expect(rl.check('k', 0).allowed).toBe(false) // 잠김
    expect(rl.check('k', 1001).allowed).toBe(true) // retention 경과 → 정리 후 허용
  })

  it('maxEntries 초과 시 가장 오래된 항목부터 폐기 (메모리 DoS 방지)', () => {
    const rl = createRateLimiter({ maxAttempts: 1, maxEntries: 3, retentionMs: 9_999_999 })
    for (const k of ['a', 'b', 'c', 'd', 'e']) rl.recordFailure(k, 0)
    // 상한 3 → 가장 오래된 a, b는 폐기되고 c, d, e만 남는다
    expect(rl.check('a', 0).allowed).toBe(true)  // 폐기됨
    expect(rl.check('e', 0).allowed).toBe(false) // 최신, 잠김 유지
  })

  it('활발히 갱신되는 키는 eviction에서 보존 (LRU — 정크로 잠금 우회 방지)', () => {
    const rl = createRateLimiter({ maxAttempts: 1, maxEntries: 3, retentionMs: 9_999_999 })
    rl.recordFailure('victim', 0) // 먼저 삽입되어 잠김
    rl.recordFailure('junk1', 0)
    rl.recordFailure('junk2', 0)
    rl.recordFailure('victim', 0) // 재갱신 → LRU상 맨 뒤로 이동해야 함
    rl.recordFailure('junk3', 0)  // 상한 초과 → 가장 오래된 junk1부터 밀려남
    rl.recordFailure('junk4', 0)  // junk2 밀려남
    expect(rl.check('victim', 0).allowed).toBe(false) // 정크에 밀리지 않고 잠금 유지
  })
})
