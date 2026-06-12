// ⑤ trusted-proxy — same-host 리버스 프록시 뒤에서 loopback 무인증 우회를 막는 IP 해석.
// classifyConnection 앞단에서 "이 연결의 실제 클라이언트 IP가 무엇이고 loopback인가"만 판정한다.

// IPv4-mapped IPv6(`::ffff:127.0.0.1`)를 IPv4로 풀고, IPv6 zone id(`%en0`)를 떼낸다.
function normalize(addr: string): string {
  let a = addr.trim()
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (a.toLowerCase().startsWith('::ffff:') && a.includes('.')) a = a.slice(7)
  return a
}

function isLoopback(addr: string): boolean {
  const a = normalize(addr)
  return a === '::1' || a.startsWith('127.')
}

export function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => normalize(s))
    .filter((s) => s.length > 0)
}

export interface ResolveClientAddressInput {
  socketAddr: string
  forwardedFor: string | undefined
  trustedProxies: string[]
}

export interface ResolvedClientAddress {
  addr: string
  isLocal: boolean
}

export function resolveClientAddress(input: ResolveClientAddressInput): ResolvedClientAddress {
  const socket = normalize(input.socketAddr)
  const fromTrustedProxy = input.trustedProxies.includes(socket)

  if (fromTrustedProxy) {
    // 신뢰 프록시 경유: 원 클라이언트는 XFF 최좌측. 없거나 비면 안전 기본(원격 간주).
    const first = input.forwardedFor?.split(',')[0]?.trim()
    if (!first) return { addr: socket, isLocal: false }
    const client = normalize(first)
    return { addr: client, isLocal: isLoopback(client) }
  }

  // 비신뢰 출발지의 XFF는 스푸핑 가능 → 무시하고 소켓 IP로만 판정.
  return { addr: socket, isLocal: isLoopback(socket) }
}
