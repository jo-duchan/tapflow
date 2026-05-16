import { RelayServer } from '@tapflow/relay'
import { banner, step } from '../lib/print.js'

export interface RelayStartOptions {
  port?: number
}

const DEFAULT_PORT = 4000

export async function cmdRelayStart(opts: RelayStartOptions): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT
  const server = new RelayServer({ port })
  await server.start()
  step(`Relay started on ws://localhost:${port}`)

  banner('success', 'TAPFLOW RELAY READY', [
    `Relay  : http://localhost:${port}`,
    `Connect Mac agents:  tapflow start --relay ws://<host>:${port}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => process.exit(0))
}
