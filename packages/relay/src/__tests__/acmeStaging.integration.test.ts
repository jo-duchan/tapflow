import { describe, it, expect } from 'vitest'
import { X509Certificate } from 'crypto'
import { AcmeClientIssuer } from '../lib/cert/AcmeClientIssuer.js'
import { CloudflareDnsProvider } from '../lib/cert/CloudflareDnsProvider.js'
import { VercelDnsProvider } from '../lib/cert/VercelDnsProvider.js'
import type { DnsProvider } from '../lib/cert/DnsProvider.js'
import { parseCertNotAfter } from '../lib/cert/parseCert.js'

// 실제 Let's Encrypt STAGING 발급 통합 테스트. 비밀과 네트워크가 필요하므로 기본 OFF.
// DNS provider는 env로 선택: TAPFLOW_VERCEL_TOKEN 있으면 Vercel, 없으면 TAPFLOW_CLOUDFLARE_TOKEN으로 Cloudflare.
//
// 실행:
//   export TAPFLOW_VERCEL_TOKEN=...           # 또는 TAPFLOW_CLOUDFLARE_TOKEN. 셸 env로만(채팅/명령줄 인라인 금지)
//   # (Vercel 팀 도메인이면) export TAPFLOW_VERCEL_TEAM_ID=team_xxx
//   TAPFLOW_ACME_SMOKE=1 TAPFLOW_ACME_DOMAIN=tap.your-domain.com \
//     pnpm --filter @tapflowio/relay exec vitest run src/__tests__/acmeStaging.integration.test.ts
//
// DNS-01이라 도메인이 공개로 닿을 필요 없음. 챌린지 TXT는 발급 후 자동 정리된다.

const RUN = process.env.TAPFLOW_ACME_SMOKE === '1'
const domain = process.env.TAPFLOW_ACME_DOMAIN ?? ''
const email = process.env.TAPFLOW_ACME_EMAIL ?? ''
const cloudflareToken = process.env.TAPFLOW_CLOUDFLARE_TOKEN ?? ''
const vercelToken = process.env.TAPFLOW_VERCEL_TOKEN ?? ''

describe.skipIf(!RUN)('ACME STAGING issuance (integration)', () => {
  it('DNS-01로 실제 LE 스테이징 cert를 발급한다 (Vercel / Cloudflare)', async () => {
    expect(domain, 'set TAPFLOW_ACME_DOMAIN').toBeTruthy()
    expect(cloudflareToken || vercelToken, 'set TAPFLOW_VERCEL_TOKEN or TAPFLOW_CLOUDFLARE_TOKEN').toBeTruthy()

    const dns: DnsProvider = vercelToken
      ? new VercelDnsProvider({ token: vercelToken, teamId: process.env.TAPFLOW_VERCEL_TEAM_ID || undefined })
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
  }, 300_000)
})
