import path from 'path'
import { RelayServer, initDb } from '@tapflow/relay'

const PORT = Number(process.env.PORT ?? 4000)
const dataDir = path.join(import.meta.dirname, '.tapflow')

initDb(path.join(dataDir, 'tapflow.db'))

const server = new RelayServer({
  port: PORT,
  uploadsDir: path.join(dataDir, 'uploads'),
})

server.start()

console.log(`Relay  →  ws://localhost:${PORT}`)
console.log(`Dashboard  →  http://localhost:${PORT}  (dev: http://localhost:3001)`)
console.log('\nWaiting for agents...')
