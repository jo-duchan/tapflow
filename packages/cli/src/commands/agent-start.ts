import { z } from 'zod'
import { AgentRegistry } from '@tapflowio/agent-core'
import { AndroidAgent } from '@tapflowio/android-agent'
import { banner, createSpinner } from '../lib/print.js'
import { resolveAndBootIOSDevice } from '../lib/ios-boot.js'

export interface AgentStartOptions {
  device?: string
  relay?: string
  platform?: string
}

const DEFAULT_RELAY = 'ws://localhost:4000'

const relayUrlSchema = z
  .string()
  .refine((v) => v.startsWith('ws://') || v.startsWith('wss://'), {
    message: '--relay must start with ws:// or wss://',
  })

export async function cmdAgentStart(opts: AgentStartOptions): Promise<void> {
  const rawRelay = opts.relay ?? DEFAULT_RELAY
  const relayResult = relayUrlSchema.safeParse(rawRelay)
  if (!relayResult.success) {
    banner('error', 'INVALID CONFIG', [relayResult.error.issues[0].message])
    process.exit(1)
  }
  const relayUrl = relayResult.data

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

  if (platformsToRun.length === 0) {
    banner('error', 'NO PLATFORM AVAILABLE', [
      'No iOS simulator or Android adb found.',
      'Run `tapflow doctor` to diagnose.',
    ])
    process.exit(1)
  }

  const agents: Array<{ disconnect(): void }> = []

  // ── iOS Agent ─────────────────────────────────────────────────────────────
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

  // ── Android Agent ─────────────────────────────────────────────────────────
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

  banner('success', 'TAPFLOW AGENT READY', [
    `Relay  : ${relayUrl}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agents.forEach((a) => a.disconnect())
    process.exit(0)
  })
}
