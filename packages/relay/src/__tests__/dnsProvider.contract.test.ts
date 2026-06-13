import { describe, it, expect } from 'vitest'
import type { DnsProvider } from '../lib/cert/index.js'

// DNS-01 solver 계약 — fake로 TXT 설정/정리 라운드트립과 멱등성을 고정한다.

class FakeDnsProvider implements DnsProvider {
  readonly name = 'fake'
  private txt = new Map<string, Set<string>>()

  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    const key = `_acme-challenge.${fqdn}`
    if (!this.txt.has(key)) this.txt.set(key, new Set())
    this.txt.get(key)!.add(value)
  }

  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    this.txt.get(`_acme-challenge.${fqdn}`)?.delete(value)
  }

  records(fqdn: string): string[] {
    return [...(this.txt.get(`_acme-challenge.${fqdn}`) ?? [])]
  }
}

describe('DnsProvider 계약', () => {
  it('setTxtRecord → removeTxtRecord 라운드트립', async () => {
    const dns = new FakeDnsProvider()
    await dns.setTxtRecord('tap.example.com', 'token-1')
    expect(dns.records('tap.example.com')).toContain('token-1')
    await dns.removeTxtRecord('tap.example.com', 'token-1')
    expect(dns.records('tap.example.com')).not.toContain('token-1')
  })

  it('setTxtRecord는 멱등 — 같은 값 반복 설정해도 중복되지 않는다', async () => {
    const dns = new FakeDnsProvider()
    await dns.setTxtRecord('tap.example.com', 'token-1')
    await dns.setTxtRecord('tap.example.com', 'token-1')
    expect(dns.records('tap.example.com')).toEqual(['token-1'])
  })

  it('upsertAddressRecord는 선택 구현 — 미지원 공급자는 생략한다', () => {
    const dns: DnsProvider = new FakeDnsProvider()
    expect(dns.upsertAddressRecord).toBeUndefined()
  })
})
