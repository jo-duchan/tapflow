import { createRelayServer } from '@tapflow/relay'

const PORT = Number(process.env.PORT ?? 3000)

const server = createRelayServer({ port: PORT })
server.start()

console.log(`Relay  →  ws://localhost:${PORT}`)
console.log(`Dashboard  →  http://localhost:${PORT}`)
console.log('\nWaiting for agents...')
