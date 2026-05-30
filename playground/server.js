import path from 'path'
import { RelayServer, initDb, config } from '@tapflowio/relay'

const port = config.local.port
initDb(path.join(config.local.dataDir, 'tapflow.db'))
const server = new RelayServer({
  port,
  uploadsDir: path.join(config.local.dataDir, 'uploads'),
  wsBackpressureBytes: config.local.wsBackpressureBytes,
})
await server.start()
console.log(`Relay started on port ${port}`)
