import type { DnsProvider } from './DnsProvider.js'
import { DNS_API_TIMEOUT_MS, type FetchLike } from './CloudflareDnsProvider.js'

// deSEC(무료 비영리 DNS) DNS-01 solver (issue #232). 도메인 없는 유저도 무료 dedyn.io 서브도메인으로 자동 발급.
// 토큰은 config가 아니라 env(DESEC_TOKEN)에서 읽는다(desecDnsFromEnv).
// deSEC는 RRset(subname+type → records[]) 모델: TXT는 따옴표로 감싸고, apex subname은 URL에서 '@'.

const DEFAULT_API_BASE = 'https://desec.io/api/v1'
// deSEC 최소 TTL은 도메인 설정값(기본 3600). 3600은 항상 [min, 86400] 범위 안.
const TTL_SECONDS = 3600

export interface DesecDnsProviderOptions {
  token: string
  /** 명시하면 도메인 디스커버리(GET /domains/)를 생략. */
  zoneName?: string
  /** 테스트 주입용. 기본 global fetch. */
  fetchFn?: FetchLike
  /** 기본 https://desec.io/api/v1 */
  apiBase?: string
}

interface DesecRrset {
  subname: string
  type: string
  records: string[]
}

export class DesecDnsProvider implements DnsProvider {
  readonly name = 'desec'
  private readonly token: string
  private readonly fetchFn: FetchLike
  private readonly apiBase: string
  private readonly fixedZoneName?: string
  private readonly zoneCache = new Map<string, string>()

  constructor(opts: DesecDnsProviderOptions) {
    if (!opts.token) throw new Error('deSEC API token is required (set DESEC_TOKEN)')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
    this.fixedZoneName = opts.zoneName
  }

  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    // 계약: 챌린지 레코드는 _acme-challenge.<fqdn> (CloudflareDnsProvider와 동일).
    const recordName = `_acme-challenge.${fqdn}`
    const zone = await this.zoneFor(recordName)
    const subname = this.subnameOf(recordName, zone)
    const quoted = `"${value}"`
    const existing = await this.getRrset(zone, subname, 'TXT')
    if (existing?.records.includes(quoted)) return
    const records = existing ? [...existing.records, quoted] : [quoted]
    if (existing) await this.putRrset(zone, subname, 'TXT', records)
    else await this.createRrset(zone, subname, 'TXT', records)
  }

  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    const recordName = `_acme-challenge.${fqdn}`
    const zone = await this.zoneFor(recordName)
    const subname = this.subnameOf(recordName, zone)
    const quoted = `"${value}"`
    const existing = await this.getRrset(zone, subname, 'TXT')
    if (!existing) return
    const remaining = existing.records.filter((r) => r !== quoted)
    if (remaining.length === 0) await this.deleteRrset(zone, subname, 'TXT')
    else await this.putRrset(zone, subname, 'TXT', remaining)
  }

  async upsertAddressRecord(fqdn: string, ip: string): Promise<void> {
    const zone = await this.zoneFor(fqdn)
    const subname = this.subnameOf(fqdn, zone)
    const type = ip.includes(':') ? 'AAAA' : 'A'
    const existing = await this.getRrset(zone, subname, type)
    if (existing) await this.putRrset(zone, subname, type, [ip])
    else await this.createRrset(zone, subname, type, [ip])
  }

  // --- internals ---

  private subUrl(subname: string): string {
    return subname === '' ? '@' : subname
  }

  private subnameOf(fqdn: string, zone: string): string {
    if (fqdn === zone) return ''
    if (fqdn.endsWith(`.${zone}`)) return fqdn.slice(0, -(zone.length + 1))
    throw new Error(`${fqdn} is not under deSEC zone ${zone}`)
  }

  private async zoneFor(fqdn: string): Promise<string> {
    if (this.fixedZoneName) return this.fixedZoneName
    const cached = this.zoneCache.get(fqdn)
    if (cached) return cached
    const { status, body } = await this.api('/domains/', 'GET')
    if (status !== 200) throw new Error(`deSEC API error listing domains: HTTP ${status}`)
    const names = (body as { name: string }[]).map((d) => d.name)
    const zone = names.filter((n) => fqdn === n || fqdn.endsWith(`.${n}`)).sort((a, b) => b.length - a.length)[0]
    if (!zone) throw new Error(`No deSEC domain found for ${fqdn}`)
    this.zoneCache.set(fqdn, zone)
    return zone
  }

  private async getRrset(zone: string, subname: string, type: string): Promise<DesecRrset | null> {
    const { status, body } = await this.api(`/domains/${zone}/rrsets/${this.subUrl(subname)}/${type}/`, 'GET')
    if (status === 404) return null
    if (status !== 200) throw new Error(`deSEC API error (GET rrset): HTTP ${status}`)
    return body as DesecRrset
  }

  private async createRrset(zone: string, subname: string, type: string, records: string[]): Promise<void> {
    const { status, body } = await this.api(`/domains/${zone}/rrsets/`, 'POST', { subname, type, ttl: TTL_SECONDS, records })
    this.assertOk(status, body, [200, 201])
  }

  private async putRrset(zone: string, subname: string, type: string, records: string[]): Promise<void> {
    const { status, body } = await this.api(`/domains/${zone}/rrsets/${this.subUrl(subname)}/${type}/`, 'PUT', { subname, type, ttl: TTL_SECONDS, records })
    this.assertOk(status, body, [200])
  }

  private async deleteRrset(zone: string, subname: string, type: string): Promise<void> {
    const { status, body } = await this.api(`/domains/${zone}/rrsets/${this.subUrl(subname)}/${type}/`, 'DELETE')
    this.assertOk(status, body, [200, 204])
  }

  private assertOk(status: number, body: unknown, allow: number[]): void {
    if (!allow.includes(status)) {
      const msg = body && typeof body === 'object' ? JSON.stringify(body) : `HTTP ${status}`
      throw new Error(`deSEC API error: ${msg}`)
    }
  }

  private async api(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Token ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(DNS_API_TIMEOUT_MS),
    })
    let parsed: unknown = null
    if (res.status !== 204) {
      try {
        parsed = await res.json()
      } catch {
        parsed = null
      }
    }
    return { status: res.status, body: parsed }
  }
}

/** env(DESEC_TOKEN)에서 토큰을 읽어 provider를 만든다. 미설정 시 throw. */
export function desecDnsFromEnv(zoneName?: string): DesecDnsProvider {
  const token = process.env.DESEC_TOKEN
  if (!token) throw new Error('DESEC_TOKEN is not set')
  return new DesecDnsProvider({ token, zoneName })
}
