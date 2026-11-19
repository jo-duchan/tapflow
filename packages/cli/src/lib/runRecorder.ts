import { fetchWithToken, fixedToken, tokenRefusal, type BootOutcome, type ServiceTier, type SkipReason, type TokenSource } from '@tapflowio/flow-runner'
import type { CiContext } from './ci.js'

/**
 * Sends a flow run's record to the relay (`/api/v1/runs`), for the runs page.
 *
 * **Recording can never slow a run down or change its result**, and every choice here follows from that:
 * - Calls go through one ordered queue the run never waits on, except once at the end (`drain`), and that
 *   wait has a cap of its own.
 * - Every call has a deadline.
 * - The first failure stops recording for the rest of the run, with one warning. A relay that refused once
 *   will refuse again, and a run's output is no place for a warning per flow.
 * - Nothing here touches the exit code.
 */

export interface RunRecorderDeps {
  fetch: typeof fetch
  /** One line to the person running the command. At most three times per run: once if recording stops, once
   *  the first time a flow's screenshot (the screen it failed on or ended on) cannot be sent, and once if the relay
   *  refuses a skipped flow. */
  warn: (line: string) => void
  callTimeoutMs?: number
}

export interface PlannedFlow { name: string; file?: string }

export interface FlowReport {
  status: 'passed' | 'failed'
  durationMs: number
  failureKind?: 'environment' | 'product'
  failureMessage?: string
  steps: {
    index: number; name: string; status: string; durationMs: number; message?: string
    reach?: 'verified' | 'delivered' | 'unchecked'; reachNote?: string; effect?: 'confirmed' | 'failed'
    suggestions?: { yaml: string; element: { role: string; label: string; identifier?: string } }[]
  }[]
  device?: { id: string; name: string; platform?: string }
}

/** The device a flow or a boot happened on, named by the session that holds it, so a run on several devices can tell
 *  them apart. */
export interface RunDeviceRef { sessionId: string; id: string; name: string }

export interface RunOutcome {
  status: 'passed' | 'failed' | 'aborted'
  exitCode: number
  failureKind?: string
  errorMessage?: string
}

const CALL_TIMEOUT_MS = 5_000

class RecordRefused extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export interface SkippedReport {
  reason: SkipReason
  message: string
}

export class RunRecorder {
  private queue: Promise<void> = Promise.resolve()
  private id: string | null = null
  private stopped = false
  private finished = false
  private screenshotWarned = false
  private skippedWarned = false
  /** Aborts the call in flight when the drain gives up, so nothing keeps the process alive past the cap. */
  private readonly gaveUp = new AbortController()
  private readonly callTimeoutMs: number
  private resolveCreated!: (id: string | null) => void
  /** The run's id once the relay has answered the create, or null if it never will — what the video lane waits on. */
  readonly created: Promise<string | null> = new Promise((resolve) => { this.resolveCreated = resolve })

  private readonly tokens: TokenSource

  constructor(
    private readonly httpBase: string,
    token: string | TokenSource,
    private readonly deps: RunRecorderDeps,
  ) {
    this.tokens = typeof token === 'string' ? fixedToken(token, httpBase) : token
    this.callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS
  }

  /** The run's id once the relay has created it. */
  get runId(): string | null {
    return this.id
  }

  create(run: { client: string; buildId?: number; flows: PlannedFlow[]; ci: CiContext | null; serviceTier?: ServiceTier; resetRequested?: boolean }): void {
    this.enqueue(false, async () => {
      try {
        await this.createRun(run)
      } finally {
        this.resolveCreated(this.id)
      }
    })
  }

  private async createRun(run: { client: string; buildId?: number; flows: PlannedFlow[]; ci: CiContext | null; serviceTier?: ServiceTier; resetRequested?: boolean }): Promise<void> {
    const res = await this.post('/api/v1/runs', JSON.stringify({
      client: run.client,
      ...(run.buildId !== undefined ? { buildId: run.buildId } : {}),
      flows: run.flows,
      ...(run.ci ? { ci: run.ci } : {}),
      ...(run.serviceTier ? { serviceTier: run.serviceTier } : {}),
      ...(run.resetRequested !== undefined ? { resetRequested: run.resetRequested } : {}),
    }), 'application/json')
    // A relay older than run records answers an unknown `/api/` POST with the dashboard's `index.html` and a
    // 200, so "ok" is not "supported". Only an id says it was recorded.
    const body = await res.json().catch(() => null) as { id?: unknown } | null
    if (typeof body?.id !== 'string') throw new RecordRefused('this relay does not record runs yet (update it to record them)')
    this.id = body.id
  }

  reportFlow(idx: number, report: FlowReport, screenshot?: Uint8Array): void {
    // A report after `finish` would be refused (409) and print a warning about a run that already ended.
    if (this.finished) return
    this.enqueue(true, async () => {
      const { device, ...rest } = report
      await this.post(`/api/v1/runs/${this.id}/flows/${idx}`, JSON.stringify({
        ...rest,
        ...(device ? { deviceId: device.id, deviceName: device.name, ...(device.platform ? { platform: device.platform } : {}) } : {}),
      }), 'application/json')
      if (screenshot) {
        // Raw bytes: the relay judges the image by its first bytes, not by what this says it is.
        //
        // **A failed screenshot is not a failed record.** The relay refuses one image for what it is (over 5 MB,
        // 413), and a large one on a slow link can outrun its deadline; either way the next report still lands.
        // Stopping here would leave the run unfinished, and the relay would then close it as "runner
        // disconnected": a real regression shown as an infrastructure blip, the very confusion the record exists
        // to end. A relay that is really gone fails the next call and stops recording there.
        try {
          await this.post(`/api/v1/runs/${this.id}/flows/${idx}/screenshot`, screenshot, 'application/octet-stream')
        } catch (e) {
          if (this.gaveUp.signal.aborted) throw e
          // Said once, so a run of failing flows on a large-screen device is one line rather than one per flow.
          if (!this.screenshotWarned) {
            this.screenshotWarned = true
            const reason = e instanceof RecordRefused ? e.message : (e as Error).message
            this.deps.warn(`screenshot not recorded (flow ${idx + 1}): ${reason}; the rest of the run is still recorded`)
          }
        }
      }
    })
  }

