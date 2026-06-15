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

// UDP connect(패킷 미전송)로 기본 라우트 인터페이스 IPv4를 얻는다 — networkInterfaces()는 VPN/멀티NIC 오감지 위험.
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

// byo-api-token일 때 LAN IP를 자기 도메인 A 레코드로 발행 — 팀원은 DNS를 손대지 않고 도메인만 연다.
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

  // setInterval이 이전 upsert 완료 전 다음 publish를 시작하면 쓰기가 역순으로 끝나 stale IP가 남을 수 있다.
  let inFlight = false
  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try { await publish() } finally { inFlight = false }
  }

  void tick()
  const timer = setInterval(() => void tick(), opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
