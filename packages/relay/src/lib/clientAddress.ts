import type http from 'http'

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
  /**
   * The request arrived on the tunnel listener. Required rather than optional so a new caller cannot
   * forget it and quietly get the loopback answer back.
   */
  viaTunnel: boolean
}

export interface ResolvedClientAddress {
  addr: string
  isLocal: boolean
}

/**
 * **Where a connection came in decides locality, not only its address.** A tunnel client (rathole,
 * `tailscale serve`) runs on this machine and connects from loopback on behalf of someone on the internet
 * or the tailnet, and rathole forwards raw TCP, so no header says so. Nothing about such a socket can be
 * told apart from `tapflow start`'s own agent — except the port it was sent to. The address is still
 * resolved as usual: it keys the login rate limiter and appears in the logs.
 */
export function resolveClientAddress(input: ResolveClientAddressInput): ResolvedClientAddress {
  const resolved = resolveByAddress(input)
  return input.viaTunnel ? { addr: resolved.addr, isLocal: false } : resolved
}

function resolveByAddress(input: ResolveClientAddressInput): ResolvedClientAddress {
  const socket = normalize(input.socketAddr)
  const fromTrustedProxy = input.trustedProxies.includes(socket)
  const xff = (input.forwardedFor ?? '').trim()

  if (fromTrustedProxy && xff.length > 0) {
    // 신뢰 프록시 경유: XFF 최좌측은 클라이언트가 임의 주입할 수 있다(nginx 등은 기존 헤더에 append).
    // 우측(프록시가 직접 관찰한 쪽)부터 신뢰 프록시 IP를 벗겨내고, 첫 비신뢰 IP를 원 클라이언트로 본다.
    const chain = xff.split(',').map((s) => normalize(s.trim())).filter((s) => s.length > 0)
    let i = chain.length - 1
    while (i >= 0 && input.trustedProxies.includes(chain[i])) i--
    // 전부 신뢰 프록시(원 클라이언트 식별 불가) → 안전 기본(원격 간주).
    if (i < 0) return { addr: socket, isLocal: false }
    return { addr: chain[i], isLocal: isLoopback(chain[i]) }
  }

  // 직접 연결: 신뢰 프록시 IP라도 XFF가 없으면 프록시 미경유 직접 접근으로 본다(프록시는 항상 XFF를
  // 추가하므로) — 호스트에서의 admin init / CLI / agent가 막히지 않게 한다.
  // 비신뢰 출발지가 보낸 XFF는 스푸핑 가능하므로 무시하고, 어느 경우든 소켓 IP로 판정한다.
  return { addr: socket, isLocal: isLoopback(socket) }
}

// Keyed by the request object rather than the socket: an HTTPS server hands its `connection` listener the
// raw TCP socket while `req.socket` is the TLS one, and the upgrade path passes this same object on to the
// WebSocket `connection` handler.
const tunnelRequests = new WeakSet<http.IncomingMessage>()

export function markTunnelIngress(req: http.IncomingMessage): void {
  tunnelRequests.add(req)
}

export function isTunnelIngress(req: http.IncomingMessage): boolean {
  return tunnelRequests.has(req)
}

/**
 * Locality of an HTTP request, for every door that serves only the relay host (`auth/init`,
 * `auth/status`, `/api/v1/logs`). The trusted-proxy list is an argument rather than read from config
 * here, so each caller passes the same list the WebSocket path uses: one locality rule, not one per
 * route. The tunnel listener's mark is read here, so no caller can forget it.
 */
export function resolveRequestClient(req: http.IncomingMessage, trustedProxies: string[]): ResolvedClientAddress {
  const xff = req.headers['x-forwarded-for']
  return resolveClientAddress({
    socketAddr: req.socket.remoteAddress ?? '',
    forwardedFor: Array.isArray(xff) ? xff[0] : xff,
    trustedProxies,
    viaTunnel: isTunnelIngress(req),
  })
}
