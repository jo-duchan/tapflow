import fs from 'fs'
import path from 'path'
import {
  parseFlow,
  runFlow,
  toJUnitXml,
  toJUnitXmlSuites,
  RelayClient,
  RelayDriver,
  VideoTap,
  resolveToken,
  tokenRefusal,
  isEligible,
  lookupBuild,
  refusedFlow,
  unavailableButton,
  unavailableButtonMessage,
  parseTagList,
  retryAdmission,
  admissionRefusalOf,
  leasedSessionOf,
  parseServiceTier,
  type AdmissionReason,
  type BootOutcome,
  type ServiceTier,
  type EligibilityTarget,
  type SkippedFlow,
  type Flow,
  type FlowResult,
  type EngineOptions,
  type DeviceInfo,
  type JUnitSuite,
  type Lease,
} from '@tapflowio/flow-runner'
import { ciContext, runningInCI } from '../lib/ci.js'
import { RESETTABLE_APP_ID } from '@tapflowio/agent-core/utils'
import { RunRecorder, type FlowReport } from '../lib/runRecorder.js'
import { VideoLane } from '../lib/videoLane.js'

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
  /** How long to wait for a Mac that is busy booting another device, in seconds. */
  admissionTimeout?: number
  /** The services the device boots with (`stock`, `lean`, `slim`), and the features kept on under it. */
  serviceTier?: string
  keep?: string
  /** `--no-record` sets it false. */
  record?: boolean
  /** `--no-reset` sets it false. */
  reset?: boolean
  /** Comma-separated, as typed. */
  includeTags?: string
  excludeTags?: string
  /** Share the flows across this many devices the relay chooses (`device:lease`). */
  parallel?: number
  /** The platform of a `--parallel` run without `--build`; with one, the relay reads the build's. */
  platform?: string
}

// Exit codes are part of the CI contract: 0 = all flows passed,
// 1 = at least one flow failed, 2 = environment/config error,
// 130 / 143 = cancelled by SIGINT / SIGTERM (128 + the signal, what a shell reports for a process the signal killed).
const EXIT_FLOW_FAILED = 1
const EXIT_ENV_ERROR = 2
const EXIT_ON_SIGNAL: Record<'SIGINT' | 'SIGTERM', number> = { SIGINT: 130, SIGTERM: 143 }
/** How long the end of a run waits for its record to reach the relay. */
const RECORD_DRAIN_MS = 10_000
/** Shorter on a cancel: CI kills soon after. GitHub Actions sends SIGINT, then SIGTERM 7.5 s later, then SIGKILL. */
const RECORD_DRAIN_ON_SIGNAL_MS = 5_000
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000
/**
 * How long a run waits on a Mac that is busy before giving up with exit 2. One boot holds a Mac for 30–90 s, and a
 * person's boot goes ahead of a run's, so ten minutes covers a queue of several without letting a stuck Mac hold a
 * CI job for its whole budget.
 */
const DEFAULT_ADMISSION_TIMEOUT_SECONDS = 600
/** A ceiling on `--parallel`, so a typo cannot ask a relay for a hundred devices. */
const MAX_PARALLEL = 16

/** What the run is waiting for, as the log line says it. */
const ADMISSION_WAITS: Record<AdmissionReason, string> = {
  'host-booting': 'another device is booting on this Mac',
  'host-memory-critical': 'this Mac is critically short of memory',
  'host-at-capacity': 'every automation device this Mac allows is in use',
  'agent-resources-exhausted': 'the Mac is over its CPU or memory limit',
  'all-held': 'every device of this platform is in use',
  'unrecognised-refusal': 'the relay is holding boots on this Mac',
}

class FlowRunEnvironmentError extends Error {}

/** What the argument parser hands back for `--include-tags` / `--exclude-tags`. */
export type TagsArg = string | number | boolean | (string | number | boolean)[]

/**
 * The parser turns a value that reads as a number into one, `''` included (`0`), gives `true` for a flag with no
 * value, and an array for a repeated flag. An empty or missing value is no filter — `--include-tags "$TAGS"` with
 * `$TAGS` unset must not filter on a tag called `0` and skip every flow. The cost is that a tag named `0` cannot be
 * given on the command line.
 */
export function tagsArg(value: TagsArg | undefined): string | undefined {
  if (value === undefined) return undefined
  const one = (v: string | number | boolean) => (v === 0 || v === true ? '' : String(v))
  return Array.isArray(value) ? value.map(one).join(',') : one(value)
}

function httpBaseOf(relayUrl: string): string {
  return relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
}

function writeJUnit(file: string, xml: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, xml)
}

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

