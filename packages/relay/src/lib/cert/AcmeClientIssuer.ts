import * as acme from 'acme-client'
import type { DnsProvider } from './DnsProvider.js'
import type { AcmeIssuer, IssuedCert } from './AcmeCertProvider.js'
import { parseCertNotAfter } from './parseCert.js'

// 실제 Let's Encrypt 발급 — acme-client `auto()`에 DNS-01 챌린지 콜백으로 DnsProvider를 연결한다.
// 네트워크 왕복이라 단위 테스트 대상이 아니다(통합/수동 검증). 키는 여기 로컬에서 생성된다.

export interface AcmeClientIssuerOptions {
  /** ACME 계정 이메일. */
  email: string
  /** true면 LE 스테이징(테스트), 기본은 프로덕션. */
  staging?: boolean
  /** 영속화된 계정 키(PEM). 없으면 발급 시 새로 생성. */
  accountKey?: Buffer | string
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

    const cert = await client.auto({
      csr,
      email: this.opts.email,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        await dns.setTxtRecord(domain, keyAuthorization)
      },
      challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
        await dns.removeTxtRecord(domain, keyAuthorization)
      },
    })

    return { cert, key: key.toString(), expiresAt: parseCertNotAfter(cert) }
  }
}
