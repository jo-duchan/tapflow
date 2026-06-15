import dgram from 'dgram'
import { createLogger } from '@tapflowio/agent-core'
import type { DnsProvider } from './DnsProvider.js'
import { dnsProviders } from './dnsRegistry.js'

const logger = createLogger('relay:dns')

// DHCP로 IP가 바뀔 수 있어 cert 갱신(12h)보다 자주 재확인한다.
const DEFAULT_INTERVAL_MS = 5 * 60_000
// IP 불변이어도 이 틱 수마다 강제 재발행 — 외부에서 지워지거나 바뀐 레코드를 self-heal(기본 ~1h).
const DEFAULT_REASSERT_TICKS = 12
// connect 콜백/error 둘 다 안 오는 극단 케이스에서 영구 await 방지.
const DETECT_TIMEOUT_MS = 2_000

export interface AddressPublisherTls {
  domain: string
  dnsProvider: string
  /** 자동 감지 대신 쓸 고정 IP. */
  address?: string
}

export interface AddressPublisherOptions {
  intervalMs?: number
  /** IP 소스 주입(테스트/오버라이드). 기본 = address ?? detectLanIPv4. */
  getIp?: () => Promise<string | null>
  /** DnsProvider 주입(테스트). 기본 = dnsProvider별 env 팩토리. */
  provider?: DnsProvider
  /** IP 불변이어도 이 틱 수마다 강제 재발행(self-heal). 기본 12(~1h). */
  reassertEveryTicks?: number
  onError?: (err: unknown) => void
}

// UDP connect(패킷 미전송)로 기본 라우트 인터페이스 IPv4를 얻는다 — networkInterfaces()는 VPN/멀티NIC 오감지 위험.
export function detectLanIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let settled = false
    const done = (ip: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.close() } catch { /* already closed */ }
      resolve(ip && ip !== '0.0.0.0' ? ip : null)
    }
    const timer = setTimeout(() => done(null), DETECT_TIMEOUT_MS)
    timer.unref?.()
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
  const dns = opts.provider ?? dnsProviders.get(tls.dnsProvider)?.fromEnv()
  if (!dns) {
    logger.warn(`unknown dnsProvider "${tls.dnsProvider}" — skipping address auto-publish`)
    return () => {}
  }
  const upsert = dns.upsertAddressRecord?.bind(dns)
  if (!upsert) {
    logger.warn(`${dns.name} cannot publish A records — skipping address auto-publish`)
    return () => {}
  }
  const getIp = opts.getIp ?? (tls.address ? () => Promise.resolve(tls.address ?? null) : detectLanIPv4)
  const reassertEvery = opts.reassertEveryTicks ?? DEFAULT_REASSERT_TICKS
  let last: string | null = null
  let skipped = 0

  const publish = async (): Promise<void> => {
    try {
      const ip = await getIp()
      if (!ip) {
        logger.warn(`could not determine LAN IP to publish ${tls.domain}`)
        return
      }
      // 보통은 IP 불변이면 skip하되, reassertEvery 틱마다 한 번은 강제 재발행해 외부 변경을 self-heal한다.
      if (ip === last && skipped < reassertEvery) {
        skipped++
        return
      }
      await upsert(tls.domain, ip)
      last = ip
      skipped = 0
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