/** The relay's limits on a run reset's app ids (protocol's boot schema). */
const MAX_RESET_APPS = 32
const MAX_RESET_APP_ID = 255

/**
 * What to reset before the run. The build it installs is uninstalled first, which takes its data, App Group containers,
 * notification settings and privacy grants with it; an app it runs but does not install has its files cleared. A build
 * the relay would not describe (no `builds:write`) is not known by its id, so its flows' `appId` are cleared instead.
 */
function runResetFor(opts: FlowRunOptions, target: EligibilityTarget, flows: Flow[]): { uninstall: string[]; clear: string[] } {
  const bundleId = target.build?.bundleId ?? undefined
  const installs = opts.build !== undefined && opts.install !== false
  const uninstall = installs && bundleId ? [bundleId] : []
  const used = [...(bundleId && !installs ? [bundleId] : []), ...flows.flatMap((f) => (f.appId ? [f.appId] : []))]
  const clear = [...new Set(used)].filter((id) => !uninstall.includes(id))
  // Checked here against the rules the relay and agent apply, so a request they would drop whole is named instead of
  // turning into "the agent predates run resets".
  const bad = clear.filter((id) => !RESETTABLE_APP_ID.test(id) || id.length > MAX_RESET_APP_ID)
  if (bad.length > 0) console.error(`not reset, not an app id: ${bad.map((id) => JSON.stringify(id)).join(', ')}`)
  const ok = clear.filter((id) => !bad.includes(id))
  if (ok.length > MAX_RESET_APPS) console.error(`not reset: ${ok.length - MAX_RESET_APPS} apps past the first ${MAX_RESET_APPS} the flows name`)
  return { uninstall, clear: ok.slice(0, MAX_RESET_APPS) }
}

/** What a failed flow left: its message, the lines to try instead (B2), and its screenshot written to the artifacts. */
function printFailure(result: FlowResult, flow: Flow, flowIndex: number, opts: FlowRunOptions, prefix = ''): void {
  console.error(`${prefix}  ${result.failureMessage}`)
  // Lines that tap an element on the screen it failed on (B2): a misspelled or ambiguous tapOn's likely fix.
  for (const s of result.steps.find((st) => st.status === 'failed')?.suggestions ?? []) console.error(`${prefix}  try: ${s.yaml}`)
  if (result.failureScreenshot) {
    // Runtime data belongs in the gitignored .tapflow/artifacts/, and the
    // index prefix keeps same-named flows from different directories
    // from overwriting each other's evidence.
    const dir = opts.artifacts ?? path.join('.tapflow', 'artifacts')
    fs.mkdirSync(dir, { recursive: true })
    const shot = path.join(dir, `${String(flowIndex + 1).padStart(2, '0')}-${flow.name.replace(/[^\w.-]+/g, '_')}-failure.png`)
    fs.writeFileSync(shot, result.failureScreenshot)
    console.error(`${prefix}  screenshot: ${shot}`)
  }
}

/** What a run's boot reset, said once per device. */
function printReset(report: BootOutcome['runReset'], deviceName: string, prefix = ''): void {
  if (!report) {
    console.error(`${prefix}device not reset: the agent or the relay predates run resets — update both, or pass --no-reset`)
    return
  }
  console.log(report.done.length > 0 ? `${prefix}reset on ${deviceName}: ${report.done.join(', ')}` : `${prefix}nothing reset on ${deviceName}: no app to clear, and nothing this device resets`)
  if (report.failed.length > 0) console.error(`${prefix}reset failed: ${report.failed.join(', ')} — the run goes on, and these may hold what an earlier run left`)
}

function flowReport(result: FlowResult, device?: DeviceInfo): FlowReport {
  return {
    status: result.status,
    durationMs: result.durationMs,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
    steps: result.steps.map((st) => ({
      index: st.index, name: st.name, status: st.status, durationMs: st.durationMs,
      ...(st.message ? { message: st.message } : {}),
      ...(st.suggestions ? { suggestions: st.suggestions } : {}),
    })),
    // A flow refused before a device was chosen ran on none.
    ...(device ? { device: { id: device.id, name: device.name, platform: device.platform } } : {}),
  }
}

/** A device a `--parallel` run holds: its own socket, under the run's client id, and its own cut of the stream. */
interface Worker {
  client: RelayClient
  tap?: VideoTap
  /** Set while it holds a device, so a cancel can let the device go. */
  sessionId?: string
}

