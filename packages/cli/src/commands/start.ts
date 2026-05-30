import { RelayServer, initDb, config } from '@tapflowio/relay'
import { AgentRegistry } from '@tapflowio/agent-core'
import path from 'path'
import '@tapflowio/ios-agent'
import '@tapflowio/android-agent'
import { banner, createSpinner, step } from '../lib/print.js'
import { initConfigFile } from '../lib/init-config.js'

export interface StartOptions {
  device?: string
  platform?: string
}

const RELAY_PORT = config.server.port

export async function cmdStart(opts: StartOptions): Promise<void> {
  const relayUrl = `ws://localhost:${RELAY_PORT}`
  const explicit = opts.platform

  let platformsToRun: string[]
  if (!explicit || explicit === 'all') {
    platformsToRun = AgentRegistry.available()
  } else {
    if (!AgentRegistry.platforms().includes(explicit)) {
      banner('error', 'UNKNOWN PLATFORM', [
        `'${explicit}' is not a registered platform.`,
        `Registered: ${AgentRegistry.platforms().join(', ') || 'none'}`,
      ])
      process.exit(1)
    }
    platformsToRun = [explicit]
  }

  // ── 1. Relay (always local) ───────────────────────────────────────────────
  initConfigFile()
  initDb(path.join(config.server.dataDir, 'tapflow.db'))
  const server = new RelayServer({ port: RELAY_PORT, uploadsDir: path.join(config.server.dataDir, 'uploads'), wsBackpressureBytes: config.server.wsBackpressureBytes })
  await server.start()
  step(`Relay started on ws://localhost:${RELAY_PORT}`)

  // ── 2. Agent availability check ───────────────────────────────────────────
  if (platformsToRun.length === 0) {
    banner('success', 'TAPFLOW RELAY READY', [
      `Relay  : http://localhost:${RELAY_PORT}`,
      'No agent environment detected — running relay only.',
      `Connect a Mac agent:  tapflow agent start --relay ws://<this-ip>:${RELAY_PORT}`,
      'Press Ctrl+C to stop.',
    ])
    process.on('SIGINT', () => process.exit(0))
    return
  }

  const agents: Array<{ disconnect(): void }> = []

  // ── 3. Connect each registered platform ──────────────────────────────────
  for (const platform of platformsToRun) {
    const spinner = createSpinner(`Connecting ${platform} agent…`)
    spinner.start()
    try {
      const agent = await AgentRegistry.connect(platform, relayUrl, { deviceFilter: opts.device })
      spinner.stop(true)
      agents.push(agent)
    } catch (e) {
      spinner.stop(false)
      if (agents.length > 0) {
        console.log(`  ⚠  ${platform}: ${(e as Error).message}`)
      } else {
        banner('error', `${platform.toUpperCase()} CONNECTION FAILED`, [(e as Error).message])
        process.exit(1)
      }
    }
  }

  banner('success', 'TAPFLOW READY', [
    `Relay  : http://localhost:${RELAY_PORT}`,
    `Open http://localhost:${RELAY_PORT} in your browser.`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agents.forEach((a) => a.disconnect())
    process.exit(0)
  })
}
