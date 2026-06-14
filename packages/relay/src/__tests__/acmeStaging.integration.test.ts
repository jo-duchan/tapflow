import { describe, it, expect } from 'vitest'
import { X509Certificate } from 'crypto'
import { AcmeClientIssuer } from '../lib/cert/AcmeClientIssuer.js'
import { CloudflareDnsProvider } from '../lib/cert/CloudflareDnsProvider.js'
import { parseCertNotAfter } from '../lib/cert/parseCert.js'

// 실제 Let's Encrypt STAGING 발급 통합 테스트. 비밀과 네트워크가 필요하므로 기본 OFF.
// 실행:
//   TAPFLOW_ACME_SMOKE=1 \
//   TAPFLOW_ACME_DOMAIN=tap-staging.your-domain.com \
//   ACME_EMAIL=you@your-domain.com \
//   CLOUDFLARE_API_TOKEN=*** \
//   pnpm --filter @tapflowio/relay exec vitest run src/__tests__/acmeStaging.integration.test.ts
//
// 토큰은 셸 env로만 — 코드/설정 파일/채팅에 넣지 말 것. DNS-01이라 도메인이 공개로 닿을 필요는 없고,
// 토큰이 해당 zone의 DNS Edit 권한만 있으면 된다. 챌린지 TXT는 발급 후 자동 정리된다.

const RUN = process.env.TAPFLOW_ACME_SMOKE === '1'
const domain = process.env.TAPFLOW_ACME_DOMAIN ?? ''
const token = process.env.CLOUDFLARE_API_TOKEN ?? ''
const email = process.env.ACME_EMAIL ?? ''

describe.skipIf(!RUN)('ACME STAGING issuance (integration)', () => {
  it('Cloudflare DNS-01로 실제 LE 스테이징 cert를 발급한다', async () => {
    expect(domain, 'set TAPFLOW_ACME_DOMAIN').toBeTruthy()
    expect(token, 'set CLOUDFLARE_API_TOKEN').toBeTruthy()

    const dns = new CloudflareDnsProvider({ token })
    const issuer = new AcmeClientIssuer({ email, staging: true })

    const issued = await issuer.issue({ domain, dns })

    expect(issued.cert).toContain('BEGIN CERTIFICATE')
    expect(issued.key).toContain('PRIVATE KEY')

    const x = new X509Certificate(issued.cert)
    // eslint-disable-next-line no-console
    console.log('\n  issuer  :', x.issuer.replace(/\n/g, ' '))
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
