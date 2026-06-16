import type { TapflowConfig } from './config.js'
import { buildInviteBaseUrl } from './publicUrl.js'

type ProxyCfg = Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>

// CORS allowlist: the configured public URL + loopback (dev). LAN access is same-origin, so dynamic
// LAN IPs need not be listed; cross-origin browser use of a PAT is what we're restricting. Entries
// must be origins (scheme+host+port, no path) to match the browser's Origin header.
export function buildCorsOrigins(cfg: ProxyCfg, port: number): string[] {
  const configuredOrigin = (() => {
    try { return new URL(buildInviteBaseUrl(cfg)).origin } catch { return null }
  })()
  const origins = [configuredOrigin, `http://localhost:${port}`, `http://127.0.0.1:${port}`]
    .filter((o): o is string => o !== null)
  return [...new Set(origins)]
}

// Proxied/tunneled exposure needs a public URL so the dashboard's cross-origin requests survive the
// CORS/CSRF guards. Without it the allowlist is loopback-only and proxied POSTs can be blocked silently.
export function proxyWithoutPublicUrlWarning(cfg: ProxyCfg): string | null {
  if (cfg.local.trustedProxies.length > 0 && !cfg.tunnel?.publicUrl && !cfg.relay.url) {
    return (
      'TAPFLOW_TRUSTED_PROXIES is set but no public URL (tunnel.publicUrl / relay.url) is configured. ' +
      'Cross-origin dashboard requests may be blocked by the CSRF guard — set the public URL for proxied deployments.'
    )
  }
  return null
}
