import fs from 'fs'
import path from 'path'
import {
  parseFlow,
  runFlow,
  toJUnitXml,
  RelayClient,
  RelayDriver,
  type Flow,
  type FlowResult,
  type DeviceInfo,
} from '@tapflowio/flow-runner'

export interface FlowRunOptions {
  relay?: string
  token?: string
  session?: string
  device?: string
  build?: number
  install?: boolean
  junit?: string
  artifacts?: string
  timeout?: number
}

// Exit codes are part of the CI contract: 0 = all flows passed,
// 1 = at least one flow failed, 2 = environment/config error.
const EXIT_FLOW_FAILED = 1
const EXIT_ENV_ERROR = 2

function envFail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(EXIT_ENV_ERROR)
}

async function resolveSession(client: RelayClient, opts: FlowRunOptions): Promise<{ sessionId: string; device: DeviceInfo }> {
  const sessions = await client.listDevices()
  const devices = sessions.flatMap((s) => s.devices)
  if (devices.length === 0) envFail('no devices registered on the relay — is an agent running?')

  let candidates = devices
  if (opts.session) {
    candidates = devices.filter((d) => d.sessionId === opts.session)
    if (candidates.length === 0) envFail(`session ${opts.session} not found`)
    if (candidates.length > 1) envFail(`session ${opts.session} matches multiple devices — narrow with --device <name>`)
  } else if (opts.device) {
    candidates = devices.filter((d) => d.name === opts.device)
    if (candidates.length === 0) {
      envFail(`device "${opts.device}" not found (available: ${devices.map((d) => d.name).join(', ')})`)
    }
    // The same device name can exist on two agents (two Macs) — never pick one silently.
    if (candidates.length > 1) envFail(`multiple devices named "${opts.device}" — narrow with --session <id> (tapflow status)`)
  } else {
    const booted = devices.filter((d) => d.status === 'booted')
    if (booted.length === 1) {
      candidates = booted
    } else {
      envFail(
        booted.length === 0
          ? 'no booted device — pass --device <name> to boot one, or boot it in the dashboard'
          : `multiple booted devices — pick one with --device <name> or --session <id> (booted: ${booted.map((d) => d.name).join(', ')})`,
      )
    }
  }

  const device = candidates[0]
  if (device.busy) envFail(`device "${device.name}" is busy (another session is active)`)
  return { sessionId: device.sessionId, device }
}

export async function cmdFlowRun(files: string[], opts: FlowRunOptions): Promise<void> {
  if (files.length === 0) envFail('no flow files given — usage: tapflow flow run .tapflow/flows/*.yaml')
  // NaN would disable every deadline check in the engine (Date.now() >= NaN is
  // always false) and hang the run — reject bad numeric flags up front.
  if (opts.build !== undefined && !Number.isInteger(opts.build)) envFail('--build must be an integer build id (see list_builds / the dashboard)')
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) envFail('--timeout must be a positive number of seconds')

  // Parse everything up front: a schema error is a config problem (exit 2),
  // not a test failure, and it should surface before touching any device.
  const flows: Flow[] = []
  for (const file of files) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch (e) {
      envFail(`cannot read ${file}: ${(e as Error).message}`)
    }
    try {
      flows.push(parseFlow(text, file))
    } catch (e) {
      envFail((e as Error).message)
    }
  }

  const relayUrl = opts.relay ?? 'ws://localhost:4000'
  const token = opts.token ?? process.env.TAPFLOW_TOKEN ?? ''
  const client = new RelayClient(relayUrl, token)
  try {
    await client.connect()
  } catch (e) {
    envFail(`cannot connect to relay at ${relayUrl}: ${(e as Error).message}`)
  }

  let exitCode = 0
  try {
    const { sessionId, device } = await resolveSession(client, opts)
    await client.joinSession(sessionId)

    // Always send device:boot — it is idempotent on a booted device and it is
    // what initializes the agent's touch/stream state for this session (the
    // dashboard does the same on join).
    console.log(`preparing ${device.name}...`)
    await client.bootDevice(sessionId, device.id)
    if (opts.build !== undefined && opts.install !== false) {
      console.log(`installing build ${opts.build}...`)
      await client.installApp(sessionId, opts.build)
    }

    const driver = new RelayDriver(client, sessionId, opts.build)
    const engineOpts = opts.timeout !== undefined ? { defaultTimeoutMs: opts.timeout * 1000 } : {}
    const results: FlowResult[] = []

    for (const [flowIndex, flow] of flows.entries()) {
      process.stdout.write(`▶ ${flow.name} `)
      const result = await runFlow(flow, driver, engineOpts)
      results.push(result)
      console.log(result.status === 'passed' ? `✓ (${(result.durationMs / 1000).toFixed(1)}s)` : '✗')
      if (result.status === 'failed') {
        console.error(`  ${result.failureMessage}`)
        if (result.failureScreenshot) {
          // Runtime data belongs in the gitignored .tapflow/artifacts/, and the
          // index prefix keeps same-named flows from different directories
          // from overwriting each other's evidence.
          const dir = opts.artifacts ?? path.join('.tapflow', 'artifacts')
          fs.mkdirSync(dir, { recursive: true })
          const shot = path.join(dir, `${String(flowIndex + 1).padStart(2, '0')}-${flow.name.replace(/[^\w.-]+/g, '_')}-failure.png`)
          fs.writeFileSync(shot, result.failureScreenshot)
          console.error(`  screenshot: ${shot}`)
        }
      }
    }

    if (opts.junit) {
      fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true })
      fs.writeFileSync(opts.junit, toJUnitXml(results))
      console.log(`JUnit report: ${opts.junit}`)
    }

    const failed = results.filter((r) => r.status === 'failed').length
    console.log(`\n${results.length - failed}/${results.length} flows passed`)
    if (failed > 0) exitCode = EXIT_FLOW_FAILED

    client.leaveSession(sessionId)
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`)
    exitCode = EXIT_ENV_ERROR
  } finally {
    client.disconnect()
  }
  process.exit(exitCode)
}
