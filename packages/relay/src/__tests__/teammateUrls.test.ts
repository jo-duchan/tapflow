import { describe, it, expect } from 'vitest'
import {
  resolvePublicBaseUrl,
  resolveAgentRelayUrl,
  forTeammates,
  buildInviteBaseUrl,
  type TunnelRuntime,
} from '../lib/publicUrl'
import { buildCorsOrigins, containerWithoutPublicUrlWarning, proxyWithoutPublicUrlWarning } from '../lib/proxyConfig'
import type { TapflowConfig } from '../lib/config'

// Kept apart from publicUrl.test.ts on purpose: an open external PR (#777) appends to that file, and
// its existing six cases are this change's proof that the one-argument call still returns what it did.

type Cfg = Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>

function cfg(over: { tunnel?: TapflowConfig['tunnel']; relayUrl?: string | null; trustedProxies?: string[] } = {}): Cfg {
  return {
    tunnel: over.tunnel ?? null,
    relay: { url: over.relayUrl ?? null },
    local: { port: 4000, dataDir: '.', wsBackpressureBytes: 1, trustedProxies: over.trustedProxies ?? [], tunnelPort: null },
  }
}

const rathole = (publicUrl: string): TapflowConfig['tunnel'] =>
  ({ provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl, ssh: null })
const tailscale = (publicUrl?: string): TapflowConfig['tunnel'] => ({ provider: 'tailscale', publicUrl })

describe('resolvePublicBaseUrl — with no runtime tunnel state, config decides', () => {
  it('prefers the tunnel URL over relay.url', () => {
    expect(resolvePublicBaseUrl(cfg({ tunnel: rathole('https://vps.example.com/'), relayUrl: 'ws://10.0.0.5:4000' })))
      .toBe('https://vps.example.com')
  })

  it('maps ws/wss relay.url to http/https', () => {
    expect(resolvePublicBaseUrl(cfg({ relayUrl: 'ws://192.168.0.9:4000' }))).toBe('http://192.168.0.9:4000')
    expect(resolvePublicBaseUrl(cfg({ relayUrl: 'wss://relay.example.com' }))).toBe('https://relay.example.com')
  })

  it('is null when nothing is configured, including an empty tailscale publicUrl', () => {
    expect(resolvePublicBaseUrl(cfg())).toBeNull()
    expect(resolvePublicBaseUrl(cfg({ tunnel: tailscale('') }))).toBeNull()
    expect(resolvePublicBaseUrl(cfg({ tunnel: tailscale() }))).toBeNull()
  })

  it('keeps a path and drops only the trailing slash', () => {
    expect(resolvePublicBaseUrl(cfg({ tunnel: rathole('https://x.example.com/tapflow/') })))
      .toBe('https://x.example.com/tapflow')
  })
})

describe('resolvePublicBaseUrl — runtime tunnel state wins over config', () => {
  it('uses a URL the CLI detected when config has none (#794)', () => {
    const tunnel: TunnelRuntime = { publicUrl: 'http://mac.tailnet.ts.net:4000' }
    expect(resolvePublicBaseUrl(cfg({ tunnel: tailscale() }), tunnel)).toBe('http://mac.tailnet.ts.net:4000')
  })

  it('ignores a configured tunnel URL when the CLI reports the tunnel did not start', () => {
    const down: TunnelRuntime = { publicUrl: null }
    expect(resolvePublicBaseUrl(cfg({ tunnel: rathole('https://vps.example.com'), relayUrl: 'http://192.168.0.9:4000' }), down))
      .toBe('http://192.168.0.9:4000')
    expect(resolvePublicBaseUrl(cfg({ tunnel: rathole('https://vps.example.com') }), down)).toBeNull()
  })
})

describe('buildInviteBaseUrl — the localhost fallback is for mail only', () => {
  it('follows runtime state when given, and falls back to localhost when nothing resolves', () => {
    expect(buildInviteBaseUrl(cfg({ tunnel: tailscale() }), { publicUrl: 'http://mac.tailnet.ts.net:4000' }))
      .toBe('http://mac.tailnet.ts.net:4000')
    expect(buildInviteBaseUrl(cfg({ tunnel: rathole('https://vps.example.com') }), { publicUrl: null }))
      .toBe('http://localhost:4000')
  })
})

describe('resolveAgentRelayUrl — only relay.url says where agents connect', () => {
  it('ignores the tunnel entirely', () => {
    expect(resolveAgentRelayUrl(cfg({ tunnel: rathole('https://vps.example.com') }))).toBeNull()
  })

  it('maps http/https to ws/wss and drops a trailing slash', () => {
    expect(resolveAgentRelayUrl(cfg({ relayUrl: 'http://192.168.0.9:4000' }))).toBe('ws://192.168.0.9:4000')
    expect(resolveAgentRelayUrl(cfg({ relayUrl: 'https://relay.example.com' }))).toBe('wss://relay.example.com')
    expect(resolveAgentRelayUrl(cfg({ relayUrl: 'wss://r.example.com/' }))).toBe('wss://r.example.com')
  })
})

