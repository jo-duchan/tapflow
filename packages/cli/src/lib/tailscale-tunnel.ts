import { execSync } from 'child_process'
import type { TunnelPlugin } from './tunnel.js'

interface TailscaleStatus {
  BackendState?: string
  Self?: {
    DNSName?: string
    TailscaleIPs?: string[]
  }
}

export interface TailscaleTunnelOptions {
  publicUrl?: string
}

export class TailscaleTunnel implements TunnelPlugin {
  name = 'tailscale'

  constructor(private opts: TailscaleTunnelOptions) {}

  async setupServer(): Promise<void> {
    // no-op — Tailscale manages its own network layer
  }

  async start(relayPort: number): Promise<{ publicUrl: string }> {
    if (this.opts.publicUrl) return { publicUrl: this.opts.publicUrl }

    try {
      execSync('tailscale version', { stdio: 'pipe' })
    } catch {
      throw new Error(
        'Tailscale is not installed or not in PATH.\n' +
        'Install: brew install tailscale  (macOS) · https://tailscale.com/download\n' +
        'Then run: sudo tailscale up'
      )
    }

    let status: TailscaleStatus
    try {
      const raw = execSync('tailscale status --json', { stdio: 'pipe' }).toString()
      status = JSON.parse(raw) as TailscaleStatus
    } catch {
      throw new Error('Failed to query Tailscale status. Run: tailscale up')
    }

    if (status.BackendState !== 'Running') {
      throw new Error(
        `Tailscale is not connected (state: ${status.BackendState ?? 'unknown'}).\n` +
        'Run: tailscale up'
      )
    }

    const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
    if (dnsName) return { publicUrl: `http://${dnsName}:${relayPort}` }

    const ip = status.Self?.TailscaleIPs?.[0]
    if (ip) return { publicUrl: `http://${ip}:${relayPort}` }

    throw new Error('Could not determine Tailscale IP. Make sure Tailscale is connected: tailscale up')
  }

  async stop(): Promise<void> {
    // no-op — tapflow does not manage the Tailscale lifecycle
  }
}
