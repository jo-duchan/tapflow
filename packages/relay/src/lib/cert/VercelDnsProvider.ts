import type { DnsProvider } from './DnsProvider.js'
import type { FetchLike } from './CloudflareDnsProvider.js'

// Vercel DNS-01 solver (issue #232). 사용자 자기 Vercel 계정 토큰으로 동작한다(BYO).
// 토큰은 config가 아니라 env(VERCEL_TOKEN)에서 읽는다(vercelDnsFromEnv).
// Vercel은 개별 레코드(id 보유) 모델: name은 도메인 기준 상대 subname(루트는 ''), TXT 값은 따옴표 없이.

const DEFAULT_API_BASE = 'https://api.vercel.com'
const TTL_SECONDS = 60

export interface VercelDnsProviderOptions {
  token: string
  /** 명시하면 도메인 디스커버리(GET /v5/domains)를 생략. */
  zoneName?: string
  /** 팀 계정이면 teamId. */
  teamId?: string
  /** 테스트 주입용. 기본 global fetch. */
  fetchFn?: FetchLike
  /** 기본 https://api.vercel.com */
  apiBase?: string
}

interface VercelRecord {
  id: string
  name: string
  type: string
  value: string
}

export class VercelDnsProvider implements DnsProvider {
  readonly name = 'vercel'
  private readonly token: string
  private readonly fetchFn: FetchLike
  private readonly apiBase: string
  private readonly fixedZoneName?: string
  private readonly teamId?: string
  private readonly zoneCache = new Map<string, string>()

  constructor(opts: VercelDnsProviderOptions) {
    if (!opts.token) throw new Error('Vercel API token is required (set VERCEL_TOKEN)')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
    this.fixedZoneName = opts.zoneName
    this.teamId = opts.teamId
  }

  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    const recordName = `_acme-challenge.${fqdn}`
    const zone = await this.zoneFor(recordName)
    const subname = this.subnameOf(recordName, zone)
    const existing = await this.findRecords(zone, 'TXT', subname)
    if (existing.some((r) => r.value === value || r.value === `"${value}"`)) return
    await this.createRecord(zone, { type: 'TXT', name: subname, value, ttl: TTL_SECONDS })
  }

  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    const recordName = `_acme-challenge.${fqdn}`
    const zone = await this.zoneFor(recordName)
    const subname = this.subnameOf(recordName, zone)
    const matches = (await this.findRecords(zone, 'TXT', subname)).filter(
      (r) => r.value === value || r.value === `"${value}"`,
    )
    for (const r of matches) await this.deleteRecord(zone, r.id)
  }

  async upsertAddressRecord(fqdn: string, ip: string): Promise<void> {
    const zone = await this.zoneFor(fqdn)
    const subname = this.subnameOf(fqdn, zone)
    const type = ip.includes(':') ? 'AAAA' : 'A'
    // Vercel엔 레코드 PATCH가 번거로우니 기존 동type 레코드 삭제 후 재생성(upsert).
    for (const r of await this.findRecords(zone, type, subname)) await this.deleteRecord(zone, r.id)
    await this.createRecord(zone, { type, name: subname, value: ip, ttl: TTL_SECONDS })
  }

  // --- internals ---

  private subnameOf(fqdn: string, zone: string): string {
    if (fqdn === zone) return ''
    if (fqdn.endsWith(`.${zone}`)) return fqdn.slice(0, -(zone.length + 1))
    throw new Error(`${fqdn} is not under Vercel zone ${zone}`)
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams(params)
    if (this.teamId) q.set('teamId', this.teamId)
    const qs = q.toString()
    return `${this.apiBase}${path}${qs ? `?${qs}` : ''}`
  }

  private async zoneFor(fqdn: string): Promise<string> {
    if (this.fixedZoneName) return this.fixedZoneName
    const cached = this.zoneCache.get(fqdn)
    if (cached) return cached
    const body = await this.request<{ domains: { name: string }[] }>(this.url('/v5/domains', { limit: '100' }), 'GET')
    const names = body.domains.map((d) => d.name)
    const zone = names.filter((n) => fqdn === n || fqdn.endsWith(`.${n}`)).sort((a, b) => b.length - a.length)[0]
    if (!zone) throw new Error(`No Vercel domain found for ${fqdn}`)
    this.zoneCache.set(fqdn, zone)
    return zone
  }

  private async findRecords(zone: string, type: string, subname: string): Promise<VercelRecord[]> {
    const fullName = subname === '' ? zone : `${subname}.${zone}`
    const body = await this.request<{ records?: VercelRecord[] }>(
      this.url(`/v5/domains/${zone}/records`, { limit: '100' }),
      'GET',
    )
    return (body.records ?? []).filter((r) => r.type === type && (r.name === subname || r.name === fullName))
  }

  private async createRecord(zone: string, record: { type: string; name: string; value: string; ttl: number }): Promise<void> {
    await this.request(this.url(`/v2/domains/${zone}/records`), 'POST', record)
  }

  private async deleteRecord(zone: string, recordId: string): Promise<void> {
    await this.request(this.url(`/v2/domains/${zone}/records/${recordId}`), 'DELETE')
  }

  private async request<T>(url: string, method: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`
      throw new Error(`Vercel API error: ${msg}`)
    }
    return data as T
  }
}

/** env(VERCEL_TOKEN)에서 토큰을 읽어 provider를 만든다. 미설정 시 throw. (팀이면 VERCEL_TEAM_ID) */
export function vercelDnsFromEnv(zoneName?: string): VercelDnsProvider {
  const token = process.env.VERCEL_TOKEN
  if (!token) throw new Error('VERCEL_TOKEN is not set')
  return new VercelDnsProvider({ token, zoneName, teamId: process.env.VERCEL_TEAM_ID || undefined })
}
