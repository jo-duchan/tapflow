import { z } from 'zod'
import { AgentRegistry } from '@tapflowio/agent-core'
import { config, assertInstallDir } from '@tapflowio/relay'
import { requestAudioPermission, isAudioSupported } from '@tapflowio/ios-agent'
import '@tapflowio/android-agent'
import { banner, createSpinner } from '../lib/print.js'
import { claimAgentSlot, claimPath } from '../lib/agent-singleton.js'

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
  assertInstallDir()
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

  // Prime the audio-capture permission (audio is on by default) — shared by iOS capture and Android
  // host-mute (#341), both via the same signed helper / TCC grant. Non-blocking: if the grant already
  // exists the helper exits silently; otherwise the operator gets the one-time modal. Re-run
  // `tapflow agent start` to retry if audio is silent. See contributing/simulator-audio.md.
  if ((platformsToRun.includes('ios') || platformsToRun.includes('android')) &&
      process.env.TAPFLOW_AUDIO !== 'off' && isAudioSupported()) {
    requestAudioPermission(false)
  }

  const agents: Array<{ disconnect(): void }> = []
  const claims = new Map<string, () => void>()

  // **One agent per Mac, per platform, and the refusal is the feature.**
  //
  // Two agents on one Mac enumerate the same simulators and write the same host-wide filter rule, so
  // the second one starting used to put every device the first had taken offline back online. The
  // relay already treats this as one agent — identity there is `IOPlatformUUID` + platform, and a
  // second registration evicts the first's socket — so the configuration was never supported. It just
  // failed at the filter, silently, instead of here with a sentence.
  for (const platform of platformsToRun) {
    const claim = await claimAgentSlot(platform)
    if (!claim.held) {
      // **One banner, chosen by the reason.** Printing the running-agent one first and then adding
      // the stale case after it said something false in the case that is hardest to diagnose: the
      // probe found no listener, so no agent is running, and being told one is sends the reader
      // hunting for a process that does not exist.
      if (claim.reason === 'stale-claim') {
        banner('error', 'CLAIM LEFT BY ANOTHER ACCOUNT', [
          `No tapflow ${platform} agent is running, but a claim on this Mac was left by a different`,
          `macOS account and cannot be cleared from here. Remove ${claimPath(platform)} as that`,
          'user, or from an account that can.',
        ])
      } else {
        banner('error', 'AGENT ALREADY RUNNING', [
          `A tapflow ${platform} agent is already running on this Mac.`,
          'One agent per platform manages every simulator here, so a second one would fight it for',
          'the network filter and the device list. Stop the other one, or use the session it already',
          'serves.',
        ])
      }
      for (const release of claims.values()) release()
      process.exit(1)
    }
    claims.set(platform, claim.release)
  }

  // ── Connect each registered platform ────────────────────────────────────
  for (const platform of platformsToRun) {
    const spinner = createSpinner(`Connecting ${platform} agent…`)
    spinner.start()
    try {
      const agent = await AgentRegistry.connect(platform, relayUrl, { deviceFilter: opts.device, token, lean: config.agent.lean })
      spinner.stop(true)
      agents.push(agent)
    } catch (e) {
      spinner.stop(false)
      const message = (e as Error).message
      // 릴레이의 1008 인증 거절(#271) — 사유만으로는 다음 행동을 모르니 발급 절차를 안내한다.
      // Only for the "no agent credential" refusal (or a relay that gave no reason): the other 1008s
      // carry their own instruction in the message — a demoted owner, a token without the right scope —
      // and "create a PAT with the agent scope" would send the operator to fix the wrong thing.
      const authHint = /code=1008(: Unauthorized: agents need a PAT|\))/.test(message)
        ? [
            'Remote relays require a PAT with the agent scope.',
            'Create one in Dashboard → Settings → Tokens,',
            'then pass it with --token (or TAPFLOW_AGENT_TOKEN).',
          ]
        : []
      if (agents.length > 0) {
        // **The claim goes back when the platform it was taken for did not start.** Holding it while
        // this process runs on for another platform makes the next `agent start --platform <this>`
        // refuse for an agent that does not exist.
        claims.get(platform)?.()
        claims.delete(platform)
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
