import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { RelayServer, initDb, config } from '@tapflowio/relay'
import { banner, step, warn } from '../lib/print.js'
import { startConfiguredTunnel } from '../lib/tunnel-runner.js'
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
  if (!fs.existsSync(path.join(process.cwd(), 'tapflow.config.json'))) {
    warn('tapflow.config.json not found — using defaults. Run tapflow init to configure.')
  }
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

  let publicUrl: string | null = null
  if (tunnelCfg != null || opts.tunnel) {
    if (!tunnelCfg) {
      banner('error', 'TUNNEL CONFIG ERROR', ['tunnel section is required in tapflow.config.json when using --tunnel'])
      process.exit(1)
    }
    const started = await startConfiguredTunnel(tunnelCfg, port)
    tunnel = started.tunnel
    publicUrl = started.publicUrl
  }

  banner('success', 'TAPFLOW RELAY READY', [
    `Relay  : http://localhost:${port}`,
    ...(publicUrl ? [`Public : ${publicUrl}`] : []),
    `Connect Mac agents:  tapflow agent start --relay ws://<host>:${port}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    void tunnel?.stop()
    process.exit(0)
  })
}
