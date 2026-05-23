import { RelayServer, initDb, config } from '@tapflowio/relay'
import { AgentRegistry } from '@tapflowio/agent-core'
import path from 'path'
import { AndroidAgent } from '@tapflowio/android-agent'
import { banner, createSpinner, step } from '../lib/print.js'
import { resolveAndBootIOSDevice } from '../lib/ios-boot.js'
import { initConfigFile } from '../lib/init-config.js'

export interface StartOptions {
  device?: string
  platform?: string
}

const RELAY_PORT = 4000

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

  // ── 3. iOS Agent ──────────────────────────────────────────────────────────
  if (platformsToRun.includes('ios')) {
    const iosAgent = await resolveAndBootIOSDevice(opts.device)
    const iosSpinner = createSpinner('Connecting iOS agent…')
    iosSpinner.start()
    try {
      await iosAgent.connect(relayUrl)
      iosSpinner.stop(true)
      agents.push(iosAgent)
    } catch (e) {
      iosSpinner.stop(false)
      banner('error', 'IOS CONNECTION FAILED', [(e as Error).message])
      process.exit(1)
    }
  }

  // ── 4. Android Agent ──────────────────────────────────────────────────────
  if (platformsToRun.includes('android')) {
    const androidAgent = new AndroidAgent({ deviceFilter: opts.device })
    const androidSpinner = createSpinner('Connecting Android agent…')
    androidSpinner.start()
    try {
      await androidAgent.connect(relayUrl)
      androidSpinner.stop(true)
      agents.push(androidAgent)
    } catch (e) {
      androidSpinner.stop(false)
      if (platformsToRun.includes('ios') && agents.length > 0) {
        console.log(`  ⚠  Android: ${(e as Error).message}`)
      } else {
        banner('error', 'ANDROID CONNECTION FAILED', [(e as Error).message])
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
