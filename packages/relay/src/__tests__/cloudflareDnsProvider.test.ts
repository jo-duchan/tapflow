import { describe, it, expect } from 'vitest'
import { CloudflareDnsProvider, type FetchLike } from '../lib/cert/CloudflareDnsProvider.js'

// Cloudflare API를 in-memory로 모사하는 fake. zone 디스커버리/레코드 CRUD를 흉내낸다.

interface CfRecord {
  id: string
  type: string
  name: string
  content: string
}

function makeFakeCloudflare(zoneNames: string[]) {
  const zones = zoneNames.map((name, i) => ({ id: `zone-${i}`, name }))
  const records = new Map<string, CfRecord[]>()
  for (const z of zones) records.set(z.id, [])
  let seq = 0
  let zoneListCalls = 0

  const ok = (result: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, errors: [], result }),
  })

  const fetchFn: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean)
    const after = parts.slice(parts.indexOf('zones') + 1)

    if (after.length === 0 && method === 'GET') {
      zoneListCalls++
      const nameFilter = url.searchParams.get('name')
      return ok(nameFilter ? zones.filter((z) => z.name === nameFilter) : zones)
    }

    const zoneId = after[0]
    if (after[1] === 'dns_records') {
      const list = records.get(zoneId) ?? []
      const recId = after[2]
      if (method === 'GET') {
        const type = url.searchParams.get('type')
        const name = url.searchParams.get('name')
        return ok(list.filter((r) => (!type || r.type === type) && (!name || r.name === name)))
      }
      if (method === 'POST') {
        const body = JSON.parse(init!.body!) as { type: string; name: string; content: string }
        const rec = { id: `rec-${seq++}`, ...body }
        list.push(rec)
        return ok(rec)
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = JSON.parse(init!.body!) as Partial<CfRecord>
        const rec = list.find((r) => r.id === recId)!
        Object.assign(rec, body)
        return ok(rec)
      }
      if (method === 'DELETE') {
        const idx = list.findIndex((r) => r.id === recId)
        if (idx >= 0) list.splice(idx, 1)
        return ok({ id: recId })
      }
    }

    return { ok: false, status: 400, json: async () => ({ success: false, errors: [{ code: 0, message: `unhandled ${method} ${url.pathname}` }], result: null }) }
  }

  return { fetchFn, records, zoneListCalls: () => zoneListCalls }
}

const TOKEN = 'cf-test-token'

describe('CloudflareDnsProvider', () => {
  it('setTxtRecord는 _acme-challenge TXT를 생성한다', async () => {
    const cf = makeFakeCloudflare(['example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    const recs = cf.records.get('zone-0')!
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ type: 'TXT', name: '_acme-challenge.tap.example.com', content: 'tok-1' })
  })

  it('setTxtRecord는 멱등 — 동일 name+content면 중복 생성하지 않는다', async () => {
    const cf = makeFakeCloudflare(['example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    expect(cf.records.get('zone-0')).toHaveLength(1)
  })

  it('removeTxtRecord는 매칭 레코드를 삭제한다', async () => {
    const cf = makeFakeCloudflare(['example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok-1')
    await dns.removeTxtRecord('tap.example.com', 'tok-1')
    expect(cf.records.get('zone-0')).toHaveLength(0)
  })

  it('zone은 fqdn의 최장 suffix로 고르고 디스커버리를 캐시한다', async () => {
    const cf = makeFakeCloudflare(['example.com', 'sub.example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.setTxtRecord('tap.sub.example.com', 'tok-1')
    await dns.setTxtRecord('tap.sub.example.com', 'tok-2')
    expect(cf.records.get('zone-1')).toHaveLength(2)
    expect(cf.records.get('zone-0')).toHaveLength(0)
    expect(cf.zoneListCalls()).toBe(1)
  })

  it('upsertAddressRecord는 없으면 A 생성, 있으면 갱신한다', async () => {
    const cf = makeFakeCloudflare(['example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.upsertAddressRecord('tap.example.com', '192.168.1.50')
    expect(cf.records.get('zone-0')!.filter((r) => r.type === 'A')).toMatchObject([{ content: '192.168.1.50' }])
    await dns.upsertAddressRecord('tap.example.com', '192.168.1.99')
    const a = cf.records.get('zone-0')!.filter((r) => r.type === 'A')
    expect(a).toHaveLength(1)
    expect(a[0].content).toBe('192.168.1.99')
  })

  it('IPv6는 AAAA로 매핑한다', async () => {
    const cf = makeFakeCloudflare(['example.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await dns.upsertAddressRecord('tap.example.com', 'fe80::1')
    expect(cf.records.get('zone-0')!.filter((r) => r.type === 'AAAA')).toHaveLength(1)
  })

  it('API가 success:false면 에러를 던진다', async () => {
    const failFetch: FetchLike = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ code: 1003, message: 'Invalid API token' }], result: null }),
    })
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: failFetch })
    await expect(dns.setTxtRecord('tap.example.com', 'x')).rejects.toThrow(/Invalid API token/)
  })

  it('zone을 못 찾으면 에러를 던진다', async () => {
    const cf = makeFakeCloudflare(['other.com'])
    const dns = new CloudflareDnsProvider({ token: TOKEN, fetchFn: cf.fetchFn })
    await expect(dns.setTxtRecord('tap.example.com', 'x')).rejects.toThrow(/zone/i)
  })

  it('토큰이 없으면 생성 시 에러', () => {
    expect(() => new CloudflareDnsProvider({ token: '', fetchFn: makeFakeCloudflare([]).fetchFn })).toThrow(/token/i)
  })
})
