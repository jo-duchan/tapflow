import { execSync } from 'node:child_process'
import { IOSAgent } from '@tapflow/ios-agent'
import { AndroidAgent } from '@tapflow/android-agent'
import { banner, createSpinner, step } from '../lib/print.js'

export interface AgentStartOptions {
  device?: string
  relay?: string
  platform?: 'ios' | 'android' | 'all'
}

const DEFAULT_RELAY = 'ws://localhost:4000'

function hasAdb(): boolean {
  try {
    return execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim().length > 0
  } catch {
    return false
  }
}

export async function cmdAgentStart(opts: AgentStartOptions): Promise<void> {
  const isMac = process.platform === 'darwin'
  const relayUrl = opts.relay ?? DEFAULT_RELAY

  const explicit = opts.platform
  const runIOS = explicit === 'ios' || explicit === 'all' || (!explicit && isMac)
  const runAndroid = explicit === 'android' || explicit === 'all' || (!explicit && hasAdb())

  if (!runIOS && !runAndroid) {
    banner('error', 'NO PLATFORM AVAILABLE', [
      'No iOS simulator or Android adb found.',
      'Run `tapflow doctor` to diagnose.',
    ])
    process.exit(1)
  }

  const agents: Array<{ disconnect(): void }> = []

  // ── iOS Agent ─────────────────────────────────────────────────────────────
  if (runIOS) {
    const iosAgent = new IOSAgent()
    const devices = await iosAgent.listDevices()

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
      step(`iOS Simulator: ${match.name}`)
    } else {
      const booted = devices.find((d) => d.status === 'booted')
      if (booted) {
        step(`iOS Simulator: ${booted.name}`)
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
        step(`iOS Simulator: ${first.name}`)
      }
    }

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

  // ── Android Agent ─────────────────────────────────────────────────────────
  if (runAndroid) {
    const androidAgent = new AndroidAgent()
    const androidSpinner = createSpinner('Connecting Android agent…')
    androidSpinner.start()
    try {
      await androidAgent.connect(relayUrl)
      androidSpinner.stop(true)
      agents.push(androidAgent)
    } catch (e) {
      androidSpinner.stop(false)
      if (runIOS && agents.length > 0) {
        console.log(`  ⚠  Android: ${(e as Error).message}`)
      } else {
        banner('error', 'ANDROID CONNECTION FAILED', [(e as Error).message])
        process.exit(1)
      }
    }
  }

  banner('success', 'TAPFLOW AGENT READY', [
    `Relay  : ${relayUrl}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agents.forEach((a) => a.disconnect())
    process.exit(0)
  })
}
