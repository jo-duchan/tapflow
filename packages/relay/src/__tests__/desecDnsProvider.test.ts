import { describe, it, expect } from 'vitest'
import { DesecDnsProvider } from '../lib/cert/DesecDnsProvider.js'
import type { FetchLike } from '../lib/cert/CloudflareDnsProvider.js'

// deSEC RRset API(subname+type 묶음, TXT는 따옴표, apex=@)를 in-memory로 모사.
// 계약: setTxtRecord(domain)은 _acme-challenge.<domain> 에 TXT를 만든다(CloudflareDnsProvider와 동일).

function makeFakeDesec(domains: string[]) {
  const rrsets = new Map<string, { subname: string; type: string; records: string[] }>()
  const key = (zone: string, sub: string, type: string) => `${zone}|${sub || '@'}|${type}`
  let listCalls = 0

  const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body })

  const fetchFn: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl)
    const method = (init?.method ?? 'GET').toUpperCase()
    const parts = url.pathname.split('/').filter(Boolean)
    const after = parts.slice(parts.indexOf('domains') + 1)

    if (after.length === 0 && method === 'GET') {
      listCalls++
      return ok(domains.map((name) => ({ name })))
    }
    const zone = after[0]
    if (after.length === 2 && after[1] === 'rrsets' && method === 'POST') {
      const b = JSON.parse(init!.body!) as { subname: string; type: string; records: string[] }
      rrsets.set(key(zone, b.subname, b.type), { subname: b.subname, type: b.type, records: b.records })
      return ok({ ...b }, 201)
    }
    if (after.length === 4 && after[1] === 'rrsets') {
      const urlSub = after[2]
      const type = after[3]
      const sub = urlSub === '@' ? '' : urlSub
      const k = key(zone, sub, type)
      if (method === 'GET') {
        const r = rrsets.get(k)
        return r ? ok(r) : { ok: false, status: 404, json: async () => ({ detail: 'Not found.' }) }
      }
      if (method === 'PUT') {
        const b = JSON.parse(init!.body!) as { subname: string; type: string; records: string[] }
        rrsets.set(k, { subname: b.subname, type: b.type, records: b.records })
        return ok({ ...b })
      }
      if (method === 'DELETE') {
        rrsets.delete(k)
        return { ok: true, status: 204, json: async () => { throw new Error('204 no body') } }
      }
    }
    return { ok: false, status: 400, json: async () => ({ detail: `unhandled ${method} ${url.pathname}` }) }
  }

  return { fetchFn, rrsets, key, listCalls: () => listCalls }
}

const TOKEN = 'desec-test'
const Z = 'myteam.dedyn.io'

describe('DesecDnsProvider', () => {
  it('setTxtRecord(domain)은 _acme-challenge.<domain> TXT를 따옴표로 감싸 생성한다', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord(Z, 'chal-1')
    const r = fake.rrsets.get(fake.key(Z, '_acme-challenge', 'TXT'))
    expect(r).toBeDefined()
    expect(r!.records).toEqual(['"chal-1"'])
  })

  it('setTxtRecord는 멱등 — 같은 값 반복 설정해도 한 개', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord(Z, 'chal-1')
    await dns.setTxtRecord(Z, 'chal-1')
    expect(fake.rrsets.get(fake.key(Z, '_acme-challenge', 'TXT'))!.records).toEqual(['"chal-1"'])
  })

  it('setTxtRecord는 다른 값이면 RRset에 합집합으로 추가', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord(Z, 'a')
    await dns.setTxtRecord(Z, 'b')
    expect(fake.rrsets.get(fake.key(Z, '_acme-challenge', 'TXT'))!.records).toEqual(['"a"', '"b"'])
  })

  it('removeTxtRecord는 값을 빼고, 비면 RRset을 삭제한다', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord(Z, 'chal-1')
    await dns.removeTxtRecord(Z, 'chal-1')
    expect(fake.rrsets.get(fake.key(Z, '_acme-challenge', 'TXT'))).toBeUndefined()
  })

  it('서브도메인은 zone을 최장 suffix로 고르고 subname을 _acme-challenge.<prefix>로 계산', async () => {
    const fake = makeFakeDesec(['example.com', 'sub.example.com'])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.setTxtRecord('tap.sub.example.com', 'x')
    const r = fake.rrsets.get(fake.key('sub.example.com', '_acme-challenge.tap', 'TXT'))
    expect(r).toBeDefined()
    expect(r!.records).toEqual(['"x"'])
    await dns.setTxtRecord('tap.sub.example.com', 'y')
    expect(fake.listCalls()).toBe(1) // zone 디스커버리 캐시
  })

  it('upsertAddressRecord는 apex(@)에 A를 생성·갱신한다', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.upsertAddressRecord(Z, '192.168.1.50')
    expect(fake.rrsets.get(fake.key(Z, '', 'A'))!.records).toEqual(['192.168.1.50'])
    await dns.upsertAddressRecord(Z, '192.168.1.99')
    expect(fake.rrsets.get(fake.key(Z, '', 'A'))!.records).toEqual(['192.168.1.99'])
  })

  it('IPv6는 AAAA로 매핑', async () => {
    const fake = makeFakeDesec([Z])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await dns.upsertAddressRecord(Z, 'fe80::1')
    expect(fake.rrsets.get(fake.key(Z, '', 'AAAA'))).toBeDefined()
  })

  it('zone을 못 찾으면 throw', async () => {
    const fake = makeFakeDesec(['other.com'])
    const dns = new DesecDnsProvider({ token: TOKEN, fetchFn: fake.fetchFn })
    await expect(dns.setTxtRecord('myteam.dedyn.io', 'x')).rejects.toThrow(/desec|domain|zone/i)
  })

  it('토큰이 없으면 생성 시 throw', () => {
    expect(() => new DesecDnsProvider({ token: '' })).toThrow(/token/i)
  })
})
