import type { TapflowConfig } from './config.js'
import { buildInviteBaseUrl } from './publicUrl.js'

type ProxyCfg = Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>

// Allow cross-origin PAT use only from the configured public origin + loopback (LAN is same-origin).
export function buildCorsOrigins(cfg: ProxyCfg, port: number): string[] {
  // Skip buildInviteBaseUrl's localhost fallback — it would allowlist a stale loopback at config.local.port under a different --port.
  const configuredOrigin = (() => {
    if (!cfg.tunnel?.publicUrl && !cfg.relay.url) return null
    try { return new URL(buildInviteBaseUrl(cfg)).origin } catch { return null }
  })()
  const origins = [configuredOrigin, `http://localhost:${port}`, `http://127.0.0.1:${port}`]
    .filter((o): o is string => o !== null)
  return [...new Set(origins)]
}

// A proxied/tunneled relay needs a public URL, or the CSRF/CORS allowlist stays loopback-only and blocks proxied POSTs.
export function proxyWithoutPublicUrlWarning(cfg: ProxyCfg): string | null {
  if (cfg.local.trustedProxies.length > 0 && !cfg.tunnel?.publicUrl && !cfg.relay.url) {
    return (
      'TAPFLOW_TRUSTED_PROXIES is set but no public URL (tunnel.publicUrl / relay.url) is configured. ' +
      'Cross-origin dashboard requests may be blocked by the CSRF guard — set the public URL for proxied deployments.'
    )
  }
  return null
}
