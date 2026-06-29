import { RelayServer, initDb, config, createCertProvider, startTlsBackgroundTasks, buildCorsOrigins, proxyWithoutPublicUrlWarning } from '@tapflowio/relay'
import { AgentRegistry } from '@tapflowio/agent-core'
import fs from 'fs'
import path from 'path'
import { requestAudioPermission, isAudioSupported } from '@tapflowio/ios-agent'
import '@tapflowio/android-agent'
import { banner, createSpinner, step, warn } from '../lib/print.js'
import { startConfiguredTunnel } from '../lib/tunnel-runner.js'
import type { TunnelPlugin } from '../lib/tunnel.js'

export interface StartOptions {
  device?: string
  platform?: string
}

const RELAY_PORT = config.local.port

export async function cmdStart(opts: StartOptions): Promise<void> {
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

  // Prime the audio-capture permission (audio is on by default) — shared by iOS capture and Android
  // host-mute (#341), both via the same signed helper / TCC grant. Non-blocking: if the grant already
  // exists the helper exits silently; otherwise the operator gets the one-time modal.
  if ((platformsToRun.includes('ios') || platformsToRun.includes('android')) &&
      process.env.TAPFLOW_AUDIO !== 'off' && isAudioSupported()) {
    requestAudioPermission(false)
  }

  // ── 1. Relay (always local) ───────────────────────────────────────────────
  if (!fs.existsSync(path.join(process.cwd(), 'tapflow.config.json'))) {
    warn('tapflow.config.json not found — using defaults. Run tapflow init to configure.')
  }
  initDb(path.join(config.local.dataDir, 'tapflow.db'))

  // LAN HTTPS for the secure-context (Smooth/WebCodecs) path — same wiring as `tapflow relay start`.
  let tls: { cert: string; key: string } | undefined
  let certProvider: ReturnType<typeof createCertProvider> | null = null
  if (config.tls) {
    certProvider = createCertProvider(config.tls, { dataDir: config.local.dataDir })
    const material = await certProvider.ensureCert()
    tls = { cert: material.cert, key: material.key }
  }
  const httpScheme = tls ? 'https' : 'http'
  const wsScheme = tls ? 'wss' : 'ws'
  // A domain-bound cert won't validate against localhost, so advertise the cert's domain to teammates.
  const displayHost = config.tls?.mode === 'byo-api-token' ? config.tls.domain : 'localhost'
  // The co-located agent connects over localhost; the agent accepts the domain cert there (see isLocalhostWss).
  const relayUrl = `${wsScheme}://localhost:${RELAY_PORT}`

  const proxyWarning = proxyWithoutPublicUrlWarning(config)
  if (proxyWarning) warn(proxyWarning)
  const server = new RelayServer({ port: RELAY_PORT, uploadsDir: path.join(config.local.dataDir, 'uploads'), wsBackpressureBytes: config.local.wsBackpressureBytes, trustedProxies: config.local.trustedProxies, corsOrigins: buildCorsOrigins(config, RELAY_PORT), tls })
  await server.start()
  const stopTls = certProvider ? startTlsBackgroundTasks(certProvider, server, config.tls) : null
  step(`Relay started on ${httpScheme}://${displayHost}:${RELAY_PORT}`)

  // ── 2. Tunnel (optional — publishes a public URL for teammates) ────────────
  let tunnel: TunnelPlugin | null = null
  let publicUrl: string | null = null
  if (config.tunnel) {
    const started = await startConfiguredTunnel(config.tunnel, RELAY_PORT)
    tunnel = started.tunnel
    publicUrl = started.publicUrl
  }

  // ── 3. Agent availability check ───────────────────────────────────────────
  if (platformsToRun.length === 0) {
    banner('success', 'TAPFLOW RELAY READY', [
      `Relay  : ${httpScheme}://${displayHost}:${RELAY_PORT}`,
      ...(publicUrl ? [`Public : ${publicUrl}`] : []),
      'No agent environment detected — running relay only.',
      `Connect a Mac agent:  tapflow agent start --relay ${wsScheme}://<this-ip>:${RELAY_PORT} --token <agent-PAT>`,
      `  Issue an 'agent'-scope token in the dashboard (Settings → Tokens).`,
      'Press Ctrl+C to stop.',
    ])
    process.on('SIGINT', () => { stopTls?.(); void tunnel?.stop(); process.exit(0) })
    return
  }

  const agents: Array<{ disconnect(): void }> = []

  // ── 4. Connect each registered platform ──────────────────────────────────
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
    `Relay  : ${httpScheme}://${displayHost}:${RELAY_PORT}`,
    ...(publicUrl ? [`Public : ${publicUrl}`] : []),
    `Open ${publicUrl ?? `${httpScheme}://${displayHost}:${RELAY_PORT}`} in your browser.`,
    'Press Ctrl+C to stop.',
  ])

  process.on('SIGINT', () => {
    stopTls?.()
    agents.forEach((a) => a.disconnect())
    void tunnel?.stop()
    process.exit(0)
  })
}
