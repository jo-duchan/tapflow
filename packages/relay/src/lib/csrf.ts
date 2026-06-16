import type http from 'http'

// #5 — CSRF 경량 가드.
// 상태 변경 API가 `SameSite=Lax` 쿠키에만 의존하면 일부 cross-site 요청이 통과할 수 있다.
// 쿠키로 인증된 상태 변경 요청은 Origin이 same-origin(Host 일치)이거나 신뢰 allowlist에 있을 때만
// 허용하고, 그 외 cross-origin은 차단한다. 브라우저는 상태 변경 요청에 Origin을 강제로 붙이므로
// 대시보드(same-origin)는 그대로 통과하고, 공격자 origin은 막힌다.
// 면제: 안전 메서드(GET/HEAD/OPTIONS), PAT 인증(Authorization — 쿠키 자동 전송이 아님),
//       쿠키 없는 요청(미인증/login/init), Origin 없는 요청(비-브라우저; 브라우저는 cross-site에 Origin을 생략하지 못한다).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Loopback origins are the local dev machine (e.g. Vite :3001 proxying to the relay :4000), never a
// remote attacker — a cross-site page can't forge a localhost Origin, so exempting these is safe.
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

export function isCsrfBlocked(
  method: string | undefined,
  headers: http.IncomingHttpHeaders,
  allowedOrigins: Set<string>,
): boolean {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return false
  if (headers['authorization']) return false
  const cookie = headers['cookie']
  const hasCookieAuth = typeof cookie === 'string' && cookie.includes('tapflow_token=')
  if (!hasCookieAuth) return false

  const origin = headers['origin']
  if (!origin) return false
  if (allowedOrigins.has(origin)) return false

  const host = headers['host']
  try {
    const url = new URL(origin)
    if (host && url.host === host) return false
    if (isLoopbackHost(url.hostname)) return false
  } catch {
    // malformed Origin → treat as cross-origin (blocked below)
  }
  return true
}
