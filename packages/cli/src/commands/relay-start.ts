import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { RelayServer, initDb, config, createCertProvider, startCertRenewal, startAddressPublisher, buildCorsOrigins, proxyWithoutPublicUrlWarning } from '@tapflowio/relay'
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

  let tls: { cert: string; key: string } | undefined
  let certProvider: ReturnType<typeof createCertProvider> | null = null
  if (config.tls) {
    certProvider = createCertProvider(config.tls, { dataDir: config.local.dataDir })
    const material = await certProvider.ensureCert()
    tls = { cert: material.cert, key: material.key }
  }
  const httpScheme = tls ? 'https' : 'http'
  const wsScheme = tls ? 'wss' : 'ws'
  // A domain-bound cert won't validate against localhost, so advertise the cert's domain instead.
  const displayHost = config.tls?.mode === 'byo-api-token' ? config.tls.domain : 'localhost'

  const proxyWarning = proxyWithoutPublicUrlWarning(config)
  if (proxyWarning) warn(proxyWarning)
  const server = new RelayServer({ port, uploadsDir: path.join(config.local.dataDir, 'uploads'), wsBackpressureBytes: config.local.wsBackpressureBytes, trustedProxies: config.local.trustedProxies, corsOrigins: buildCorsOrigins(config, port), tls })
  await server.start()
  step(`Relay started on ${httpScheme}://${displayHost}:${port}`)
  const stopRenewal = certProvider
    ? startCertRenewal(certProvider, { onRenew: (m) => server.updateTlsContext({ cert: m.cert, key: m.key }) })
    : null
  // byo-api-token: publish the relay's LAN IP to the domain's A record so teammates just open the URL.
  const stopPublish =
    config.tls?.mode === 'byo-api-token' && config.tls.publishAddress !== false
      ? startAddressPublisher(config.tls)
      : null

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
    `Relay  : ${httpScheme}://${displayHost}:${port}`,
    ...(publicUrl ? [`Public : ${publicUrl}`] : []),
    `Connect Mac agents:  tapflow agent start --relay ${wsScheme}://<host>:${port}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    stopRenewal?.()
    stopPublish?.()
    void tunnel?.stop()
    process.exit(0)
  })
}
