import { describe, it, expect } from 'vitest'
import { promises as dnsp } from 'dns'
import { DesecDnsProvider } from '../lib/cert/DesecDnsProvider.js'

// deSEC 실계정 격리 진단: 우리 DesecDnsProvider가 (1) 실제 deSEC API에 TXT를 쓰고,
// (2) 공개 DNS에 전파되는지를 ACME 없이 빠르게 확인한다. 스테이징 hang의 원인이
// 우리 provider/전파인지 acme-client 검증인지 가른다.
//
// 실행:
//   export DESEC_TOKEN=...                       # 셸 env로만
//   TAPFLOW_DESEC_LIVE=1 TAPFLOW_ACME_DOMAIN=tapflow.dedyn.io \
//   pnpm --filter @tapflowio/relay exec vitest run src/__tests__/desecLive.integration.test.ts

const RUN = process.env.TAPFLOW_DESEC_LIVE === '1'
const domain = process.env.TAPFLOW_ACME_DOMAIN ?? ''
const token = process.env.DESEC_TOKEN ?? ''
const API = 'https://desec.io/api/v1'

async function getTxtViaApi(zone: string, sub: string): Promise<string[] | null> {
  const res = await fetch(`${API}/domains/${zone}/rrsets/${sub}/TXT/`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`deSEC GET failed: HTTP ${res.status}`)
  return ((await res.json()) as { records: string[] }).records
}

describe.skipIf(!RUN)('deSEC live write (integration)', () => {
  it('setTxtRecord가 deSEC API에 저장되고 공개 DNS에 전파된다', async () => {
    expect(domain, 'set TAPFLOW_ACME_DOMAIN').toBeTruthy()
    expect(token, 'set DESEC_TOKEN').toBeTruthy()

    const provider = new DesecDnsProvider({ token })
    const fqdn = `_acme-challenge.${domain}`
    const value = `tapflow-live-${Date.now()}`
    const quoted = `"${value}"`

    await provider.setTxtRecord(fqdn, value)
    try {
      // (1) deSEC API에 실제로 저장됐는지 — 우리 provider 동작 확정
      const stored = await getTxtViaApi(domain, '_acme-challenge')
      // eslint-disable-next-line no-console
      console.log('  deSEC API stored TXT:', stored)
      expect(stored, 'deSEC에 TXT가 저장되지 않음 → provider 버그').toContain(quoted)

      // (2) 공개 DNS 전파 — authoritative까지 보이는지 폴링(최대 ~60s)
      let found = false
      for (let i = 0; i < 20 && !found; i++) {
        try {
          const recs = await dnsp.resolveTxt(fqdn)
          const flat = recs.map((r) => r.join(''))
          // eslint-disable-next-line no-console
          console.log(`  [${i}] resolveTxt:`, flat)
          if (flat.includes(value)) found = true
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log(`  [${i}] resolveTxt:`, (e as NodeJS.ErrnoException).code ?? String(e))
        }
        if (!found) await new Promise((r) => setTimeout(r, 3000))
      }
      expect(found, 'TXT가 공개 DNS에 전파되지 않음(또는 OS 캐시)').toBe(true)
    } finally {
      await provider.removeTxtRecord(fqdn, value)
    }
  }, 90_000)
})
