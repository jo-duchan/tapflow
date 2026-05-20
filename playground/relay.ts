import path from 'path'
import { RelayServer, initDb } from '@tapflowio/relay'

const PORT = Number(process.env.PORT ?? 4000)
const dataDir = path.join(import.meta.dirname, '.tapflow')

initDb(path.join(dataDir, 'tapflow.db'))

const server = new RelayServer({
  port: PORT,
  uploadsDir: path.join(dataDir, 'uploads'),
})

server.start()

const idleMs = process.env['IDLE_TIMEOUT_MS']
console.log(`Relay  →  ws://localhost:${PORT}`)
console.log(`Dashboard  →  http://localhost:${PORT}  (dev: http://localhost:3001)`)
console.log(`Idle timeout  →  ${idleMs ? `${idleMs}ms (env)` : '300000ms (default)'}`)
console.log('\nWaiting for agents...')
