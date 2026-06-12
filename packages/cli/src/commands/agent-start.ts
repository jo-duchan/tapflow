import { z } from 'zod'
import { AgentRegistry } from '@tapflowio/agent-core'
import { config } from '@tapflowio/relay'
import '@tapflowio/ios-agent'
import '@tapflowio/android-agent'
import { banner, createSpinner } from '../lib/print.js'

export interface AgentStartOptions {
  device?: string
  relay?: string
  platform?: string
  token?: string
}

const DEFAULT_RELAY = config.relay.url ?? `ws://localhost:${config.local.port}`

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
  // 원격 릴레이 인증용 PAT (#271). 플래그가 환경변수보다 우선. localhost는 불필요.
  const token = opts.token ?? process.env.TAPFLOW_AGENT_TOKEN

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
      const agent = await AgentRegistry.connect(platform, relayUrl, { deviceFilter: opts.device, token })
      spinner.stop(true)
      agents.push(agent)
    } catch (e) {
      spinner.stop(false)
      const message = (e as Error).message
      // 릴레이의 1008 인증 거절(#271) — 사유만으로는 다음 행동을 모르니 발급 절차를 안내한다
      const authHint = message.includes('code=1008')
        ? [
            'Remote relays require a PAT with the agent scope.',
            'Create one in Dashboard → Settings → Tokens,',
            'then pass it with --token (or TAPFLOW_AGENT_TOKEN).',
          ]
        : []
      if (agents.length > 0) {
        console.log(`  ⚠  ${platform}: ${message}`)
      } else {
        banner('error', `${platform.toUpperCase()} CONNECTION FAILED`, [message, ...authHint])
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
