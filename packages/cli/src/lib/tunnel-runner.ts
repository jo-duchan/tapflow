import type { TapflowConfig } from '@tapflowio/relay'
import { RatholeTunnel } from './rathole-tunnel.js'
import { TailscaleTunnel } from './tailscale-tunnel.js'
import { step, warn } from './print.js'
import type { TunnelPlugin } from './tunnel.js'

export type TunnelConfig = NonNullable<TapflowConfig['tunnel']>

export interface StartedTunnel {
  tunnel: TunnelPlugin | null
  publicUrl: string | null
}

/**
 * Build the configured tunnel, start it, and return its public URL.
 * On startup failure the relay keeps running — returns nulls so callers fall back to local-only.
 */
export async function startConfiguredTunnel(tunnelCfg: TunnelConfig, port: number): Promise<StartedTunnel> {
  let tunnel: TunnelPlugin
  if (tunnelCfg.provider === 'tailscale') {
    tunnel = new TailscaleTunnel({ publicUrl: tunnelCfg.publicUrl })
  } else {
    const token = process.env.TAPFLOW_TUNNEL_TOKEN ?? ''
    if (!token) {
      warn('TAPFLOW_TUNNEL_TOKEN env var is required for rathole tunnel — continuing without a public tunnel.')
      return { tunnel: null, publicUrl: null }
    }
    tunnel = new RatholeTunnel({ serverAddr: tunnelCfg.serverAddr, publicUrl: tunnelCfg.publicUrl, token, ssh: tunnelCfg.ssh ?? undefined })
  }

  try {
    await tunnel.setupServer()
    const { publicUrl } = await tunnel.start(port)
    step(`Tunnel ready — Public URL: ${publicUrl}`)
    return { tunnel, publicUrl }
  } catch (err) {
    console.warn(`Tunnel failed to start: ${err instanceof Error ? err.message : String(err)}`)
    return { tunnel: null, publicUrl: null }
  }
}
