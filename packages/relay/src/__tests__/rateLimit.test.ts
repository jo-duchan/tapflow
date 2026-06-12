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
})
