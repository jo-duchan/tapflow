import path from 'path'
import { z } from 'zod'
import { RelayServer, initDb, config } from '@tapflowio/relay'
import { banner, step } from '../lib/print.js'
import { initConfigFile } from '../lib/init-config.js'

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
  initConfigFile()
  initDb(path.join(config.server.dataDir, 'tapflow.db'))
  const server = new RelayServer({ port, uploadsDir: path.join(config.server.dataDir, 'uploads'), wsBackpressureBytes: config.server.wsBackpressureBytes })
  await server.start()
  step(`Relay started on ws://localhost:${port}`)

  banner('success', 'TAPFLOW RELAY READY', [
    `Relay  : http://localhost:${port}`,
    `Connect Mac agents:  tapflow start --relay ws://<host>:${port}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => process.exit(0))
}
