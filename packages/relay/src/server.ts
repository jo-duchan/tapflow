import path from 'path'
import { initDb } from './db.js'
import { RelayServer } from './RelayServer.js'
import { config } from './lib/config.js'
import { buildInviteBaseUrl } from './lib/publicUrl.js'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('relay')

const { port, dataDir } = config.local
const dbPath = path.join(dataDir, 'tapflow.db')
const uploadsDir = path.join(dataDir, 'uploads')

initDb(dbPath)

// CORS allowlist: the configured public URL + loopback (dev). LAN access is same-origin, so
// dynamic LAN IPs need not be listed; cross-origin browser use of a PAT is what we're restricting.
// Entries must be origins (scheme+host+port, no path) to match the browser's Origin header, so
// normalize the configured public URL via URL().origin.
const configuredOrigin = (() => {
  try { return new URL(buildInviteBaseUrl(config)).origin } catch { return null }
})()
const corsOrigins = [configuredOrigin, `http://localhost:${port}`, `http://127.0.0.1:${port}`]
  .filter((o): o is string => o !== null)

// Proxied/tunneled exposure needs a public URL so the dashboard's cross-origin requests survive the
// CORS/CSRF guards. Without it the allowlist is loopback-only and proxied POSTs can be blocked silently.
if (config.local.trustedProxies.length > 0 && !config.tunnel?.publicUrl && !config.relay.url) {
  logger.warn(
    'TAPFLOW_TRUSTED_PROXIES is set but no public URL (tunnel.publicUrl / relay.url) is configured. ' +
    'Cross-origin dashboard requests may be blocked by the CSRF guard — set the public URL for proxied deployments.'
  )
}

const server = new RelayServer({ port, uploadsDir, wsBackpressureBytes: config.local.wsBackpressureBytes, trustedProxies: config.local.trustedProxies, corsOrigins })

void server.start().then(() => {
  logger.info(`tapflow relay running on port ${port}`)
})

process.on('SIGTERM', () => server.stop().then(() => process.exit(0)))
process.on('SIGINT', () => server.stop().then(() => process.exit(0)))