interface ParallelRun {
  relayUrl: string
  tokens: ReturnType<typeof resolveToken>
  /** The main connection's: every worker holds its device as the same client, so the relay sees one run. */
  clientId: string
  opts: FlowRunOptions
  flows: Flow[]
  eligible: number[]
  serviceTier?: ServiceTier
  runReset?: { uninstall: string[]; clear: string[] }
  admissionTimeoutMs: number
  recorder?: RunRecorder
  lane?: VideoLane
  workers: Worker[]
  cancelled: () => boolean
  onLease: (lease: Lease) => void
}

/** What the workers did: each flow that ran with its device, and why any worker stopped short. */
interface ParallelOutcome {
  /** `label`: the device's name, numbered when two leased devices share one, as the output and the JUnit suites say it. */
  ran: { idx: number; result: FlowResult; device: DeviceInfo; sessionId: string; label: string }[]
  problems: string[]
}

/** Thrown into `retryAdmission` once there is nothing left to lease a device for; not a refusal, so it ends the wait. */
class NothingLeft extends Error {}

/**
 * Share the eligible flows across `--parallel` devices. Each worker leases a device (the relay chooses it and boots it
 * with the run's reset), installs the build and takes flows off one queue until it is empty — a slow flow holds up only
 * its own device. A worker that cannot boot or install, or loses its device mid-flow, leaves; its flow is not run again
 * (a second replay would be a different execution, and its video and record are keyed by flow), and the others go on.
 * The devices a worker left are excluded from every later lease of the run, so a broken one is not handed out twice.
 */
