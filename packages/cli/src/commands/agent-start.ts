import { z } from 'zod'
import { AgentRegistry } from '@tapflowio/agent-core'
import '@tapflowio/ios-agent'
import '@tapflowio/android-agent'
import { banner, createSpinner } from '../lib/print.js'

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

  // ── Connect each registered platform ────────────────────────────────────
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

  banner('success', 'TAPFLOW AGENT READY', [
    `Relay  : ${relayUrl}`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    agents.forEach((a) => a.disconnect())
    process.exit(0)
  })
}
