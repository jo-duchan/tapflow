import * as acme from 'acme-client'
import { createLogger } from '@tapflowio/agent-core'
import type { DnsProvider } from './DnsProvider.js'
import type { AcmeIssuer, IssuedCert } from './AcmeCertProvider.js'
import { parseCertNotAfter } from './parseCert.js'
import { loadOrCreateAccountKey } from './accountKey.js'

const logger = createLogger('relay:acme')

// 실제 Let's Encrypt 발급 — acme-client `auto()`에 DNS-01 챌린지 콜백으로 DnsProvider를 연결한다.
// 네트워크 왕복이라 단위 테스트 대상이 아니다(통합/수동 검증). 키는 여기 로컬에서 생성된다.

export interface AcmeClientIssuerOptions {
  /** ACME 계정 이메일. 빈 값이면 생략. */
  email: string
  /** true면 LE 스테이징(테스트), 기본은 프로덕션. */
  staging?: boolean
  /** 영속화된 계정 키(PEM) 직접 주입. */
  accountKey?: Buffer | string
  /** 계정 키를 캐시할 파일 경로 — 없으면 읽고, 없으면 생성·저장(매 발급마다 새 LE 계정 방지). */
  accountKeyPath?: string
  /** TXT 설정 후 LE 검증 전 고정 전파 대기(ms). 기본 60초. */
  dnsPropagationMs?: number
}

// DNS-01 TXT 전파를 위한 고정 대기. 폴링/권위조회는 재귀 리졸버 음성캐시에 취약해 단순 고정 대기를 쓴다.
const DEFAULT_DNS_PROPAGATION_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AcmeClientIssuer implements AcmeIssuer {
  constructor(private readonly opts: AcmeClientIssuerOptions) {}

  async issue({ domain, dns }: { domain: string; dns: DnsProvider }): Promise<IssuedCert> {
    const accountKey =
      this.opts.accountKey ??
      (this.opts.accountKeyPath
        ? await loadOrCreateAccountKey(this.opts.accountKeyPath, async () => (await acme.crypto.createPrivateKey()).toString())
        : await acme.crypto.createPrivateKey())
    const client = new acme.Client({
      directoryUrl: this.opts.staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey,
    })

    const [key, csr] = await acme.crypto.createCsr({ commonName: domain })

    const propagationMs = this.opts.dnsPropagationMs ?? DEFAULT_DNS_PROPAGATION_MS

    logger.info(`requesting ${this.opts.staging ? 'STAGING' : 'production'} cert for ${domain} via ${dns.name} (dns-01)`)

    const cert = await client.auto({
      csr,
      email: this.opts.email || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      // 우리가 고정 전파 대기를 하므로 acme-client 내부 DNS 재확인은 생략한다(재귀 음성캐시로 정체될 수 있음).
      // 검증은 LE에 맡긴다(LE는 권위 NS를 직접 조회).
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        logger.info(`setting _acme-challenge.${domain} TXT`)
        await dns.setTxtRecord(domain, keyAuthorization)
        logger.info(`TXT set; waiting ${propagationMs}ms for propagation before LE validation`)
        if (propagationMs > 0) await sleep(propagationMs)
        logger.info('handing challenge to ACME for validation')
      },
      challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
        await dns.removeTxtRecord(domain, keyAuthorization)
      },
    })

    logger.info(`cert issued for ${domain}`)
    return { cert, key: key.toString(), expiresAt: parseCertNotAfter(cert) }
  }
}
