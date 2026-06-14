import type { CertProvider, CertMaterial, CertStrategy } from './CertProvider.js'
import type { DnsProvider } from './DnsProvider.js'

const DAY = 24 * 60 * 60 * 1000
const RENEW_THRESHOLD_DAYS = 30

/** 발급된 인증서 자료(만료 포함). */
export interface IssuedCert {
  cert: string
  key: string
  expiresAt: Date
}

/**
 * ACME 발급 추상화. 실제 Let's Encrypt 왕복은 AcmeClientIssuer가 구현하고,
 * 단위 테스트는 fake가 구현한다. 키는 issuer 내부(로컬)에서 생성된다.
 */
export interface AcmeIssuer {
  issue(opts: { domain: string; dns: DnsProvider }): Promise<IssuedCert>
}

/** cert 영속화 추상화. 기본은 in-memory, 디스크 구현은 갱신 스케줄러 단계에서 주입. */
export interface CertStore {
  load(): Promise<CertMaterial | null>
  save(material: CertMaterial): Promise<void>
}

export class InMemoryCertStore implements CertStore {
  private material: CertMaterial | null = null
  async load(): Promise<CertMaterial | null> {
    return this.material
  }
  async save(material: CertMaterial): Promise<void> {
    this.material = material
  }
}

export interface AcmeCertProviderOptions {
  domain: string
  dns: DnsProvider
  issuer: AcmeIssuer
  store?: CertStore
  /** 테스트용 시계. 기본 Date.now. */
  now?: () => number
  renewThresholdDays?: number
}

/**
 * BYO API 토큰 경로의 CertProvider. 로컬에서 발급/갱신하며 키를 외부로 내보내지 않는다.
 */
export class AcmeCertProvider implements CertProvider {
  readonly strategy: CertStrategy = 'byo-api-token'
  private readonly domain: string
  private readonly dns: DnsProvider
  private readonly issuer: AcmeIssuer
  private readonly store: CertStore
  private readonly now: () => number
  private readonly thresholdMs: number
  // 진행 중 발급을 공유해 동시 호출이 중복 ACME 주문(→ CA 한도)을 내지 않게 한다(single-flight).
  private inflight: Promise<CertMaterial> | null = null

  constructor(opts: AcmeCertProviderOptions) {
    this.domain = opts.domain
    this.dns = opts.dns
    this.issuer = opts.issuer
    this.store = opts.store ?? new InMemoryCertStore()
    this.now = opts.now ?? Date.now
    this.thresholdMs = (opts.renewThresholdDays ?? RENEW_THRESHOLD_DAYS) * DAY
  }

  async ensureCert(): Promise<CertMaterial> {
    const existing = await this.store.load()
    if (existing && existing.expiresAt.getTime() > this.now()) return existing
    return this.issueAndStore()
  }

  async renewIfNeeded(): Promise<CertMaterial | null> {
    const cur = await this.ensureCert()
    if (cur.expiresAt.getTime() - this.now() > this.thresholdMs) return null
    return this.issueAndStore()
  }

  private issueAndStore(): Promise<CertMaterial> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        const issued = await this.issuer.issue({ domain: this.domain, dns: this.dns })
        const material: CertMaterial = { cert: issued.cert, key: issued.key, expiresAt: issued.expiresAt }
        await this.store.save(material)
        return material
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}
