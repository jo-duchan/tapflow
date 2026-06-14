import type { DnsProvider } from './DnsProvider.js'

// Cloudflare DNS-01 solver (issue #232). 사용자 자기 Cloudflare 계정 토큰으로 동작한다(BYO).
// 토큰은 config가 아니라 env(CLOUDFLARE_API_TOKEN)에서 읽는다 — cloudflareDnsFromEnv 참고.

const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4'
const TTL_SECONDS = 60

/** 의존성 주입용 최소 fetch 계약 — global fetch 타입에 묶이지 않게 자체 정의. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

// DNS 공급자 API 호출이 무한 대기하지 않도록 하는 요청 타임아웃.
export const DNS_API_TIMEOUT_MS = 30_000

export interface CloudflareDnsProviderOptions {
  token: string
  /** 명시하면 zone 디스커버리를 생략하고 이 이름의 zone만 쓴다. */
  zoneName?: string
  /** 테스트 주입용. 기본은 global fetch. */
  fetchFn?: FetchLike
  /** 기본 https://api.cloudflare.com/client/v4 */
  apiBase?: string
}

interface CfResponse<T> {
  success: boolean
  errors: { code: number; message: string }[]
  result: T
}

interface CfZone {
  id: string
  name: string
}

interface CfRecord {
  id: string
  type: string
  name: string
  content: string
}

export class CloudflareDnsProvider implements DnsProvider {
  readonly name = 'cloudflare'
  private readonly token: string
  private readonly fetchFn: FetchLike
  private readonly apiBase: string
  private readonly fixedZoneName?: string
  private readonly zoneIdCache = new Map<string, string>()

  constructor(opts: CloudflareDnsProviderOptions) {
    if (!opts.token) throw new Error('Cloudflare API token is required (set CLOUDFLARE_API_TOKEN)')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
    this.fixedZoneName = opts.zoneName
  }

  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const name = `_acme-challenge.${fqdn}`
    const existing = await this.findRecords(zoneId, 'TXT', name)
    if (existing.some((r) => r.content === value)) return
    await this.request(`/zones/${zoneId}/dns_records`, 'POST', { type: 'TXT', name, content: value, ttl: TTL_SECONDS })
  }

  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const name = `_acme-challenge.${fqdn}`
    const matches = (await this.findRecords(zoneId, 'TXT', name)).filter((r) => r.content === value)
    for (const r of matches) {
      await this.request(`/zones/${zoneId}/dns_records/${r.id}`, 'DELETE')
    }
  }

  async upsertAddressRecord(fqdn: string, ip: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const type = ip.includes(':') ? 'AAAA' : 'A'
    const existing = await this.findRecords(zoneId, type, fqdn)
    const payload = { type, name: fqdn, content: ip, ttl: TTL_SECONDS }
    if (existing.length > 0) {
      await this.request(`/zones/${zoneId}/dns_records/${existing[0].id}`, 'PATCH', payload)
    } else {
      await this.request(`/zones/${zoneId}/dns_records`, 'POST', payload)
    }
  }

  private async zoneIdFor(fqdn: string): Promise<string> {
    const cacheKey = this.fixedZoneName ?? fqdn
    const cached = this.zoneIdCache.get(cacheKey)
    if (cached) return cached

    const zones = await this.request<CfZone[]>('/zones', 'GET')
    const candidates = this.fixedZoneName
      ? zones.filter((z) => z.name === this.fixedZoneName)
      : zones.filter((z) => fqdn === z.name || fqdn.endsWith(`.${z.name}`))
    // 가장 구체적인(최장 suffix) zone 우선
    candidates.sort((a, b) => b.name.length - a.name.length)
    const zone = candidates[0]
    if (!zone) throw new Error(`No Cloudflare zone found for ${fqdn}`)
    this.zoneIdCache.set(cacheKey, zone.id)
    return zone.id
  }

  private async findRecords(zoneId: string, type: string, name: string): Promise<CfRecord[]> {
    const qs = new URLSearchParams({ type, name }).toString()
    return this.request<CfRecord[]>(`/zones/${zoneId}/dns_records?${qs}`, 'GET')
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(DNS_API_TIMEOUT_MS),
    })
    const data = (await res.json()) as CfResponse<T>
    if (!res.ok || !data.success) {
      const msg = data.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
      throw new Error(`Cloudflare API error: ${msg}`)
    }
    return data.result
  }
}

/** env(CLOUDFLARE_API_TOKEN)에서 토큰을 읽어 provider를 만든다. 토큰 미설정 시 throw. */
export function cloudflareDnsFromEnv(zoneName?: string): CloudflareDnsProvider {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set')
  return new CloudflareDnsProvider({ token, zoneName })
}
