import type { TapflowConfig } from './config.js'
import { buildInviteBaseUrl, forTeammates, resolvePublicBaseUrl, resolvePublicBaseUrls, type TunnelRuntime } from './publicUrl.js'

type ProxyCfg = Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>

// Allow cross-origin PAT use only from the public origins + loopback (LAN is same-origin).
export function buildCorsOrigins(cfg: ProxyCfg, port: number, tunnel?: TunnelRuntime): string[] {
  // Not buildInviteBaseUrl: its localhost fallback would allowlist a stale loopback at config.local.port under a different --port.
  // Every public base, not only the preferred one: a detected tunnel must not push relay.url out.
  const configuredOrigins = resolvePublicBaseUrls(cfg, tunnel).map((base) => {
    try { return new URL(base).origin } catch { return null }
  })
  const origins = [...configuredOrigins, `http://localhost:${port}`, `http://127.0.0.1:${port}`]
    .filter((o): o is string => o !== null)
  return [...new Set(origins)]
}

/** Where the tunnel listener goes when nothing names a port. See `RelayServer`'s `tunnelPort`. */
export const DEFAULT_TUNNEL_PORT = 4001

/**
 * The port for the tunnel listener, for an entry point that starts or expects a tunnel.
 *
 * `tapflow relay start --port 4001` says nothing about the tunnel port, so a default that lands on the
 * relay's own port steps aside instead of failing on a collision nobody asked for. A port named on purpose
 * is returned as is, and a collision there is refused by `RelayServer` with the setting's name.
 */
export function resolveTunnelPort(explicit: number | null, relayPort: number): number {
  if (explicit !== null) return explicit
  return relayPort === DEFAULT_TUNNEL_PORT ? DEFAULT_TUNNEL_PORT + 1 : DEFAULT_TUNNEL_PORT
}

// A proxied/tunneled relay needs a public URL, or the CSRF/CORS allowlist stays loopback-only and blocks proxied POSTs.
export function proxyWithoutPublicUrlWarning(cfg: ProxyCfg, tunnel?: TunnelRuntime): string | null {
  if (cfg.local.trustedProxies.length > 0 && resolvePublicBaseUrl(cfg, tunnel) === null) {
    return (
      'TAPFLOW_TRUSTED_PROXIES is set but no public URL is in effect (a started tunnel\'s publicUrl, or relay.url). ' +
      'Cross-origin dashboard requests may be blocked by the CSRF guard — set the public URL for proxied deployments.'
    )
  }
  return null
}

// Inside a container the relay cannot learn the address people type, and running without one fails
// silently: invitation mail opens the recipient's own machine. The Docker docs ask for TAPFLOW_RELAY_URL;
// this is the same request at the moment it was skipped. Outside a container a missing public URL is the
// normal LAN setup, so it says nothing there. `inContainer` is a parameter so the decision is testable.
export function containerWithoutPublicUrlWarning(cfg: ProxyCfg, inContainer: boolean, tunnel?: TunnelRuntime): string | null {
  if (!inContainer || forTeammates(resolvePublicBaseUrl(cfg, tunnel)) !== null) return null
  return (
    `Running in a container with no public URL a teammate can open, so invitation links point at ${buildInviteBaseUrl(cfg, tunnel)}. ` +
    'Set TAPFLOW_RELAY_URL to the address people type, e.g. http://<this-box-ip>:4000.'
  )
}
