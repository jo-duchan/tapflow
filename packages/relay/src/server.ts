import path from 'path'
import { initDb } from './db.js'
import { RelayServer } from './RelayServer.js'
import { config } from './lib/config.js'

const { port, dataDir } = config.server
const dbPath = path.join(dataDir, 'tapflow.db')
const uploadsDir = path.join(dataDir, 'uploads')

initDb(dbPath)

const server = new RelayServer({ port, uploadsDir })

void server.start().then(() => {
  console.log(`tapflow relay running on port ${port}`)
})

process.on('SIGTERM', () => server.stop().then(() => process.exit(0)))
process.on('SIGINT', () => server.stop().then(() => process.exit(0)))
