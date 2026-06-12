// P0-1 — 인증 엔드포인트의 무차별 대입 방어. 인메모리 IP+계정 실패 카운터 + 지수 백오프.
// 단일 인스턴스(t3.small) 전제이므로 영속화 없이 프로세스 메모리에 둔다.

interface Attempt {
  failures: number
  lockedUntil: number
  // 마지막 활동 + retentionMs. 지나면 항목을 폐기한다(메모리 누수/DoS 방지).
  expiresAt: number
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
  // 마지막 활동 후 항목을 보존할 기간. 키는 IP+계정이라 공격자가 무한히 만들 수 있으므로 만료시킨다.
  retentionMs?: number
  // store 항목 수 상한. 초과 시 만료 항목을 정리하고, 그래도 넘으면 가장 오래된 항목부터 폐기.
  maxEntries?: number
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const maxAttempts = opts.maxAttempts ?? 5
  const baseDelayMs = opts.baseDelayMs ?? 1_000
  const maxDelayMs = opts.maxDelayMs ?? 15 * 60 * 1_000
  const retentionMs = opts.retentionMs ?? maxDelayMs
  const maxEntries = opts.maxEntries ?? 10_000
  const store = new Map<string, Attempt>()

  function check(key: string, now = Date.now()): RateLimitDecision {
    const a = store.get(key)
    if (!a) return { allowed: true, retryAfterMs: 0 }
    if (a.expiresAt <= now) {
      store.delete(key)
      return { allowed: true, retryAfterMs: 0 }
    }
    if (a.lockedUntil > now) return { allowed: false, retryAfterMs: a.lockedUntil - now }
    return { allowed: true, retryAfterMs: 0 }
  }

  function evictIfNeeded(now: number): void {
    if (store.size <= maxEntries) return
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k)
    // 만료만으로 부족하면 삽입 순서상 가장 오래된 항목부터 폐기.
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }

  function recordFailure(key: string, now = Date.now()): void {
    const a = store.get(key) ?? { failures: 0, lockedUntil: 0, expiresAt: 0 }
    a.failures += 1
    if (a.failures >= maxAttempts) {
      const over = a.failures - maxAttempts
      a.lockedUntil = now + Math.min(baseDelayMs * 2 ** over, maxDelayMs)
    }
    a.expiresAt = now + retentionMs
    store.set(key, a)
    evictIfNeeded(now)
  }

  function reset(key: string): void {
    store.delete(key)
  }

  return { check, recordFailure, reset }
}
