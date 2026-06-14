import { describe, it, expect } from 'vitest'
import { X509Certificate } from 'crypto'
import { AcmeClientIssuer } from '../lib/cert/AcmeClientIssuer.js'
import { CloudflareDnsProvider } from '../lib/cert/CloudflareDnsProvider.js'
import { DesecDnsProvider } from '../lib/cert/DesecDnsProvider.js'
import type { DnsProvider } from '../lib/cert/DnsProvider.js'
import { parseCertNotAfter } from '../lib/cert/parseCert.js'

// 실제 Let's Encrypt STAGING 발급 통합 테스트. 비밀과 네트워크가 필요하므로 기본 OFF.
// DNS provider는 env로 선택: DESEC_TOKEN이 있으면 deSEC, 없으면 CLOUDFLARE_API_TOKEN으로 Cloudflare.
//
// deSEC로 실행(도메인 없어도 무료 dedyn.io로 가능):
//   1) https://desec.io 가입 → 무료 도메인(예: myteam.dedyn.io) 생성 → API 토큰 발급
//   2) export DESEC_TOKEN=...        # 셸 env로만, 채팅/명령줄 인라인 금지
//   3) TAPFLOW_ACME_SMOKE=1 TAPFLOW_ACME_DOMAIN=myteam.dedyn.io ACME_EMAIL=you@example.com \
//      pnpm --filter @tapflowio/relay exec vitest run src/__tests__/acmeStaging.integration.test.ts
//
// Cloudflare로 실행: export CLOUDFLARE_API_TOKEN=... 후 TAPFLOW_ACME_DOMAIN=tap.your-domain.com
// DNS-01이라 도메인이 공개로 닿을 필요 없음. 챌린지 TXT는 발급 후 자동 정리된다.

const RUN = process.env.TAPFLOW_ACME_SMOKE === '1'
const domain = process.env.TAPFLOW_ACME_DOMAIN ?? ''
const email = process.env.ACME_EMAIL ?? ''
const desecToken = process.env.DESEC_TOKEN ?? ''
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN ?? ''

describe.skipIf(!RUN)('ACME STAGING issuance (integration)', () => {
  it('DNS-01로 실제 LE 스테이징 cert를 발급한다 (deSEC 또는 Cloudflare)', async () => {
    expect(domain, 'set TAPFLOW_ACME_DOMAIN').toBeTruthy()
    expect(desecToken || cloudflareToken, 'set DESEC_TOKEN or CLOUDFLARE_API_TOKEN').toBeTruthy()

    const dns: DnsProvider = desecToken
      ? new DesecDnsProvider({ token: desecToken })
      : new CloudflareDnsProvider({ token: cloudflareToken })
    const issuer = new AcmeClientIssuer({ email, staging: true })

    const issued = await issuer.issue({ domain, dns })

    expect(issued.cert).toContain('BEGIN CERTIFICATE')
    expect(issued.key).toContain('PRIVATE KEY')

    const x = new X509Certificate(issued.cert)
    // eslint-disable-next-line no-console
    console.log(`\n  provider: ${dns.name}`)
    // eslint-disable-next-line no-console
    console.log('  issuer  :', x.issuer.replace(/\n/g, ' '))
    // eslint-disable-next-line no-console
    console.log('  subject :', x.subject)
    // eslint-disable-next-line no-console
    console.log('  notAfter:', x.validTo, '\n')

    expect(x.subject).toContain(domain)
    expect(parseCertNotAfter(issued.cert).getTime()).toBeGreaterThan(Date.now())
    // 스테이징 인증서는 "(STAGING)" 발급자 — 프로덕션으로 새는 일이 없는지 확인
    expect(x.issuer.toUpperCase()).toContain('STAGING')
  }, 180_000)
})
