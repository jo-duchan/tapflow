// LAN HTTPS — cert/TLS 인터페이스 (issue #232). 터널(도달성)과 직교하는 TLS 축.
// 구현은 개인키를 로컬에서만 생성·보관하며 외부로 내보내지 않는다(키 locality).

/** relay가 https 종단에 쓰는 PEM 자료. key는 이 프로세스 밖으로 나가지 않는다. */
export interface CertMaterial {
  /** PEM 인증서 체인 (leaf + intermediates). */
  cert: string
  /** PEM 개인키. */
  key: string
  /** 만료 시각 — 갱신 판단에 사용. */
  expiresAt: Date
}

/**
 * cert 발급 전략 — 도달성 모드별로 다른 경로를 추상화한다.
 * v1: 'byo-api-token'(자기 DNS 계정 DNS-01, 주력) | 'import-cert'(기존 cert 로드).
 * 후속: 'tailscale'(Tailscale 자체 cert) | 'free-subdomain' | 'byo-cname' | 'local-ca'.
 */
export type CertStrategy = 'byo-api-token' | 'import-cert'

/**
 * 인증서 공급 계약. relay가 시작 시 ensureCert()로 자료를 확보하고,
 * 스케줄러가 renewIfNeeded()를 주기 호출한다.
 */
export interface CertProvider {
  readonly strategy: CertStrategy
  /** 유효한 cert 확보(없으면 발급/로드). 멱등 — 이미 유효하면 기존 자료를 반환. */
  ensureCert(): Promise<CertMaterial>
  /**
   * 만료 임박(잔여 ~30일 이하)일 때만 갱신하고 새 자료를 반환.
   * 충분히 남았으면 갱신하지 않고 null(중복 발급 한도 방어 — 부팅마다 재발급 금지).
   */
  renewIfNeeded(): Promise<CertMaterial | null>
}
