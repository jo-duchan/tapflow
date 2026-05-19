import { z } from 'zod'
import { RelayServer } from '@tapflow/relay'
import { banner, step } from '../lib/print.js'

export interface RelayStartOptions {
  port?: number
}

const DEFAULT_PORT = 4000

const portSchema = z.number().int().min(1).max(65535, 'port must be between 1 and 65535')

export async function cmdRelayStart(opts: RelayStartOptions): Promise<void> {
  const rawPort = opts.port ?? DEFAULT_PORT
  const portResult = portSchema.safeParse(rawPort)
  if (!portResult.success) {
    banner('error', 'INVALID CONFIG', [`--port: ${portResult.error.issues[0].message}`])
    process.exit(1)
  }
  const port = portResult.data
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
