import { execSync } from 'node:child_process'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent } from '@tapflow/ios-agent'
import { banner, createSpinner, step } from '../lib/print.js'

export interface StartOptions {
  device?: string
  relay?: string
}

export async function cmdStart(opts: StartOptions): Promise<void> {
  const relayUrl = opts.relay ?? 'ws://localhost:3000'

  // ── 1. Relay ──────────────────────────────────────────────────────────────
  if (!opts.relay) {
    const server = new RelayServer({ port: 3000 })
    await server.start()
    step('Relay started on ws://localhost:3000')
  }

  // ── 2. Device ─────────────────────────────────────────────────────────────
  const agent = new IOSAgent()
  const devices = await agent.listDevices()

  if (opts.device) {
    const match = devices.find((d) => d.name === opts.device || d.id === opts.device)
    if (!match) {
      banner('error', 'DEVICE NOT FOUND', [
        `"${opts.device}" does not match any simulator.`,
        'Run `tapflow devices` to see available simulators.',
      ])
      process.exit(1)
    }
    if (match.status !== 'booted') {
      const spinner = createSpinner(`Booting ${match.name}…`)
      spinner.start()
      execSync(`xcrun simctl boot ${match.id}`, { stdio: 'pipe' })
      spinner.stop(true)
    }
    step(`Simulator: ${match.name}`)
  } else {
    const booted = devices.find((d) => d.status === 'booted')
    if (booted) {
      step(`Simulator: ${booted.name}`)
    } else {
      const first = devices[0]
      if (!first) {
        banner('error', 'NO SIMULATOR FOUND', ['Create one in Xcode → Window → Devices and Simulators.'])
        process.exit(1)
      }
      const spinner = createSpinner(`Booting ${first.name}…`)
      spinner.start()
      execSync(`xcrun simctl boot ${first.id}`, { stdio: 'pipe' })
      spinner.stop(true)
      step(`Simulator: ${first.name}`)
    }
  }

  // ── 3. Connect agent ──────────────────────────────────────────────────────
  const connectSpinner = createSpinner('Connecting agent to relay…')
  connectSpinner.start()
  try {
    await agent.connect(relayUrl)
    connectSpinner.stop(true)
  } catch (e) {
    connectSpinner.stop(false)
    banner('error', 'CONNECTION FAILED', [(e as Error).message])
    process.exit(1)
  }

  banner('success', 'AGENT CONNECTED', [
    `Relay  : ${relayUrl}`,
    'Open http://localhost:3000 in your browser.',
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agent.disconnect()
    process.exit(0)
  })
}
