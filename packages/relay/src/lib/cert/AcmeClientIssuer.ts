import * as acme from 'acme-client'
import { createLogger } from '@tapflowio/agent-core'
import type { DnsProvider } from './DnsProvider.js'
import type { AcmeIssuer, IssuedCert } from './AcmeCertProvider.js'
import { parseCertNotAfter } from './parseCert.js'

const logger = createLogger('relay:acme')

// 실제 Let's Encrypt 발급 — acme-client `auto()`에 DNS-01 챌린지 콜백으로 DnsProvider를 연결한다.
// 네트워크 왕복이라 단위 테스트 대상이 아니다(통합/수동 검증). 키는 여기 로컬에서 생성된다.

export interface AcmeClientIssuerOptions {
  /** ACME 계정 이메일. 빈 값이면 생략. */
  email: string
  /** true면 LE 스테이징(테스트), 기본은 프로덕션. */
  staging?: boolean
  /** 영속화된 계정 키(PEM). 없으면 발급 시 새로 생성. */
  accountKey?: Buffer | string
  /** TXT 설정 후 LE 검증 전 전파 대기(ms). DNS-01 신뢰성용. 기본 15초. */
  dnsPropagationMs?: number
}

const DEFAULT_DNS_PROPAGATION_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AcmeClientIssuer implements AcmeIssuer {
  constructor(private readonly opts: AcmeClientIssuerOptions) {}

  async issue({ domain, dns }: { domain: string; dns: DnsProvider }): Promise<IssuedCert> {
    const accountKey = this.opts.accountKey ?? (await acme.crypto.createPrivateKey())
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
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        logger.info(`setting _acme-challenge.${domain} TXT`)
        await dns.setTxtRecord(domain, keyAuthorization)
        // LE가 검증하기 전에 TXT가 전파되도록 대기.
        logger.info(`TXT set; waiting ${propagationMs}ms for propagation before validation`)
        if (propagationMs > 0) await sleep(propagationMs)
        logger.info('propagation wait done; handing challenge to ACME for validation')
      },
      challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
        await dns.removeTxtRecord(domain, keyAuthorization)
      },
    })

    logger.info(`cert issued for ${domain}`)
    return { cert, key: key.toString(), expiresAt: parseCertNotAfter(cert) }
  }
}
