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
import { ciContext, runningInCI } from '../lib/ci.js'
import { RunRecorder, type FlowReport } from '../lib/runRecorder.js'

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
  /** `--no-record` sets it false. */
  record?: boolean
}

// Exit codes are part of the CI contract: 0 = all flows passed,
// 1 = at least one flow failed, 2 = environment/config error,
// 130 / 143 = cancelled by SIGINT / SIGTERM (128 + the signal, what a shell reports for a process the signal killed).
const EXIT_FLOW_FAILED = 1
const EXIT_ENV_ERROR = 2
const EXIT_ON_SIGNAL: Record<'SIGINT' | 'SIGTERM', number> = { SIGINT: 130, SIGTERM: 143 }
/** How long the end of a run waits for its record to reach the relay. */
const RECORD_DRAIN_MS = 10_000
/** Shorter on a cancel: CI sends SIGTERM and kills a few seconds later. */
const RECORD_DRAIN_ON_SIGNAL_MS = 5_000
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000

class FlowRunEnvironmentError extends Error {}

function envFail(message: string): never {
  throw new FlowRunEnvironmentError(message)
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
    if (candidates.length > 1) envFail(`multiple devices named "${opts.device}" — narrow with --session <id> (the MCP server's list_devices shows each device's session id)`)
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

function flowReport(result: FlowResult, device: DeviceInfo): FlowReport {
  return {
    status: result.status,
    durationMs: result.durationMs,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
    steps: result.steps.map((st) => ({
      index: st.index, name: st.name, status: st.status, durationMs: st.durationMs,
      ...(st.message ? { message: st.message } : {}),
    })),
    device: { id: device.id, name: device.name, platform: device.platform },
  }
}

export async function cmdFlowRun(files: string[], opts: FlowRunOptions): Promise<void> {
  let client: RelayClient | undefined
  let recorder: RunRecorder | undefined
  let exitCode = 0
  let joinedSessionId: string | undefined
  let sawProductFailure = false
  let errorMessage: string | undefined

  // A cancelled run still leaves the session and says so in its record, then exits as the signal would have.
  // A second signal does not wait for any of that.
  let cancelling = false
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    const code = EXIT_ON_SIGNAL[signal]
    if (cancelling) process.exit(code)
    cancelling = true
    console.error(`\n✗ cancelled (${signal})`)
    recorder?.finish({ status: 'aborted', exitCode: code, errorMessage: `cancelled (${signal})` })
    void (recorder?.drain(RECORD_DRAIN_ON_SIGNAL_MS) ?? Promise.resolve(null)).finally(() => {
      try {
        if (client && joinedSessionId !== undefined) client.leaveSession(joinedSessionId)
      } catch { /* leaving is best effort on the way out */ }
      client?.disconnect()
      process.exit(code)
    })
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    if (files.length === 0) envFail('no flow files given — usage: tapflow flow run .tapflow/flows/*.yaml')
    // NaN would disable every deadline check in the engine (Date.now() >= NaN is
    // always false) and hang the run — reject bad numeric flags up front.
    if (opts.build !== undefined && !Number.isInteger(opts.build)) envFail('--build must be an integer build id (see list_builds / the dashboard)')
    if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0 && opts.timeout <= MAX_TIMEOUT_SECONDS)) {
      envFail(`--timeout must be a positive number of seconds no greater than ${MAX_TIMEOUT_SECONDS}`)
    }

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
    client = new RelayClient(relayUrl, token)
    try {
      await client.connect()
    } catch (e) {
      envFail(`cannot connect to relay at ${relayUrl}: ${(e as Error).message}`)
    }

    // Created now, before a device is chosen, so a run that fails to find, boot or install one is recorded too —
    // the failures the runs page exists to tell apart from a regression.
    if (opts.record === false) {
      // Asked for: nothing to say.
    } else if (!token) {
      // REST has no loopback exemption, so without a token there is nothing to record with.
      console.error('run not recorded: no token (pass --token or set TAPFLOW_TOKEN to record runs on the relay)')
    } else {
      recorder = new RunRecorder(relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http')), token, {
        fetch: globalThis.fetch,
        warn: (line) => console.error(line),
      })
      recorder.create({
        client: client.clientId,
        ...(opts.build !== undefined ? { buildId: opts.build } : {}),
        flows: flows.map((f, i) => ({ name: f.name, file: files[i] })),
        ci: ciContext(),
      })
    }

    const { sessionId, device } = await resolveSession(client, opts)
    const { watchUrl } = await client.joinSession(sessionId)
    joinedSessionId = sessionId
    // Whoever started the run can watch it live from here. **Not in CI**: the link is the relay's address
    // rewritten (`wss://host` → `https://host/…`), so a secret holding the relay URL does not mask it, and a
    // public repository's log would show the host the docs keep in a secret.
    if (!runningInCI()) console.log(`watch this run: ${watchUrl}`)

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
    const engineOpts = opts.timeout !== undefined ? { defaultTimeoutMs: Math.round(opts.timeout * 1000) } : {}
    const results: FlowResult[] = []

    for (const [flowIndex, flow] of flows.entries()) {
      process.stdout.write(`▶ ${flow.name} `)
      const result = await runFlow(flow, driver, engineOpts)
      results.push(result)
      recorder?.reportFlow(flowIndex, flowReport(result, device), result.failureScreenshot)
      if (result.status === 'failed' && result.failureKind !== 'environment') sawProductFailure = true
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

    const failed = results.filter((r) => r.status === 'failed')
    console.log(`\n${results.length - failed.length}/${results.length} flows passed`)
    // All failed flows environmental → exit 2 (infrastructure, not a regression). Any
    // product failure keeps exit 1, so a real regression is never masked by a blip.
    if (failed.length > 0) {
      exitCode = failed.every((r) => (r.failureKind ?? 'product') === 'environment')
        ? EXIT_ENV_ERROR
        : EXIT_FLOW_FAILED
    }

  } catch (e) {
    errorMessage = (e as Error).message
    console.error(`✗ ${errorMessage}`)
    if (exitCode === 0) exitCode = sawProductFailure ? EXIT_FLOW_FAILED : EXIT_ENV_ERROR
  } finally {
    if (client && joinedSessionId !== undefined) {
      try {
        client.leaveSession(joinedSessionId)
      } catch (e) {
        console.error(`✗ could not leave session cleanly: ${(e as Error).message}`)
        if (exitCode === 0) exitCode = sawProductFailure ? EXIT_FLOW_FAILED : EXIT_ENV_ERROR
      }
    }
    // After the exit code is settled, and it never sets one. Before `disconnect`: the relay closes a run whose
    // runner's socket goes, and a record finished first is the runner's own account rather than the relay's guess.
    if (recorder && !cancelling) {
      recorder.finish({
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        ...(exitCode === EXIT_ENV_ERROR ? { failureKind: 'environment' } : exitCode === EXIT_FLOW_FAILED ? { failureKind: 'product' } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      })
      const runId = await recorder.drain(RECORD_DRAIN_MS)
      if (runId) console.log(`recorded as run ${runId}`)
    }
    if (!cancelling) client?.disconnect()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  if (!cancelling) process.exitCode = exitCode
}
