import path from 'path'
import { z } from 'zod'
import { RelayServer, initDb, config } from '@tapflowio/relay'
import { banner, step } from '../lib/print.js'
import { RatholeTunnel } from '../lib/rathole-tunnel.js'
import { TailscaleTunnel } from '../lib/tailscale-tunnel.js'
import type { TunnelPlugin } from '../lib/tunnel.js'

export interface RelayStartOptions {
  port?: number
  tunnel?: string
}

const DEFAULT_PORT = config.local.port

const portSchema = z.number().int().min(1).max(65535, 'port must be between 1 and 65535')

export async function cmdRelayStart(opts: RelayStartOptions): Promise<void> {
  const rawPort = opts.port ?? DEFAULT_PORT
  const portResult = portSchema.safeParse(rawPort)
  if (!portResult.success) {
    banner('error', 'INVALID CONFIG', [`--port: ${portResult.error.issues[0].message}`])
    process.exit(1)
  }
  const port = portResult.data
  initDb(path.join(config.local.dataDir, 'tapflow.db'))
  const server = new RelayServer({ port, uploadsDir: path.join(config.local.dataDir, 'uploads'), wsBackpressureBytes: config.local.wsBackpressureBytes })
  await server.start()
  step(`Relay started on ws://localhost:${port}`)

  const SUPPORTED_PROVIDERS = ['rathole', 'tailscale']
  if (opts.tunnel && !SUPPORTED_PROVIDERS.includes(opts.tunnel)) {
    banner('error', 'TUNNEL CONFIG ERROR', [`Unsupported tunnel provider: "${opts.tunnel}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`])
    process.exit(1)
  }

  const tunnelCfg = config.tunnel
  let tunnel: TunnelPlugin | null = null

  if (tunnelCfg != null || opts.tunnel) {
    if (!tunnelCfg) {
      banner('error', 'TUNNEL CONFIG ERROR', ['tunnel section is required in tapflow.config.json when using --tunnel'])
      process.exit(1)
    }
    if (tunnelCfg.provider === 'tailscale') {
      tunnel = new TailscaleTunnel({ publicUrl: tunnelCfg.publicUrl })
    } else {
      const token = process.env.TAPFLOW_TUNNEL_TOKEN ?? ''
      if (!token) {
        banner('error', 'TUNNEL CONFIG ERROR', ['TAPFLOW_TUNNEL_TOKEN env var is required for rathole tunnel'])
        process.exit(1)
      }
      tunnel = new RatholeTunnel({ serverAddr: tunnelCfg.serverAddr, publicUrl: tunnelCfg.publicUrl, token, ssh: tunnelCfg.ssh ?? undefined })
    }
    try {
      await tunnel.setupServer()
      const { publicUrl } = await tunnel.start(port)
      step(`Tunnel ready — Public URL: ${publicUrl}`)
      banner('success', 'TAPFLOW RELAY READY', [
        `Relay  : http://localhost:${port}`,
        `Public : ${publicUrl}`,
        `Connect Mac agents:  tapflow start --relay ws://<host>:${port}`,
        'Press Ctrl+C to stop.',
      ])
    } catch (err) {
      console.warn(`Tunnel failed to start: ${err instanceof Error ? err.message : String(err)}`)
      tunnel = null
      banner('success', 'TAPFLOW RELAY READY', [
        `Relay  : http://localhost:${port}`,
        `Connect Mac agents:  tapflow start --relay ws://<host>:${port}`,
        'Press Ctrl+C to stop.',
      ])
    }
  } else {
    banner('success', 'TAPFLOW RELAY READY', [
      `Relay  : http://localhost:${port}`,
      `Connect Mac agents:  tapflow start --relay ws://<host>:${port}`,
      'Press Ctrl+C to stop.',
    ])
  }

  process.on('SIGINT', () => {
    void tunnel?.stop()
    process.exit(0)
  })
}
