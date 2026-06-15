import dgram from 'dgram'
import { createLogger } from '@tapflowio/agent-core'
import type { DnsProvider } from './DnsProvider.js'
import { cloudflareDnsFromEnv } from './CloudflareDnsProvider.js'
import { vercelDnsFromEnv } from './VercelDnsProvider.js'

const logger = createLogger('relay:dns')

// DHCP로 IP가 바뀔 수 있어 cert 갱신(12h)보다 자주 재확인한다.
const DEFAULT_INTERVAL_MS = 5 * 60_000

export interface AddressPublisherTls {
  domain: string
  dnsProvider: 'cloudflare' | 'vercel'
  /** 자동 감지 대신 쓸 고정 IP. */
  address?: string
}

export interface AddressPublisherOptions {
  intervalMs?: number
  /** IP 소스 주입(테스트/오버라이드). 기본 = address ?? detectLanIPv4. */
  getIp?: () => Promise<string | null>
  /** DnsProvider 주입(테스트). 기본 = dnsProvider별 env 팩토리. */
  provider?: DnsProvider
  onError?: (err: unknown) => void
}

// 기본 라우트로 나가는 인터페이스의 IPv4를 얻는다. UDP connect는 실제 패킷을 보내지 않고
// 로컬 주소만 결정한다 — os.networkInterfaces()로 고르면 VPN(utun)/멀티NIC에서 오감지하기 쉽다.
export function detectLanIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const done = (ip: string | null) => {
      try { sock.close() } catch { /* already closed */ }
      resolve(ip && ip !== '0.0.0.0' ? ip : null)
    }
    sock.once('error', () => done(null))
    try {
      sock.connect(53, '8.8.8.8', () => {
        try { done(sock.address().address) } catch { done(null) }
      })
    } catch {
      done(null)
    }
  })
}

// byo-api-token일 때 relay의 LAN IP를 자기 도메인 A 레코드로 발행한다(부팅 + IP 변경 시).
// 사용자 자기 DNS 계정 토큰을 이미 보유하므로, 팀원은 DNS를 손대지 않고 도메인만 연다.
export function startAddressPublisher(tls: AddressPublisherTls, opts: AddressPublisherOptions = {}): () => void {
  const dns = opts.provider ?? (tls.dnsProvider === 'vercel' ? vercelDnsFromEnv() : cloudflareDnsFromEnv())
  const upsert = dns.upsertAddressRecord?.bind(dns)
  if (!upsert) {
    logger.warn(`${dns.name} cannot publish A records — skipping address auto-publish`)
    return () => {}
  }
  const getIp = opts.getIp ?? (tls.address ? () => Promise.resolve(tls.address ?? null) : detectLanIPv4)
  let last: string | null = null

  const publish = async (): Promise<void> => {
    try {
      const ip = await getIp()
      if (!ip) {
        logger.warn(`could not determine LAN IP to publish ${tls.domain}`)
        return
      }
      if (ip === last) return
      await upsert(tls.domain, ip)
      last = ip
      logger.info(`published ${tls.domain} A -> ${ip}`)
    } catch (err) {
      if (opts.onError) opts.onError(err)
      else logger.warn(`failed to publish ${tls.domain} A record: ${String(err)}`)
    }
  }

  void publish()
  const timer = setInterval(() => void publish(), opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
