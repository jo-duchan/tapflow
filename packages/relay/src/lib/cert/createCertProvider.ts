import path from 'path'
import type { CertProvider } from './CertProvider.js'
import type { DnsProvider } from './DnsProvider.js'
import { AcmeCertProvider } from './AcmeCertProvider.js'
import { AcmeClientIssuer } from './AcmeClientIssuer.js'
import { cloudflareDnsFromEnv } from './CloudflareDnsProvider.js'
import { desecDnsFromEnv } from './DesecDnsProvider.js'
import { ImportCertProvider } from './ImportCertProvider.js'
import { DiskCertStore } from './DiskCertStore.js'

// config.tls(비-null)와 동일 형태. cert 라이브러리를 config에 결합하지 않으려 로컬 정의.
export type TlsConfig =
  | { mode: 'byo-api-token'; domain: string; dnsProvider: 'cloudflare' | 'desec' }
  | { mode: 'import-cert'; certPath: string; keyPath: string }

export interface CreateCertProviderDeps {
  dataDir: string
  /** ACME 계정 이메일. 기본 env ACME_EMAIL. */
  email?: string
  /** LE 스테이징 사용(테스트). 기본 env ACME_STAGING === '1'. */
  staging?: boolean
}

/** config.tls를 적절한 CertProvider로 매핑한다. 비밀(토큰)은 env에서 읽는다. */
export function createCertProvider(tls: TlsConfig, deps: CreateCertProviderDeps): CertProvider {
  if (tls.mode === 'import-cert') {
    return new ImportCertProvider({ certPath: tls.certPath, keyPath: tls.keyPath })
  }
  // byo-api-token: 사용자 자기 DNS 계정 토큰으로 DNS-01 (provider별 env에서 토큰)
  const dns: DnsProvider = tls.dnsProvider === 'desec' ? desecDnsFromEnv() : cloudflareDnsFromEnv()
  const issuer = new AcmeClientIssuer({
    email: deps.email ?? process.env.ACME_EMAIL ?? '',
    staging: deps.staging ?? process.env.ACME_STAGING === '1',
  })
  const store = new DiskCertStore(path.join(deps.dataDir, 'tls'))
  return new AcmeCertProvider({ domain: tls.domain, dns, issuer, store })
}