async function runParallel(run: ParallelRun, workerCount: number): Promise<ParallelOutcome> {
  const { opts, flows, recorder, lane } = run
  const queue = [...run.eligible]
  const leftBehind = new Set<string>()
  /** How many leased devices carried each name, so two Macs' "iPhone 16" are told apart in every line. */
  const named = new Map<string, number>()
  const outcome: ParallelOutcome = { ran: [], problems: [] }
  // Resolved when the queue empties, so a worker waiting out a busy Mac stops waiting rather than sleeping its backoff.
  let emptied!: () => void
  const drained = new Promise<void>((resolve) => { emptied = resolve })
  const take = (): number | undefined => {
    const idx = run.cancelled() ? undefined : queue.shift()
    if (queue.length === 0) emptied()
    return idx
  }

  const work = async (n: number): Promise<void> => {
    const client = new RelayClient(run.relayUrl, run.tokens, { clientId: run.clientId })
    const worker: Worker = { client, ...(lane ? { tap: new VideoTap() } : {}) }
    run.workers.push(worker)
    let label = `device ${n + 1}`
    try {
      await client.connect()
    } catch (e) {
      outcome.problems.push(`${label}: cannot connect to the relay (${(e as Error).message})`)
      return
    }
    if (worker.tap) client.setStreamListener(worker.tap)
    let lease: Lease
    try {
      lease = (await retryAdmission(() => {
        if (queue.length === 0 || run.cancelled()) throw new NothingLeft()
        return client.lease({
          ...(opts.build !== undefined ? { buildId: opts.build } : { platform: opts.platform as 'ios' | 'android' }),
          acceptH264: worker.tap !== undefined,
          ...(run.serviceTier ? { serviceTier: run.serviceTier } : {}),
          ...(run.runReset ? { runReset: run.runReset } : {}),
          exclude: [...leftBehind],
        })
      }, {
        timeoutMs: run.admissionTimeoutMs,
        onWait: (reason, ms) => console.log(`[${label}] waiting ${Math.round(ms / 1000)}s: ${ADMISSION_WAITS[reason]}`),
        sleep: (ms) => Promise.race([new Promise<void>((r) => setTimeout(r, ms).unref()), drained]),
      })).value
    } catch (e) {
      if (e instanceof NothingLeft || run.cancelled()) return
      // A device chosen for this lease that then failed to join or boot: kept out of the run's later leases, as one that
      // failed to install is. A boot the gate held back (a busy Mac, not a broken device) never gets here marked:
      // `retryAdmission` retries it, and the refusal it throws when time runs out is a new error.
      const failedOn = leasedSessionOf(e)
      if (failedOn !== undefined) leftBehind.add(failedOn)
      // A lease that can never be served (no device of the platform) or a wait that ran out: the flows this worker would
      // have run are left to the others, and counted as not run if nobody gets to them.
      outcome.problems.push(`${label}: ${(e as Error).message}`)
      console.error(`✗ [${label}] ${(e as Error).message}`)
      return
    }
    worker.sessionId = lease.sessionId
    const seen = (named.get(lease.deviceName) ?? 0) + 1
    named.set(lease.deviceName, seen)
    label = seen > 1 ? `${lease.deviceName} #${seen}` : lease.deviceName
    const device: DeviceInfo = { id: lease.deviceId, name: lease.deviceName, platform: lease.platform, sessionId: lease.sessionId, status: 'booted', busy: true }
    const ref = { sessionId: lease.sessionId, id: lease.deviceId, name: lease.deviceName }
    const prefix = `[${label}] `
    run.onLease(lease)
    console.log(`${prefix}${lease.source === 'pool' && lease.boot.cold !== true ? 'using a device an earlier run left up' : 'booted'}`)
    recorder?.reportDevice(ref, lease.boot)
    if (run.runReset) printReset(lease.boot.runReset, lease.deviceName, prefix)
    try {
      // Booted after the other devices emptied the queue: an install here would only hold the run's end.
      if (queue.length === 0 || run.cancelled()) return
      if (opts.build !== undefined && opts.install !== false) {
        console.log(`${prefix}installing build ${opts.build}...`)
        await client.installApp(lease.sessionId, opts.build)
      }
      const driver = new RelayDriver(client, lease.sessionId, opts.build)
      const engineOpts = {
        ...(opts.timeout !== undefined ? { defaultTimeoutMs: Math.round(opts.timeout * 1000) } : {}),
        ...(recorder ? { captureLastScreen: true } : {}),
        platform: lease.platform,
        onStep: ({ label: step, ...mark }: Parameters<NonNullable<EngineOptions['onStep']>>[0]) => {
          if (mark.phase === 'start' && step) client.activity(lease.sessionId, `step ${mark.index + 1}: ${step}`)
          worker.tap?.step(mark)
        },
      }
      for (let idx = take(); idx !== undefined; idx = take()) {
        const flow = flows[idx]
        console.log(`${prefix}▶ ${flow.name}`)
        recorder?.reportFlowStart(idx, ref)
        const sink = lane?.video(idx)
        if (sink) worker.tap?.begin(sink, lease.platform)
        const result = await runFlow(flow, driver, engineOpts)
        if (run.cancelled()) return
        if (sink) {
          sink.failed = result.status === 'failed'
          worker.tap?.end()
        }
        outcome.ran.push({ idx, result, device, sessionId: lease.sessionId, label })
        recorder?.reportFlow(idx, flowReport(result, device), result.failureScreenshot ?? result.lastScreenshot)
        console.log(`${prefix}${result.status === 'passed' ? '✓' : '✗'} ${flow.name} (${(result.durationMs / 1000).toFixed(1)}s)`)
        if (result.status === 'failed') printFailure(result, flow, idx, opts, prefix)
        // The device, not the app: whatever went wrong may still be wrong for the next flow, so this worker stops.
        // Unless nothing reached the device — a flow pressing a button this device lacks says nothing about the device,
        // and leaving over it would cost the run a healthy one per such flow.
        if (result.status === 'failed' && result.failureKind === 'environment' && !result.failedBeforeRun) {
          leftBehind.add(lease.sessionId)
          console.error(`${prefix}leaving this device: the flow failed for a reason outside the app`)
          return
        }
      }
    } catch (e) {
      leftBehind.add(lease.sessionId)
      outcome.problems.push(`${label}: ${(e as Error).message}`)
      console.error(`✗ ${prefix}${(e as Error).message}`)
    } finally {
      if (!run.cancelled() && worker.sessionId !== undefined) {
        try { client.leaveSession(worker.sessionId) } catch { /* the socket is gone, and the relay let the device go with it */ }
        worker.sessionId = undefined
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, n) => work(n)))
  return outcome
}

/** A suite per device, under the label its output lines carry, in the order of the first flow each ran. */
function suitesOf(ran: ParallelOutcome['ran']): JUnitSuite[] {
  const bySession = new Map<string, JUnitSuite>()
  for (const r of [...ran].sort((a, b) => a.idx - b.idx)) {
    let suite = bySession.get(r.sessionId)
    if (!suite) {
      suite = { name: `tapflow-flows (${r.label})`, results: [] }
      bySession.set(r.sessionId, suite)
    }
    suite.results.push(r.result)
  }
  return [...bySession.values()]
}

