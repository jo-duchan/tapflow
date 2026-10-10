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
  /** One line to the person running the command. Called at most once per run. */
  warn: (line: string) => void
  callTimeoutMs?: number
}

export interface PlannedFlow { name: string; file?: string }

export interface FlowReport {
  status: 'passed' | 'failed'
  durationMs: number
  failureKind?: 'environment' | 'product'
  failureMessage?: string
  steps: { index: number; name: string; status: string; durationMs: number; message?: string }[]
  device?: { id: string; name: string; platform?: string }
}

export interface RunOutcome {
  status: 'passed' | 'failed' | 'aborted'
  exitCode: number
  failureKind?: string
  errorMessage?: string
}

const CALL_TIMEOUT_MS = 5_000

class RecordRefused extends Error {}

export class RunRecorder {
  private queue: Promise<void> = Promise.resolve()
  private id: string | null = null
  private stopped = false
  private finished = false
  private readonly callTimeoutMs: number

  constructor(
    private readonly httpBase: string,
    private readonly token: string,
    private readonly deps: RunRecorderDeps,
  ) {
    this.callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS
  }

  /** The run's id once the relay has created it. */
  get runId(): string | null {
    return this.id
  }

  create(run: { client: string; buildId?: number; flows: PlannedFlow[]; ci: CiContext | null }): void {
    this.enqueue(false, async () => {
      const res = await this.post('/api/v1/runs', JSON.stringify({
        client: run.client,
        ...(run.buildId !== undefined ? { buildId: run.buildId } : {}),
        flows: run.flows,
        ...(run.ci ? { ci: run.ci } : {}),
      }), 'application/json')
      // A relay older than run records answers an unknown `/api/` POST with the dashboard's `index.html` and a
      // 200, so "ok" is not "supported". Only an id says it was recorded.
      const body = await res.json().catch(() => null) as { id?: unknown } | null
      if (typeof body?.id !== 'string') throw new RecordRefused('this relay does not record runs yet (update it to record them)')
      this.id = body.id
    })
  }

  reportFlow(idx: number, report: FlowReport, screenshot?: Buffer): void {
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
        await this.post(`/api/v1/runs/${this.id}/flows/${idx}/screenshot`, screenshot, 'application/octet-stream')
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

  /** Wait for what is queued, but never longer than `capMs`. Answers the run id when it was created. */
  async drain(capMs: number): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<'cap'>((resolve) => { timer = setTimeout(() => resolve('cap'), capMs) })
    const done = await Promise.race([this.queue.then(() => 'done' as const), cap])
    clearTimeout(timer)
    if (done === 'cap' && !this.stopped) {
      this.stopped = true
      this.deps.warn(`run record incomplete: the relay did not answer within ${Math.round(capMs / 1000)}s`)
    }
    return this.id
  }

  private enqueue(needsRun: boolean, op: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.stopped || (needsRun && this.id === null)) return
      try {
        await op()
      } catch (e) {
        this.stopped = true
        const reason = e instanceof RecordRefused ? e.message : `could not reach the relay (${(e as Error).message})`
        this.deps.warn(this.id === null ? `run not recorded: ${reason}` : `run record incomplete: ${reason}`)
      }
    })
  }

  private async post(path: string, body: string | Buffer, contentType: string): Promise<Response> {
    const res = await this.deps.fetch(new URL(path, this.httpBase).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': contentType },
      body: typeof body === 'string' ? body : new Uint8Array(body),
      signal: AbortSignal.timeout(this.callTimeoutMs),
    })
    if (!res.ok) throw new RecordRefused(await refusal(res))
    return res
  }
}

async function refusal(res: Response): Promise<string> {
  const detail = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : ''), () => '')
  if (res.status === 401) return 'the relay did not accept the token'
  if (res.status === 403) return `the token may not record runs${detail ? ` (${detail})` : ''} — it needs builds:write, and a role that may write`
  return `the relay answered ${res.status}${detail ? ` (${detail})` : ''}`
}
