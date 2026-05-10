import path from 'path'
import { initDb } from './db'
import { RelayServer } from './RelayServer'

const port = Number(process.env.TAPFLOW_PORT ?? 4000)
const dataDir = process.env.TAPFLOW_DATA_DIR ?? path.join(process.cwd(), '.tapflow')
const dbPath = path.join(dataDir, 'tapflow.db')
const uploadsDir = path.join(dataDir, 'uploads')

initDb(dbPath)

const server = new RelayServer({
  port,
  uploadsDir,
})

server.start().then(() => {
  console.log(`tapflow relay running on port ${port}`)
})

process.on('SIGTERM', () => server.stop().then(() => process.exit(0)))
process.on('SIGINT', () => server.stop().then(() => process.exit(0)))