export async function cmdFlowRun(files: string[], opts: FlowRunOptions): Promise<void> {
  let client: RelayClient | undefined
  let recorder: RunRecorder | undefined
  /** Each flow's video (A4): cut from the stream this runner holds, sent beside the record. Only while recording. */
  let video: { tap: VideoTap; lane: VideoLane } | undefined
  let exitCode = 0
  let joinedSessionId: string | undefined
  let sawProductFailure = false
  let errorMessage: string | undefined
  /** The dashboard this run's links point at — the watch link's origin, so the two agree. */
  let dashboardBase: string | undefined
  /** A `--parallel` run's devices, and the one lane their videos share. */
  const workers: Worker[] = []
  let parallelLane: VideoLane | undefined

  // A cancelled run still leaves the session and says so in its record, then exits as the signal would have.
  // A second signal does not wait for any of that.
  let cancelling = false
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    const code = EXIT_ON_SIGNAL[signal]
    if (cancelling) process.exit(code)
    cancelling = true
    console.error(`\n✗ cancelled (${signal})`)
    // Leave first: it stops the device being driven while the record drains, and the relay ends a run on its
    // runner's socket closing, not on a leave — so the record can still finish before `disconnect`.
    try {
      if (client && joinedSessionId !== undefined) client.leaveSession(joinedSessionId)
    } catch { /* leaving is best effort on the way out */ }
    for (const w of workers) {
      try {
        if (w.sessionId !== undefined) w.client.leaveSession(w.sessionId)
      } catch { /* as above */ }
    }
    recorder?.finish({ status: 'aborted', exitCode: code, errorMessage: `cancelled (${signal})` })
    // The flow's video so far, ended as cut short. It drains after `finish`, inside the same budget.
    video?.tap.end('cancelled')
    for (const w of workers) w.tap?.end('cancelled')
    void drainAll(RECORD_DRAIN_ON_SIGNAL_MS).finally(() => {
      client?.disconnect()
      for (const w of workers) w.client.disconnect()
      process.exit(code)
    })
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  /** The record first — `finish` is the runner's own account of the run — then video in what is left of `capMs`. */
  const drainAll = async (capMs: number) => {
    const started = Date.now()
    const record = await recorder?.drain(capMs)
    await (video?.lane ?? parallelLane)?.drain(capMs - (Date.now() - started))
    return record
  }

  try {
    if (files.length === 0) envFail('no flow files given — usage: tapflow flow run .tapflow/flows/*.yaml')
    // NaN would disable every deadline check in the engine (Date.now() >= NaN is
    // always false) and hang the run — reject bad numeric flags up front.
    if (opts.build !== undefined && !Number.isInteger(opts.build)) envFail('--build must be an integer build id (see list_builds / the dashboard)')
    if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0 && opts.timeout <= MAX_TIMEOUT_SECONDS)) {
      envFail(`--timeout must be a positive number of seconds no greater than ${MAX_TIMEOUT_SECONDS}`)
    }
    let serviceTier: ServiceTier | undefined
    if (opts.serviceTier !== undefined) {
      try { serviceTier = parseServiceTier(opts.serviceTier, opts.keep) } catch (e) { envFail(`--service-tier: ${(e as Error).message}`) }
    } else if (opts.keep !== undefined) {
      envFail('--keep needs --service-tier: it names the features to keep on under that tier')
    }
    const parallel = opts.parallel
    if (parallel !== undefined) {
      if (!(Number.isInteger(parallel) && parallel >= 1 && parallel <= MAX_PARALLEL)) envFail(`--parallel must be a whole number of devices from 1 to ${MAX_PARALLEL}`)
      // The relay chooses a --parallel run's devices; naming one would leave the others to chance.
      if (opts.device !== undefined || opts.session !== undefined) envFail('--parallel chooses its devices; leave out --device and --session')
      if (opts.build !== undefined && opts.platform !== undefined) envFail('--platform is for a run without --build; with one, the relay reads the build\'s platform')
      if (opts.build === undefined && opts.platform !== 'ios' && opts.platform !== 'android') {
        envFail(opts.platform === undefined
          ? '--parallel without --build needs --platform ios or --platform android'
          : `--platform must be ios or android, not ${JSON.stringify(opts.platform)}`)
      }
    } else if (opts.platform !== undefined) {
      envFail('--platform is for --parallel; without it, pick the device with --device or --session')
    }
    const admissionTimeout = opts.admissionTimeout ?? DEFAULT_ADMISSION_TIMEOUT_SECONDS
    if (!(Number.isFinite(admissionTimeout) && admissionTimeout >= 0 && admissionTimeout <= MAX_TIMEOUT_SECONDS)) {
      envFail(`--admission-timeout must be a number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}`)
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
    // --token, then TAPFLOW_TOKEN, then the credentials file for this relay. One source for the connection, the
    // record and the video, so a run cannot connect with one token and record with another.
    let tokens: ReturnType<typeof resolveToken>
    try {
      tokens = resolveToken({ relayUrl, ...(opts.token !== undefined ? { explicit: opts.token } : {}), warn: (line) => console.error(line) })
    } catch (e) {
      envFail(`--relay is not a relay URL (${JSON.stringify(relayUrl)}): ${(e as Error).message} — use e.g. ws://localhost:4000`)
    }
    client = new RelayClient(relayUrl, tokens)
    try {
      await client.connect()
    } catch (e) {
      envFail(`cannot connect to relay at ${relayUrl}: ${(e as Error).message}`)
    }
    // An older relay drops a lease without a word, which would read as a wait that never ends.
    if (parallel !== undefined && !(await client.canLease())) envFail('this relay cannot choose devices for --parallel — update it, or run without --parallel')

    // Created now, before a device is chosen, so a run that fails to find, boot or install one is recorded too —
    // the failures the runs page exists to tell apart from a regression.
    if (opts.record === false) {
      // Asked for: nothing to say.
    } else if (!tokens.token) {
      // REST has no loopback exemption, so without a token there is nothing to record with.
      console.error(`run not recorded: ${tokenRefusal(tokens)}, or pass --token`)
    } else {
      recorder = new RunRecorder(httpBaseOf(relayUrl), tokens, {
        fetch: globalThis.fetch,
        warn: (line) => console.error(line),
      })
      recorder.create({
        client: client.clientId,
        ...(opts.build !== undefined ? { buildId: opts.build } : {}),
        flows: flows.map((f, i) => ({ name: f.name, file: files[i] })),
        ci: ciContext(),
        ...(serviceTier ? { serviceTier } : {}),
        resetRequested: opts.reset !== false,
      })
      const lane = new VideoLane(httpBaseOf(relayUrl), tokens, recorder.created, { fetch: globalThis.fetch, warn: (line) => console.error(line) })
      // A --parallel run's devices each cut their own stream into the one lane; this connection holds none.
      if (parallel !== undefined) parallelLane = lane
      else {
        video = { tap: new VideoTap(), lane }
        client.setStreamListener(video.tap)
      }
    }

    // Which flows run is decided before a device is chosen, so a run where none would is refused without touching one.
    const target: EligibilityTarget = { includeTags: parseTagList(opts.includeTags), excludeTags: parseTagList(opts.excludeTags) }
    let buildPlatform: string | undefined
    if (opts.build !== undefined) {
      const build = await lookupBuild(httpBaseOf(relayUrl), tokens, opts.build)
      if (build.kind === 'not-found') envFail(`build ${opts.build} not found on the relay (see list_builds / the dashboard)`)
      if (build.kind === 'found') {
        target.build = { id: opts.build, bundleId: build.bundleId }
        if (build.platform !== null) buildPlatform = build.platform
      }
      else if (flows.some((f) => f.appId !== undefined)) console.error(`app check skipped (${build.reason}): flows run whatever their appId`)
    }
    const eligible: number[] = []
    const skipped: SkippedFlow[] = []
    const skipCounts = new Map<string, number>()
    for (const [flowIndex, flow] of flows.entries()) {
      const verdict = isEligible(flow, target)
      if (verdict.ok) {
        eligible.push(flowIndex)
        continue
      }
      console.log(`– ${flow.name} (skipped: ${verdict.message})`)
      skipped.push({ name: flow.name, ...(flow.file ? { file: flow.file } : {}), message: verdict.message })
      skipCounts.set(verdict.reason, (skipCounts.get(verdict.reason) ?? 0) + 1)
      recorder?.reportSkipped(flowIndex, { reason: verdict.reason, message: verdict.message })
    }
    // A flow pressing a button the platform has none of fails here, before a device is chosen: the compile error to
    // the engine's runtime check, which still runs for what only the device knows (iOS buttons other than home) and
    // for a run that learns its platform only from the device. Failed rather than skipped (a person's decision): a
    // flow that cannot run where it was sent is not one the run chose to leave out.
    const platform = buildPlatform ?? (parallel !== undefined ? opts.platform : undefined)
    const refused: { idx: number; result: FlowResult }[] = []
    if (platform !== undefined) {
      for (const idx of [...eligible]) {
        const missing = unavailableButton(flows[idx], platform)
        if (missing === null || missing === 'needs-chrome') continue
        eligible.splice(eligible.indexOf(idx), 1)
        const result = refusedFlow(flows[idx], missing.index, unavailableButtonMessage(missing, platform), { beforeRun: true })
        refused.push({ idx, result })
        console.log(`✗ ${flows[idx].name}`)
        printFailure(result, flows[idx], idx, opts)
        recorder?.reportFlow(idx, flowReport(result))
      }
    }

    // Nothing ran, so nothing was tested: a green exit here would pass a CI job that checked no flow at all.
    if (eligible.length === 0) {
      // The report is how CI shows why nothing ran, so it is written on this exit too.
      if (opts.junit) writeJUnit(opts.junit, toJUnitXml(refused.map((r) => r.result), skipped))
      const reasons = [...skipCounts].map(([reason, n]) => `${reason} ${n}`).join(', ')
      envFail(`no flow ran: ${[
        ...(skipped.length > 0 ? [`${skipped.length} skipped (${reasons})`] : []),
        ...(refused.length > 0 ? [`${refused.length} cannot run on ${platform}`] : []),
      ].join(', ')}`)
    }

    const runReset = opts.reset === false ? undefined : runResetFor(opts, target, eligible.map((i) => flows[i]))

    if (parallel !== undefined) {
      const { ran, problems } = await runParallel({
        relayUrl, tokens, clientId: client.clientId, opts, flows, eligible,
        ...(serviceTier ? { serviceTier } : {}), ...(runReset ? { runReset } : {}),
        admissionTimeoutMs: admissionTimeout * 1000, ...(recorder ? { recorder } : {}), ...(parallelLane ? { lane: parallelLane } : {}),
        workers, cancelled: () => cancelling,
        onLease: (lease) => {
          if (dashboardBase === undefined) dashboardBase = lease.watchUrl
          if (!runningInCI()) console.log(`watch ${lease.deviceName}: ${lease.watchUrl}`)
        },
      }, Math.min(parallel, eligible.length))
      if (cancelling) return
      const ranIdx = new Set(ran.map((r) => r.idx))
      const notRun = eligible.filter((i) => !ranIdx.has(i))
      const devices = new Set(ran.map((r) => r.sessionId)).size
      if (opts.junit) {
        const left: SkippedFlow[] = notRun.map((i) => ({ name: flows[i].name, ...(flows[i].file ? { file: flows[i].file } : {}), message: 'not run: no device was left to run it' }))
        const suites = suitesOf(ran)
        if (refused.length > 0) suites.push({ name: `tapflow-flows (cannot run on ${platform})`, results: refused.map((r) => r.result) })
        writeJUnit(opts.junit, toJUnitXmlSuites(suites, skipped, left))
        console.log(`JUnit report: ${opts.junit}`)
      }
      const results = [...refused.map((r) => r.result), ...ran.map((r) => r.result)]
      const failed = results.filter((r) => r.status === 'failed')
      sawProductFailure = failed.some((r) => (r.failureKind ?? 'product') !== 'environment')
      console.log(
        `\n${results.length - failed.length}/${eligible.length + refused.length} flows passed on ${devices} device${devices === 1 ? '' : 's'}` +
        `${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}${notRun.length > 0 ? `, ${notRun.length} not run` : ''}`,
      )
      // A flow nobody ran was tested by nobody: that is the environment's failure, as a run that found no device is,
      // unless a product failure says more. A device that dropped out after the others ran everything changes nothing.
      if (sawProductFailure) exitCode = EXIT_FLOW_FAILED
      else if (failed.length > 0 || notRun.length > 0) exitCode = EXIT_ENV_ERROR
      if (notRun.length > 0) {
        errorMessage = `${notRun.length} flow${notRun.length === 1 ? '' : 's'} not run${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`
        console.error(`✗ ${errorMessage}`)
      }
      return
    }

    const { sessionId, device } = await resolveSession(client, opts)
    console.log(`preparing ${device.name}...`)
    let booted: BootOutcome = {}
    // Join and boot as one attempt, retried while the Mac is busy. The session is let go before each wait, so a
    // person who wants this device is not told it is in use by a run that is only queueing (flow-runner's
    // `retryAdmission`).
    const joining = client
    await retryAdmission(async () => {
      const { watchUrl } = await joining.joinSession(sessionId)
      joinedSessionId = sessionId
      if (dashboardBase === undefined) {
        dashboardBase = watchUrl
        // Whoever started the run can watch it live from here, the boot included. **Not in CI**: the link is the
        // relay's address rewritten (`wss://host` → `https://host/…`), so a secret holding the relay URL does not
        // mask it, and a public repository's log would show the host the docs keep in a secret.
        if (!runningInCI()) console.log(`watch this run: ${watchUrl}`)
      }
      try {
        // Always send device:boot — it is idempotent on a booted device and it is
        // what initializes the agent's touch/stream state for this session (the
        // dashboard does the same on join).
        // H.264 when there is a video to keep: JPEG is several times the size and is not kept.
        booted = await joining.bootDevice(sessionId, device.id, { acceptH264: video !== undefined, ...(serviceTier ? { serviceTier } : {}), ...(runReset ? { runReset } : {}) })
      } catch (e) {
        if (admissionRefusalOf(e) !== null) {
          joining.leaveSession(sessionId)
          joinedSessionId = undefined
        }
        throw e
      }
    }, {
      timeoutMs: admissionTimeout * 1000,
      onWait: (reason, ms) => console.log(`waiting ${Math.round(ms / 1000)}s: ${ADMISSION_WAITS[reason]}`),
    })
    recorder?.reportDevice({ sessionId, id: device.id, name: device.name }, booted)
    if (runReset) printReset(booted.runReset, device.name)
    if (opts.build !== undefined && opts.install !== false) {
      console.log(`installing build ${opts.build}...`)
      await client.installApp(sessionId, opts.build)
    }

    const driver = new RelayDriver(client, sessionId, opts.build)
    const relay = client
    const engineOpts = {
      ...(opts.timeout !== undefined ? { defaultTimeoutMs: Math.round(opts.timeout * 1000) } : {}),
      // A passed flow's last screen is evidence for the record; with nothing recording, it would be a screenshot per
      // flow taken for nobody.
      ...(recorder ? { captureLastScreen: true } : {}),
      platform: device.platform,
      onStep: ({ label, ...mark }: Parameters<NonNullable<EngineOptions['onStep']>>[0]) => {
        // Whoever watches the run sees each step as it starts (A2), named without anything it types.
        if (mark.phase === 'start' && label) relay.activity(sessionId, `step ${mark.index + 1}: ${label}`)
        video?.tap.step(mark)
      },
    }
    const results: FlowResult[] = refused.map((r) => r.result)

    for (const flowIndex of eligible) {
      const flow = flows[flowIndex]
      process.stdout.write(`▶ ${flow.name} `)
      recorder?.reportFlowStart(flowIndex, { sessionId, id: device.id, name: device.name })
      const sink = video?.lane.video(flowIndex)
      if (sink) video?.tap.begin(sink, device.platform)
      const result = await runFlow(flow, driver, engineOpts)
      // Cancelled meanwhile: the signal path left the session, which fails the step in flight. That failure is
      // the cancel, not the product, so it is neither printed nor recorded.
      if (cancelling) return
      if (sink) {
        // Before the end: the end is what tells the lane the failure's moment is in its last chunk.
        sink.failed = result.status === 'failed'
        video?.tap.end()
      }
      results.push(result)
      // The screen the flow ended on, failed or passed.
      recorder?.reportFlow(flowIndex, flowReport(result, device), result.failureScreenshot ?? result.lastScreenshot)
      if (result.status === 'failed' && result.failureKind !== 'environment') sawProductFailure = true
      console.log(result.status === 'passed' ? `✓ (${(result.durationMs / 1000).toFixed(1)}s)` : '✗')
      if (result.status === 'failed') printFailure(result, flow, flowIndex, opts)
    }

    if (opts.junit) {
      writeJUnit(opts.junit, toJUnitXml(results, skipped))
      console.log(`JUnit report: ${opts.junit}`)
    }

    const failed = results.filter((r) => r.status === 'failed')
    console.log(`\n${results.length - failed.length}/${results.length} flows passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`)
    // All failed flows environmental → exit 2 (infrastructure, not a regression). Any
    // product failure keeps exit 1, so a real regression is never masked by a blip.
    if (failed.length > 0) {
      exitCode = failed.every((r) => (r.failureKind ?? 'product') === 'environment')
        ? EXIT_ENV_ERROR
        : EXIT_FLOW_FAILED
    }

  } catch (e) {
    // Same as above, for a step that rejects rather than reports the leave.
    if (cancelling) return
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
      video?.tap.end()
      const { runId, complete } = (await drainAll(RECORD_DRAIN_MS))!
      // Incomplete has already been warned about; the id is still worth having to find what did arrive. The page's
      // link only outside CI, for the watch link's reason: it is the relay's address, and a log may be public.
      if (runId) {
        const page = dashboardBase && !runningInCI() ? `: ${new URL(`/automation/runs/${encodeURIComponent(runId)}`, dashboardBase).toString()}` : ''
        console.log(`recorded as run ${runId}${complete ? '' : ' (incomplete)'}${page}`)
      }
    }
    client?.setStreamListener(null)
    if (!cancelling) {
      client?.disconnect()
      for (const w of workers) {
        w.client.setStreamListener(null)
        w.client.disconnect()
      }
    }
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // Here rather than after the block: a --parallel run returns from inside it.
    if (!cancelling) process.exitCode = exitCode
  }
}
