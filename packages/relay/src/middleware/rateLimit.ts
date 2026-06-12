// P0-1 — 인증 엔드포인트의 무차별 대입 방어. 인메모리 IP+계정 실패 카운터 + 지수 백오프.
// 단일 인스턴스(t3.small) 전제이므로 영속화 없이 프로세스 메모리에 둔다.

interface Attempt {
  failures: number
  lockedUntil: number
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterMs: number
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitDecision
  recordFailure(key: string, now?: number): void
  reset(key: string): void
}

export interface RateLimiterOptions {
  // 잠금 없이 허용할 연속 실패 횟수.
  maxAttempts?: number
  // maxAttempts 초과 첫 잠금의 지연(이후 매 실패마다 2배).
  baseDelayMs?: number
  // 지수 백오프 상한.
  maxDelayMs?: number
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const maxAttempts = opts.maxAttempts ?? 5
  const baseDelayMs = opts.baseDelayMs ?? 1_000
  const maxDelayMs = opts.maxDelayMs ?? 15 * 60 * 1_000
  const store = new Map<string, Attempt>()

  function check(key: string, now = Date.now()): RateLimitDecision {
    const a = store.get(key)
    if (a && a.lockedUntil > now) return { allowed: false, retryAfterMs: a.lockedUntil - now }
    return { allowed: true, retryAfterMs: 0 }
  }

  function recordFailure(key: string, now = Date.now()): void {
    const a = store.get(key) ?? { failures: 0, lockedUntil: 0 }
    a.failures += 1
    if (a.failures >= maxAttempts) {
      const over = a.failures - maxAttempts
      a.lockedUntil = now + Math.min(baseDelayMs * 2 ** over, maxDelayMs)
    }
    store.set(key, a)
  }

  function reset(key: string): void {
    store.delete(key)
  }

  return { check, recordFailure, reset }
}
