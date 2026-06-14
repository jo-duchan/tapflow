import { describe, it, expect } from 'vitest'
import { VercelDnsProvider } from '../lib/cert/VercelDnsProvider.js'
import type { FetchLike } from '../lib/cert/CloudflareDnsProvider.js'

// Vercel DNS API(개별 레코드 + id, name=상대 subname, 값은 따옴표 없이)를 in-memory로 모사.
// 계약: setTxtRecord(domain)은 _acme-challenge.<domain> 에 TXT를 만든다.

interface Rec { id: string; zone: string; name: string; type: string; value: string }

function makeFakeVercel(domains: string[]) {
  const records: Rec[] = []
  let seq = 0
  let domainListCalls = 0
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  const fetchFn: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts.length === 2 && parts[1] === 'domains' && method === 'GET') {
      domainListCalls++
      return ok({ domains: domains.map((name) => ({ name })) })
    }
    if (parts.length === 4 && parts[1] === 'domains' && parts[3] === 'records') {
      const zone = parts[2]
      if (method === 'GET') return ok({ records: records.filter((r) => r.zone === zone) })
      if (method === 'POST') {
        const b = JSON.parse(init!.body!) as { type: string; name: string; value: string }
        const rec: Rec = { id: `rec_${seq++}`, zone, name: b.name, type: b.type, value: b.value }
        records.push(rec)
        return ok({ uid: rec.id })
      }
    }
    if (parts.length === 5 && parts[3] === 'records' && method === 'DELETE') {
      const id = parts[4]
      const i = records.findIndex((r) => r.id === id)
      if (i >= 0) records.splice(i, 1)
      return ok({})
    }
    return { ok: false, status: 400, json: async () => ({ error: { message: `unhandled ${method} ${url.pathname}` } }) }
  }

  return { fetchFn, records, domainListCalls: () => domainListCalls }
}

const TOKEN = 'vercel-test'

describe('VercelDnsProvider', () => {
  it('setTxtRecord(domain)은 _acme-challenge.<sub> TXT를 따옴표 없이 생성한다', async () => {
    const fake = makeFakeVercel(['example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    const txt = fake.records.filter((r) => r.type === 'TXT')
    expect(txt).toHaveLength(1)
    expect(txt[0]).toMatchObject({ zone: 'example.com', name: '_acme-challenge.tap', value: 'tok-1' })
  })

  it('setTxtRecord는 멱등 — 같은 값 반복 설정해도 한 개', async () => {
    const fake = makeFakeVercel(['example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    expect(fake.records.filter((r) => r.type === 'TXT')).toHaveLength(1)
  })

  it('removeTxtRecord는 매칭 레코드를 id로 삭제한다', async () => {
    const fake = makeFakeVercel(['example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    await dns.removeTxtRecord('tap.example.com', 'tok-1')
    expect(fake.records.filter((r) => r.type === 'TXT')).toHaveLength(0)
  })

  it('zone은 fqdn의 최장 suffix로 고르고 subname을 계산·캐시한다', async () => {
    const fake = makeFakeVercel(['example.com', 'sub.example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord('tap.sub.example.com', 'x')
    const txt = fake.records.find((r) => r.type === 'TXT')
    expect(txt).toMatchObject({ zone: 'sub.example.com', name: '_acme-challenge.tap' })
    await dns.setTxtRecord('tap.sub.example.com', 'y')
    expect(fake.domainListCalls()).toBe(1)
  })

  it('upsertAddressRecord는 apex(빈 name)에 A를 생성·교체한다', async () => {
    const fake = makeFakeVercel(['example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.upsertAddressRecord('example.com', '192.168.1.50')
    expect(fake.records.filter((r) => r.type === 'A')).toMatchObject([{ name: '', value: '192.168.1.50' }])
    await dns.upsertAddressRecord('example.com', '192.168.1.99')
    const a = fake.records.filter((r) => r.type === 'A')
    expect(a).toHaveLength(1)
    expect(a[0].value).toBe('192.168.1.99')
  })

  it('IPv6는 AAAA로 매핑', async () => {
    const fake = makeFakeVercel(['example.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.upsertAddressRecord('tap.example.com', 'fe80::1')
    expect(fake.records.filter((r) => r.type === 'AAAA')).toHaveLength(1)
  })

  it('API 오류(non-ok)면 throw', async () => {
    const failFetch: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Forbidden' } }) })
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: failFetch })
    await expect(dns.setTxtRecord('tap.example.com', 'x')).rejects.toThrow(/Vercel|Forbidden|403/i)
  })

  it('zone을 못 찾으면 throw', async () => {
    const fake = makeFakeVercel(['other.com'])
    const dns = new VercelDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await expect(dns.setTxtRecord('tap.example.com', 'x')).rejects.toThrow(/vercel|domain|zone/i)
  })

  it('토큰이 없으면 생성 시 throw', () => {
    expect(() => new VercelDnsProvider({ token: '' })).toThrow(/token/i)
  })
})
