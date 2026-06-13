import { describe, it, expect } from 'vitest'
import { AcmeCertProvider, InMemoryCertStore, type AcmeIssuer, type IssuedCert } from '../lib/cert/AcmeCertProvider.js'
import type { DnsProvider } from '../lib/cert/index.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_000_000_000_000

class RecordingDns implements DnsProvider {
  readonly name = 'recording'
  txtSet: [string, string][] = []
  txtRemoved: [string, string][] = []
  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    this.txtSet.push([fqdn, value])
  }
  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    this.txtRemoved.push([fqdn, value])
  }
}

class FakeIssuer implements AcmeIssuer {
  issues = 0
  constructor(
    private readonly nowFn: () => number,
    private readonly validForDays = 90,
  ) {}
  async issue({ domain, dns }: { domain: string; dns: DnsProvider }): Promise<IssuedCert> {
    this.issues++
    // DNS-01 solver가 실제로 호출되는지 증명하기 위해 챌린지 set/remove를 수행
    await dns.setTxtRecord(domain, `chal-${this.issues}`)
    await dns.removeTxtRecord(domain, `chal-${this.issues}`)
    return { cert: `CERT-${this.issues}`, key: `KEY-${this.issues}`, expiresAt: new Date(this.nowFn() + this.validForDays * DAY) }
  }
}

describe('AcmeCertProvider', () => {
  it('ensureCert는 발급해 cert/key/만료를 채워 반환한다', async () => {
    const now = () => T0
    const issuer = new FakeIssuer(now)
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, now })
    const m = await p.ensureCert()
    expect(m).toMatchObject({ cert: 'CERT-1', key: 'KEY-1' })
    expect(issuer.issues).toBe(1)
  })

  it('발급은 주입된 DnsProvider로 DNS-01 챌린지를 set/remove 한다', async () => {
    const now = () => T0
    const dns = new RecordingDns()
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns, issuer: new FakeIssuer(now), now })
    await p.ensureCert()
    expect(dns.txtSet).toEqual([['tap.example.com', 'chal-1']])
    expect(dns.txtRemoved).toEqual([['tap.example.com', 'chal-1']])
  })

  it('ensureCert는 멱등 — 유효한 cert가 있으면 재발급하지 않는다', async () => {
    const now = () => T0
    const issuer = new FakeIssuer(now)
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, now })
    await p.ensureCert()
    await p.ensureCert()
    expect(issuer.issues).toBe(1)
  })

  it('ensureCert는 저장된 cert가 만료됐으면 재발급한다', async () => {
    const state = { t: T0 }
    const now = () => state.t
    const issuer = new FakeIssuer(now, 90)
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, now })
    await p.ensureCert()
    state.t += 100 * DAY
    await p.ensureCert()
    expect(issuer.issues).toBe(2)
  })

  it('renewIfNeeded는 유효기간이 충분하면 null', async () => {
    const now = () => T0
    const issuer = new FakeIssuer(now, 90)
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, now })
    await p.ensureCert()
    expect(await p.renewIfNeeded()).toBeNull()
    expect(issuer.issues).toBe(1)
  })

  it('renewIfNeeded는 만료 임박(<30일)에 재발급한다', async () => {
    const state = { t: T0 }
    const now = () => state.t
    const issuer = new FakeIssuer(now, 90)
    const p = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, now })
    await p.ensureCert()
    state.t += 65 * DAY // 잔여 25일 < 30
    const renewed = await p.renewIfNeeded()
    expect(renewed).not.toBeNull()
    expect(issuer.issues).toBe(2)
  })

  it('공유 CertStore로 저장된 자료를 재발급 없이 로드한다', async () => {
    const now = () => T0
    const store = new InMemoryCertStore()
    const issuer = new FakeIssuer(now)
    const p1 = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, store, now })
    await p1.ensureCert()
    const p2 = new AcmeCertProvider({ domain: 'tap.example.com', dns: new RecordingDns(), issuer, store, now })
    const m = await p2.ensureCert()
    expect(m.cert).toBe('CERT-1')
    expect(issuer.issues).toBe(1)
  })
})
