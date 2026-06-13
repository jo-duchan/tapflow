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
const corsOrigins = [buildInviteBaseUrl(config), `http://localhost:${port}`, `http://127.0.0.1:${port}`]

const server = new RelayServer({ port, uploadsDir, wsBackpressureBytes: config.local.wsBackpressureBytes, trustedProxies: config.local.trustedProxies, corsOrigins })

void server.start().then(() => {
  logger.info(`tapflow relay running on port ${port}`)
})

process.on('SIGTERM', () => server.stop().then(() => process.exit(0)))
process.on('SIGINT', () => server.stop().then(() => process.exit(0)))