describe('forTeammates — an address only the relay host can open is not handed out', () => {
  it.each([
    'http://localhost:4000',
    'http://LOCALHOST:4000',
    'http://localhost.:4000',
    'ws://127.0.0.1:4000',
    'http://127.8.0.1:4000',
    'http://2130706433:4000',
    'http://[::1]:4000',
    'http://[::ffff:127.0.0.1]:4000',
    'http://0.0.0.0:4000',
    'http://[::]:4000',
    'not a url',
  ])('%s → null', (url) => {
    expect(forTeammates(url)).toBeNull()
  })

  it.each([
    'http://192.168.0.9:4000',
    'https://localhost.example.com',
    'http://mac.tailnet.ts.net:4000',
    'http://[::ffff:192.168.0.1]:4000',
  ])('%s passes through', (url) => {
    expect(forTeammates(url)).toBe(url)
  })

  it('passes null through', () => {
    expect(forTeammates(null)).toBeNull()
  })
})

describe('containerWithoutPublicUrlWarning — the Docker mistake is said out loud at startup', () => {
  it('warns inside a container when no address a teammate can open is configured', () => {
    const warning = containerWithoutPublicUrlWarning(cfg(), true)
    expect(warning).toContain('TAPFLOW_RELAY_URL')
    expect(warning).toContain('http://localhost:4000')
  })

  it('treats a loopback relay.url as no address', () => {
    expect(containerWithoutPublicUrlWarning(cfg({ relayUrl: 'ws://localhost:4000' }), true)).toContain('TAPFLOW_RELAY_URL')
    // A bind address copied into the URL is the likely Docker mistake.
    expect(containerWithoutPublicUrlWarning(cfg({ relayUrl: 'http://0.0.0.0:4000' }), true)).toContain('TAPFLOW_RELAY_URL')
  })

  it('stays quiet once a reachable address is configured', () => {
    expect(containerWithoutPublicUrlWarning(cfg({ relayUrl: 'http://192.168.0.9:4000' }), true)).toBeNull()
    expect(containerWithoutPublicUrlWarning(cfg({ tunnel: rathole('https://vps.example.com') }), true)).toBeNull()
  })

  it('uses the runtime tunnel URL when the relay is started with tunnel state', () => {
    expect(containerWithoutPublicUrlWarning(cfg({ tunnel: tailscale() }), true, { publicUrl: 'https://mac.tailnet.ts.net:4000' })).toBeNull()
    expect(containerWithoutPublicUrlWarning(cfg({ tunnel: rathole('https://stale.example.com') }), true, { publicUrl: null }))
      .toContain('http://localhost:4000')
  })

  it('warns when the selected runtime tunnel URL is unusable even if relay.url is reachable', () => {
    const configWithFallback = cfg({ tunnel: rathole('http://127.0.0.1:4000'), relayUrl: 'https://relay.example.com' })
    expect(containerWithoutPublicUrlWarning(configWithFallback, true, { publicUrl: 'http://127.0.0.1:4000' }))
      .toContain('127.0.0.1:4000')
  })

  it('stays quiet outside a container, where a missing public URL is the normal LAN setup', () => {
    expect(containerWithoutPublicUrlWarning(cfg(), false)).toBeNull()
  })
})

describe('CORS allowlist and proxy warning follow runtime tunnel state', () => {
  it('a detected tunnel URL joins the allowlist and silences the proxy warning', () => {
    const c = cfg({ tunnel: tailscale(), trustedProxies: ['127.0.0.1'] })
    const up: TunnelRuntime = { publicUrl: 'http://mac.tailnet.ts.net:4000' }
    expect(buildCorsOrigins(c, 4000, up)).toContain('http://mac.tailnet.ts.net:4000')
    expect(proxyWithoutPublicUrlWarning(c, up)).toBeNull()
  })

  // On main a Tailscale tunnel with no configured publicUrl left relay.url's origin on the list; a detected
  // URL must add to it, not replace it, or a proxy that rewrites Host starts answering 403.
  it('a detected tunnel does not push relay.url out of the allowlist', () => {
    const c = cfg({ tunnel: tailscale(), relayUrl: 'https://relay.example.com' })
    expect(buildCorsOrigins(c, 4000, { publicUrl: 'http://mac.tailnet.ts.net:4000' }))
      .toEqual(['http://mac.tailnet.ts.net:4000', 'https://relay.example.com', 'http://localhost:4000', 'http://127.0.0.1:4000'])
  })

  it('a tunnel that did not start leaves its configured origin out and brings the warning back', () => {
    const c = cfg({ tunnel: rathole('https://vps.example.com'), trustedProxies: ['127.0.0.1'] })
    const down: TunnelRuntime = { publicUrl: null }
    expect(buildCorsOrigins(c, 4000, down)).toEqual(['http://localhost:4000', 'http://127.0.0.1:4000'])
    expect(proxyWithoutPublicUrlWarning(c, down)).toMatch(/TAPFLOW_TRUSTED_PROXIES/)
  })
})
