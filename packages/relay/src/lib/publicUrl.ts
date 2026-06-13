import type { TapflowConfig } from './config.js'

// #6 — 초대/공개 링크의 신뢰 base URL.
// `req.headers.host`/`x-forwarded-proto`는 클라이언트가 조작할 수 있어(Host 인젝션) 피싱 링크가
// 정상 메일로 발송될 수 있다. 따라서 Host 헤더 대신 설정값에서만 base를 도출한다.
// 우선순위: 터널 공개 URL → 설정된 relay URL(ws→http 변환) → localhost 폴백.
export function buildInviteBaseUrl(cfg: Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>): string {
  if (cfg.tunnel?.publicUrl) return stripTrailingSlash(cfg.tunnel.publicUrl)
  if (cfg.relay.url) {
    const http = cfg.relay.url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
    return stripTrailingSlash(http)
  }
  return `http://localhost:${cfg.local.port}`
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '')
}
