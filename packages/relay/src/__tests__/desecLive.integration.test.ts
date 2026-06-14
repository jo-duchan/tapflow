import { describe, it, expect } from 'vitest'
import { promises as dnsp } from 'dns'
import { DesecDnsProvider } from '../lib/cert/DesecDnsProvider.js'

// deSEC 실계정 격리 진단: 우리 DesecDnsProvider가 _acme-challenge.<domain> TXT를 실제로 만들고
// 공개 DNS에 전파되는지를 ACME 없이 빠르게 확인한다.
//
// 실행:
//   export DESEC_TOKEN=...                       # 셸 env로만
//   TAPFLOW_DESEC_LIVE=1 TAPFLOW_ACME_DOMAIN=relay.tapflow.dedyn.io \
//   pnpm --filter @tapflowio/relay exec vitest run src/__tests__/desecLive.integration.test.ts

const RUN = process.env.TAPFLOW_DESEC_LIVE === '1'
const domain = process.env.TAPFLOW_ACME_DOMAIN ?? ''
const token = process.env.DESEC_TOKEN ?? ''

describe.skipIf(!RUN)('deSEC live write (integration)', () => {
  it('setTxtRecord(domain)이 _acme-challenge.<domain>으로 공개 DNS에 전파된다', async () => {
    expect(domain, 'set TAPFLOW_ACME_DOMAIN').toBeTruthy()
    expect(token, 'set DESEC_TOKEN').toBeTruthy()

    const provider = new DesecDnsProvider({ token })
    const fqdn = `_acme-challenge.${domain}`
    const value = `tapflow-live-${Date.now()}`

    await provider.setTxtRecord(domain, value)
    try {
      let found = false
      for (let i = 0; i < 20 && !found; i++) {
        try {
          const recs = await dnsp.resolveTxt(fqdn)
          const flat = recs.map((r) => r.join(''))
          // eslint-disable-next-line no-console
          console.log(`  [${i}] resolveTxt ${fqdn}:`, flat)
          if (flat.includes(value)) found = true
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log(`  [${i}] resolveTxt:`, (e as NodeJS.ErrnoException).code ?? String(e))
        }
        if (!found) await new Promise((r) => setTimeout(r, 3000))
      }
      expect(found, `${fqdn} 가 공개 DNS에 전파되지 않음`).toBe(true)
    } finally {
      await provider.removeTxtRecord(domain, value)
    }
  }, 90_000)
})
