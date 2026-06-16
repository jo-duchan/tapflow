import path from 'path'
import { initDb } from './db.js'
import { RelayServer } from './RelayServer.js'
import { config } from './lib/config.js'
import { buildCorsOrigins, proxyWithoutPublicUrlWarning } from './lib/proxyConfig.js'
import { createCertProvider, startCertRenewal, startAddressPublisher } from './lib/cert/index.js'
import { loadDataDirEnv } from './lib/loadEnvFile.js'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('relay')

const { port, dataDir } = config.local
// Load gitignored credentials (DNS/ACME tokens) before any cert issuance reads process.env.
const envPath = loadDataDirEnv(dataDir)
if (envPath) logger.info(`Loaded credentials from ${envPath}`)
const dbPath = path.join(dataDir, 'tapflow.db')
const uploadsDir = path.join(dataDir, 'uploads')

initDb(dbPath)

const corsOrigins = buildCorsOrigins(config, port)
const proxyWarning = proxyWithoutPublicUrlWarning(config)
if (proxyWarning) logger.warn(proxyWarning)

async function main(): Promise<void> {
  let tls: { cert: string; key: string } | undefined
  let provider: ReturnType<typeof createCertProvider> | null = null

  if (config.tls) {
    provider = createCertProvider(config.tls, { dataDir })
    const material = await provider.ensureCert()
    tls = { cert: material.cert, key: material.key }
  } else {
    logger.info(
      'TLS disabled — serving HTTP. Secure-context features (e.g. WebCodecs hardware decode) require HTTPS; ' +
      'configure tls in tapflow.config.json to enable.'
    )
  }

  const server = new RelayServer({ port, uploadsDir, wsBackpressureBytes: config.local.wsBackpressureBytes, trustedProxies: config.local.trustedProxies, corsOrigins, tls })
  await server.start()
  logger.info(`tapflow relay running on port ${port} (${tls ? 'https' : 'http'})`)

  const stopRenewal = provider
    ? startCertRenewal(provider, { onRenew: (m) => server.updateTlsContext({ cert: m.cert, key: m.key }) })
    : null

  // byo-api-token: publish the relay's LAN IP to the domain's A record so teammates just open the URL.
  const stopPublish =
    config.tls?.mode === 'byo-api-token' && config.tls.publishAddress !== false
      ? startAddressPublisher(config.tls)
      : null

  const shutdown = () => {
    stopRenewal?.()
    stopPublish?.()
    void server.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main().catch((err) => {
  logger.error(`relay failed to start: ${String(err)}`)
  process.exit(1)
})
