import type { DnsProvider } from './DnsProvider.js'
import { cloudflareDnsFromEnv } from './CloudflareDnsProvider.js'
import { vercelDnsFromEnv } from './VercelDnsProvider.js'

// DNS provider 확장점(OCP). 새 공급자는 어댑터 + register()만으로 추가된다 —
// createCertProvider/addressPublisher/config 스키마/wizard는 이 레지스트리만 조회한다.
export interface DnsProviderEntry {
  /** config의 dnsProvider 값이자 식별자. */
  name: string
  /** wizard 표시 라벨. */
  label: string
  /** wizard 힌트. */
  hint: string
  /** 자격 증명 env 변수(검증·요약용). 비밀은 config가 아니라 env에서만 읽는다. */
  envVars: string[]
  /** env에서 자격을 읽어 DnsProvider를 만든다(미설정 시 throw). */
  fromEnv(zoneName?: string): DnsProvider
}

class DnsProviderRegistry {
  private readonly entries = new Map<string, DnsProviderEntry>()
  register(entry: DnsProviderEntry): void {
    this.entries.set(entry.name, entry)
  }
  get(name: string): DnsProviderEntry | undefined {
    return this.entries.get(name)
  }
  has(name: string): boolean {
    return this.entries.has(name)
  }
  list(): DnsProviderEntry[] {
    return [...this.entries.values()]
  }
  names(): string[] {
    return [...this.entries.keys()]
  }
}

export const dnsProviders = new DnsProviderRegistry()

dnsProviders.register({
  name: 'cloudflare',
  label: 'Cloudflare DNS',
  hint: 'auto-issue & renew via API token (env TAPFLOW_CLOUDFLARE_TOKEN)',
  envVars: ['TAPFLOW_CLOUDFLARE_TOKEN'],
  fromEnv: cloudflareDnsFromEnv,
})
dnsProviders.register({
  name: 'vercel',
  label: 'Vercel DNS',
  hint: 'auto-issue & renew via API token (env TAPFLOW_VERCEL_TOKEN)',
  envVars: ['TAPFLOW_VERCEL_TOKEN'],
  fromEnv: vercelDnsFromEnv,
})
