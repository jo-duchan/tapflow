import { createLogger } from '@tapflowio/agent-core'
import type { CertProvider, CertMaterial } from './CertProvider.js'

const logger = createLogger('relay:cert')

// ACME 클라이언트 관례대로 하루 두 번 점검. 실제 발급은 만료 30일 이내일 때만 일어난다.
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000

export interface CertRenewalOptions {
  intervalMs?: number
  /** 갱신이 일어났을 때(새 자료) 호출 — 예: relay TLS 컨텍스트 핫스왑. */
  onRenew?: (material: CertMaterial) => void
  /** 갱신 중 오류. 미지정 시 경고 로그. 절대 전파하지 않는다. */
  onError?: (err: unknown) => void
}

/** 1회 점검 — renewIfNeeded 호출, 갱신 시 onRenew, 오류는 삼키고 onError/로그. */
export async function renewalTick(provider: CertProvider, opts: CertRenewalOptions = {}): Promise<void> {
  try {
    const renewed = await provider.renewIfNeeded()
    if (renewed) opts.onRenew?.(renewed)
  } catch (err) {
    if (opts.onError) opts.onError(err)
    else logger.warn(`cert renewal failed: ${String(err)}`)
  }
}

/** 주기 갱신 타이머를 시작하고 정지 함수를 반환한다. */
export function startCertRenewal(provider: CertProvider, opts: CertRenewalOptions = {}): () => void {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const timer = setInterval(() => {
    void renewalTick(provider, opts)
  }, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}