  /**
   * A flow the run chose not to replay. **A relay that refuses it is not a reason to stop recording**: one older
   * than skipped flows answers 400, and stopping there would drop every report after it and the finish too, so the
   * relay would close the run as "runner disconnected". Skipped reports are sent before any flow runs, so that
   * would be the whole run.
   */
  reportSkipped(idx: number, skipped: SkippedReport): void {
    if (this.finished) return
    this.enqueue(true, async () => {
      try {
        await this.post(`/api/v1/runs/${this.id}/flows/${idx}`, JSON.stringify({
          status: 'skipped', skipReason: skipped.reason, failureMessage: skipped.message, durationMs: 0, steps: [],
        }), 'application/json')
      } catch (e) {
        if (!(e instanceof RecordRefused && e.status === 400)) throw e
        if (!this.skippedWarned) {
          this.skippedWarned = true
          this.deps.warn(`skipped flows not recorded: ${e.message} — update the relay to record them; the rest of the run is still recorded`)
        }
      }
    })
  }

  /**
   * What the run's boot said about its device: whether it was already up, and what was reset. Sent as soon as the boot
   * answers, so a run that then fails to install, is cancelled or loses its runner still has it. A relay that predates
   * the route answers it with the dashboard's `index.html` and 200, so it passes unrecorded; the 400 and 404 caught
   * below are this relay refusing the body or having lost the run, neither a reason to stop recording the rest.
   */
  reportDevice(device: RunDeviceRef, booted: BootOutcome): void {
    if (this.finished) return
    this.enqueue(true, async () => {
      try {
        await this.post(`/api/v1/runs/${this.id}/device`, JSON.stringify({
          sessionId: device.sessionId, deviceId: device.id, deviceName: device.name, ...booted,
        }), 'application/json')
      } catch (e) {
        if (!(e instanceof RecordRefused && (e.status === 400 || e.status === 404))) throw e
      }
    })
  }

  /**
   * Flow `idx` is starting on `device`, so the runs page can show it running there rather than guess. Refusals are
   * dropped for `reportDevice`'s reasons; an older relay has no route for it and answers 404, or `index.html` and 200.
   */
  reportFlowStart(idx: number, device: RunDeviceRef): void {
    if (this.finished) return
    this.enqueue(true, async () => {
      try {
        await this.post(`/api/v1/runs/${this.id}/flows/${idx}/start`, JSON.stringify({
          sessionId: device.sessionId, deviceId: device.id, deviceName: device.name,
        }), 'application/json')
      } catch (e) {
        if (!(e instanceof RecordRefused && (e.status === 400 || e.status === 404))) throw e
      }
    })
  }

  /** Only the first call counts: a cancelled run finishes from its signal handler, then from its `finally`. */
  finish(outcome: RunOutcome): void {
    if (this.finished) return
    this.finished = true
    this.enqueue(true, async () => {
      await this.post(`/api/v1/runs/${this.id}/finish`, JSON.stringify(outcome), 'application/json')
    })
  }

  /**
   * Wait for what is queued, but never longer than `capMs`. Answers the run id when the relay created the run,
   * and whether everything queued reached it.
   */
  async drain(capMs: number): Promise<{ runId: string | null; complete: boolean }> {
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<'cap'>((resolve) => { timer = setTimeout(() => resolve('cap'), capMs) })
    const done = await Promise.race([this.queue.then(() => 'done' as const), cap])
    clearTimeout(timer)
    if (done === 'cap') {
      const warned = this.stopped
      this.stopped = true
      // A call still waiting on its own deadline would hold the process open past the cap.
      this.gaveUp.abort()
      this.resolveCreated(this.id)
      if (!warned) this.deps.warn(`run record incomplete: the relay did not answer within ${Math.round(capMs / 1000)}s`)
    }
    return { runId: this.id, complete: !this.stopped }
  }

  private enqueue(needsRun: boolean, op: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.stopped || (needsRun && this.id === null)) return
      try {
        await op()
      } catch (e) {
        // Already stopped means the drain gave up and said so; this is the call it aborted.
        if (this.stopped) return
        this.stopped = true
        const reason = e instanceof RecordRefused ? e.message : `could not reach the relay (${(e as Error).message})`
        this.deps.warn(this.id === null ? `run not recorded: ${reason}` : `run record incomplete: ${reason}`)
      }
    })
  }

  private async post(path: string, body: string | Uint8Array, contentType: string): Promise<Response> {
    const res = await fetchWithToken(this.tokens, new URL(path, this.httpBase).toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: typeof body === 'string' ? body : new Uint8Array(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.callTimeoutMs), this.gaveUp.signal]),
    }, this.deps.fetch)
    if (!res.ok) throw new RecordRefused(await refusal(res, this.tokens), res.status)
    return res
  }
}

async function refusal(res: Response, tokens: TokenSource): Promise<string> {
  const detail = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : ''), () => '')
  if (res.status === 401) return tokenRefusal(tokens)
  if (res.status === 403) return `the token may not record runs${detail ? ` (${detail})` : ''} — it needs builds:write, and a role that may write`
  return `the relay answered ${res.status}${detail ? ` (${detail})` : ''}`
}
