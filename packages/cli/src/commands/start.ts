import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent, WdaLauncher, WdaNotInstalledError } from '@tapflow/ios-agent'
import { WDA_XCTESTRUN_CACHE } from '../lib/tapflow-dir'
import { banner, createSpinner, step } from '../lib/print'

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

  let targetId: string
  let targetName: string

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
    targetId = match.id
    targetName = match.name
  } else {
    const booted = devices.find((d) => d.status === 'booted')
    if (booted) {
      targetId = booted.id
      targetName = booted.name
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
      targetId = first.id
      targetName = first.name
    }
  }

  step(`Simulator: ${targetName}`)

  // ── 3. WDA ────────────────────────────────────────────────────────────────
  let launcher: WdaLauncher | null = null
  if (existsSync(WDA_XCTESTRUN_CACHE)) {
    launcher = new WdaLauncher({ udid: targetId, xctestrunPath: WDA_XCTESTRUN_CACHE })
    const spinner = createSpinner('Starting WebDriverAgent…')
    spinner.start()
    try {
      await launcher.ensureRunning()
      spinner.stop(true)
    } catch (e) {
      spinner.stop(false)
      if (e instanceof WdaNotInstalledError) {
        console.log('\n  WDA not found — touch input disabled. Run `tapflow wda install` to enable.\n')
        launcher = null
      } else {
        banner('error', 'WDA FAILED TO START', [(e as Error).message])
        console.log('  Continuing without WDA — touch input will not work.\n')
        launcher = null
      }
    }
  } else {
    console.log('\n  WebDriverAgent not installed — touch input disabled.')
    console.log('  Run `tapflow wda install` to enable it.\n')
  }

  // ── 4. Connect agent ──────────────────────────────────────────────────────
  const connectSpinner = createSpinner('Connecting agent to relay…')
  connectSpinner.start()
  try {
    // autoStart is false — WDA is already handled above
    await agent.connect(relayUrl)
    connectSpinner.stop(true)
  } catch (e) {
    connectSpinner.stop(false)
    banner('error', 'CONNECTION FAILED', [(e as Error).message])
    launcher?.stop()
    process.exit(1)
  }

  banner('success', 'AGENT CONNECTED', [
    `Relay  : ${relayUrl}`,
    'Open http://localhost:3000 in your browser.',
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agent.disconnect()
    launcher?.stop()
    process.exit(0)
  })
}
