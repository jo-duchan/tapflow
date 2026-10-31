import http from 'http'
import { readRunResetReport, readServiceTier } from '@tapflowio/protocol/validate'
import type { RunResetReport, ServiceTier } from '@tapflowio/protocol'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getDb, isDbOpen } from '../db.js'
import { assertCanWrite, requireBuildAuth, requireViewAuth } from '../middleware/auth.js'
import { json, readBodyLimited } from '../router.js'
import { unlinkSafe } from '../lib/uploads.js'

// Flow run records: what `tapflow flow run` did, for the runs page. The CLI writes them over REST with the
// token it already runs with, and nothing here may ever make that run slower or fail it — the caps below
// refuse rather than wait, and every refusal is an answer the CLI can drop.

const MAX_JSON_BYTES = 1024 * 1024
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const MAX_FLOWS = 500
const MAX_STEPS = 1000
const MAX_NAME = 500
const MAX_MESSAGE = 4000
const MAX_STEP_MESSAGE = 2000
const MAX_CLIENT_ID = 200
const MAX_SUGGESTIONS = 3
const MAX_SUGGESTION_YAML = 600
const MAX_SUGGESTION_FIELD = 200
const PAGE_DEFAULT = 50
const PAGE_MAX = 100
/** A run with no build has nothing else to expire with. */
const BUILDLESS_TTL_DAYS = 7
/**
 * How long a running run whose holder has no socket stays running when the relay did not see the socket
 * close — a relay restart, which drops every socket without a close handler for the ones before it. The
 * close handler is the normal path (`abandonRunsOf`); this only catches what it could not.
 */
const ORPHAN_GRACE_SECONDS = 60

/**
 * What the relay knows about the client that holds a run. A run is live exactly while its holder's socket is
 * open: the flow runner does not reconnect, so a closed socket is the end of that process's run.
 */
export interface RunHolders {
  /** The owner keys of every open socket, built once per pass so a check costs a lookup, not a scan. */
  connectedKeys(): Set<string>
  /** The sessions the sockets with these keys hold now — the ones a watch link should open. A parallel run holds one
   *  per device. */
  heldSessions(keys: string[]): string[]
}

/** A flow the runner said it started, on which device. */
interface StartedFlow { sessionId: string; deviceId: string | null; deviceName: string | null }

/**
 * The flows each running run has started and not yet reported, by run id. **Memory, not the database**: which flow is
 * on a device right now means something only while the runner's socket is open, and a relay restart drops that socket,
 * so the run is closed as `holder-lost` within `ORPHAN_GRACE_SECONDS` anyway. A run is present from its first start
 * report, even with nothing in flight, so the page can tell a runner that reports starts from one that predates them.
 */
const startedFlows = new Map<string, Map<number, StartedFlow>>()

/**
 * Drop the started flows of every run that is no longer running. The paths in this file forget a run as it ends, but a
 * run's row can also be deleted under it — its build or app deleted, its expiry passed — by code that never calls in
 * here; the daily purge sweeps those, whichever path took them.
 */
export function forgetStartedFlowsOfStoppedRuns(): void {
  if (startedFlows.size === 0) return
  const running = getDb().prepare(`SELECT 1 FROM flow_runs WHERE id = ? AND status = 'running'`)
  for (const id of startedFlows.keys()) if (!running.get(id)) startedFlows.delete(id)
}

/** How many runs have started flows held in memory, for tests of when they are let go. */
export function startedFlowRunCount(): number {
  return startedFlows.size
}

/**
 * The owner keys the runner's socket can have (`ownerKeyFor` in `RelayServer`). **Two, because the socket
 * and REST disagree on loopback**: the handshake does not read a PAT from a local connection, so a runner on
 * the relay's own Mac — a common CI setup — holds its sessions as `anon:<client>`, while the same token on
 * REST names its user. Matching the user form only left every such run unconnected and aborted it a minute
 * in. The anonymous form is reachable only from loopback, and only with the client id, which nothing serves.
 */
export function holderKeys(createdBy: number | null, client: string): string[] {
  return createdBy === null ? [`anon:${client}`] : [`${createdBy}:${client}`, `anon:${client}`]
}

/** Where run screenshots live, alongside `uploads/` and `recordings/`. */
export function runScreenshotsDirFor(uploadsDir: string): string {
  return path.join(uploadsDir, '../run-screenshots')
}

// ── validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A string cut to `max`, or null for anything that is not a non-empty string. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v.length > max ? v.slice(0, max) : v
}

/**
 * A failed `tapOn`'s suggested lines (B2), kept whole or not at all: unlike a message, a cut YAML line is a different
 * selector — `"Pay now la` matches by part — so one over its cap is dropped, never shortened.
 */
function suggestions(v: unknown): { yaml: string; element: { role: string; label: string; identifier?: string } }[] {
  if (!Array.isArray(v)) return []
  const whole = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : null)
  const out: { yaml: string; element: { role: string; label: string; identifier?: string } }[] = []
  for (const s of v) {
    if (out.length === MAX_SUGGESTIONS) break
    if (!isObj(s) || !isObj(s.element)) continue
    const yaml = whole(s.yaml, MAX_SUGGESTION_YAML)
    const role = whole(s.element.role, 50)
    const label = whole(s.element.label, MAX_SUGGESTION_FIELD)
    const identifier = s.element.identifier === undefined ? undefined : whole(s.element.identifier, MAX_SUGGESTION_FIELD)
    if (!yaml || !yaml.startsWith('tapOn: ') || role === null || label === null || identifier === null) continue
    out.push({ yaml, element: { role, label, ...(identifier ? { identifier } : {}) } })
  }
  return out
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/** Only `http:` and `https:`: the dashboard renders this as a link, and `javascript:` is a URL too. */
function httpUrl(v: unknown): string | null {
  const s = str(v, 2000)
  if (s === null) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Obj | null> {
  const buf = await readBodyLimited(req, MAX_JSON_BYTES)
  if (buf === null) { json(res, 413, { error: 'Body too large' }); return null }
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf-8'))
    if (isObj(parsed)) return parsed
  } catch { /* answered below */ }
  json(res, 400, { error: 'Body must be a JSON object' })
  return null
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface RunRow {
  seq: number
  id: string
  build_id: number | null
  holder_client: string
  created_by: number | null
  pat_id: number | null
  is_ci: number
  ci_provider: string | null
  ci_branch: string | null
  ci_commit: string | null
  ci_job_url: string | null
  service_tier_json: string | null
  device_reset_json: string | null
  status: 'running' | 'passed' | 'failed' | 'aborted'
  finished_by: 'client' | 'relay' | null
  failure_kind: string | null
  error_message: string | null
  exit_code: number | null
  flows_json: string
  flows_total: number
  created_at: string
  last_activity_at: string
  finished_at: string | null
}

interface FlowRow {
  idx: number
  name: string
  file: string | null
  device_id: string | null
  device_name: string | null
  platform: string | null
  status: 'passed' | 'failed' | 'skipped'
  skip_reason: string | null
  failure_kind: string | null
  failure_message: string | null
  duration_ms: number
  steps_json: string
  screenshot_file: string | null
  screenshot_mime: string | null
}

export function findRun(id: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as RunRow | undefined
}

// ── liveness ────────────────────────────────────────────────────────────────

const ABANDON = `
  UPDATE flow_runs
     SET status = 'aborted', finished_by = 'relay', failure_kind = 'holder-lost',
         error_message = 'The flow runner disconnected before the run finished',
         finished_at = datetime('now')
   WHERE status = 'running'`

/**
 * A socket with `socketKey` closed: the runs it held are over unless another socket of the same runner is
 * still open. Called from the socket close handler, so it tolerates a relay started without a database
 * (tests that never touch REST).
 */
export function abandonRunsOf(socketKey: string, holders: RunHolders): void {
  if (!isDbOpen()) return
  const colon = socketKey.indexOf(':')
  const user = socketKey.slice(0, colon)
  const client = socketKey.slice(colon + 1)
  const db = getDb()
  const runs = (user === 'anon'
    ? db.prepare(`SELECT seq, id, created_by, holder_client FROM flow_runs WHERE status = 'running' AND holder_client = ?`).all(client)
    : db.prepare(`SELECT seq, id, created_by, holder_client FROM flow_runs WHERE status = 'running' AND holder_client = ? AND created_by = ?`).all(client, Number(user))
  ) as { seq: number; id: string; created_by: number | null; holder_client: string }[]
  if (runs.length === 0) return
  const open = holders.connectedKeys()
  const stmt = db.prepare(`${ABANDON} AND seq = ?`)
  for (const r of runs) {
    if (holderKeys(r.created_by, r.holder_client).some((k) => open.has(k))) continue
    stmt.run(r.seq)
    startedFlows.delete(r.id)
  }
}

/**
 * Close every running run whose holder is gone and has been quiet past the grace. Read paths call this
 * before answering, and the daily purge persists it, so no timer exists for it.
 */
export function settleOrphanedRuns(holders: RunHolders): void {
  const running = getDb().prepare(`
    SELECT seq, id, created_by, holder_client FROM flow_runs
     WHERE status = 'running' AND last_activity_at < datetime('now', ?)
  `).all(`-${ORPHAN_GRACE_SECONDS} seconds`) as { seq: number; id: string; created_by: number | null; holder_client: string }[]
  if (running.length === 0) return
  const open = holders.connectedKeys()
  const stmt = getDb().prepare(`${ABANDON} AND seq = ?`)
  for (const r of running) {
    if (holderKeys(r.created_by, r.holder_client).some((k) => open.has(k))) continue
    stmt.run(r.seq)
    startedFlows.delete(r.id)
  }
}

// ── writes (the run's creator only) ─────────────────────────────────────────

/**
 * The run, when this request may write to it: a `builds:write` credential whose owner may write, belonging
 * to the user who created the run — and, when it was created with a PAT, that same PAT. A run id leaking
 * into a CI log must not let another job, or another person's token, rewrite its result.
 */
export function ownRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  /** Seconds after the runner finished the run during which it may still write. Only video uses it: the last
   *  flow's tail is sent after `finish`, which goes first so a slow video never costs the run its own ending. */
  graceAfterFinishSeconds = 0,
): RunRow | null {
  const auth = requireBuildAuth(req, res)
  if (!auth) return null
  if (!assertCanWrite(res, auth.userId)) return null
  const run = findRun(id)
  if (!run) { json(res, 404, { error: 'Run not found' }); return null }
  const samePat = run.pat_id === null || run.pat_id === auth.patId
  if (run.created_by !== auth.userId || !samePat) {
    json(res, 403, { error: 'Only the run that created this record may write to it' })
    return null
  }
  if (run.finished_by === 'client' && !finishedWithin(run, graceAfterFinishSeconds)) {
    json(res, 409, { error: 'Run already finished' })
    return null
  }
  return run
}

/** Whether the run was finished no more than `seconds` ago. */
export function finishedWithin(run: Pick<RunRow, 'finished_at'>, seconds: number): boolean {
  if (seconds <= 0 || run.finished_at === null) return false
  const row = getDb().prepare(`SELECT ? > datetime('now', ?) AS recent`).get(run.finished_at, `-${seconds} seconds`) as { recent: number }
  return row.recent === 1
}

export async function handleCreateRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = requireBuildAuth(req, res)
  if (!auth) return
  if (!assertCanWrite(res, auth.userId)) return
  const body = await readJsonBody(req, res)
  if (!body) return

  const client = body.client
  if (typeof client !== 'string' || client.length === 0 || client.length > MAX_CLIENT_ID) {
    return json(res, 400, { error: 'client must be the id the runner connected with' })
  }
  if (!Array.isArray(body.flows) || body.flows.length > MAX_FLOWS) {
    return json(res, 400, { error: `flows must be an array of at most ${MAX_FLOWS}` })
  }
  const flows: { name: string; file: string | null }[] = []
  for (const f of body.flows as unknown[]) {
    const name = isObj(f) ? str(f.name, MAX_NAME) : null
    if (name === null) return json(res, 400, { error: 'every flow needs a name' })
    flows.push({ name, file: str((f as Obj).file, MAX_NAME) })
  }

  let buildId: number | null = null
  if (body.buildId !== undefined && body.buildId !== null) {
    buildId = nonNegInt(body.buildId)
    if (buildId === null || !getDb().prepare('SELECT 1 FROM builds WHERE id = ?').get(buildId)) {
      return json(res, 400, { error: 'buildId does not name a build' })
    }
  }

  const ci = isObj(body.ci) ? body.ci : null
  // Dropped rather than refused when it is not a tier, as `ci`'s fields are: recording never fails a run.
  const serviceTier = readServiceTier(body.serviceTier)
  const deviceReset: DeviceReset | null = typeof body.resetRequested === 'boolean' ? { requested: body.resetRequested } : null
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO flow_runs (id, build_id, holder_client, created_by, pat_id, is_ci, ci_provider, ci_branch, ci_commit,
                           ci_job_url, service_tier_json, device_reset_json, flows_json, flows_total, delete_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN datetime('now', ?) END)
  `).run(
    id, buildId, client,
    auth.userId, auth.patId ?? null,
    ci ? 1 : 0,
    ci ? str(ci.provider, 50) : null,
    ci ? str(ci.branch, MAX_NAME) : null,
    ci ? str(ci.commit, 100) : null,
    ci ? httpUrl(ci.jobUrl) : null,
    serviceTier ? JSON.stringify(serviceTier) : null,
    deviceReset ? JSON.stringify(deviceReset) : null,
    JSON.stringify(flows), flows.length,
    buildId, `+${BUILDLESS_TTL_DAYS} days`,
  )
  json(res, 201, { id })
}

const FLOW_STATUSES = new Set(['passed', 'failed', 'skipped'])
/** Why the runner did not replay a flow — flow-runner's `SkipReason`. */
const SKIP_REASONS = new Set(['app-mismatch', 'tag-filter'])
const STEP_STATUSES = new Set(['passed', 'failed', 'skipped'])

export async function handleReportFlow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const idx = Number(params.idx)
  if (!Number.isInteger(idx) || idx < 0 || idx >= run.flows_total) return json(res, 404, { error: 'No such flow in this run' })
  const body = await readJsonBody(req, res)
  if (!body) return

  if (typeof body.status !== 'string' || !FLOW_STATUSES.has(body.status)) {
    return json(res, 400, { error: 'status must be passed, failed or skipped' })
  }
  // The reason comes with a skip and with nothing else, so a row cannot say "passed" and give a reason it was not run.
  const skipReason = body.status === 'skipped' ? body.skipReason : undefined
  if (body.status === 'skipped' && (typeof skipReason !== 'string' || !SKIP_REASONS.has(skipReason))) {
    return json(res, 400, { error: 'a skipped flow needs a skipReason of app-mismatch or tag-filter' })
  }
  if (body.status !== 'skipped' && body.skipReason != null) {
    return json(res, 400, { error: 'skipReason is only for a skipped flow' })
  }
  const durationMs = nonNegInt(body.durationMs)
  if (durationMs === null) return json(res, 400, { error: 'durationMs must be a non-negative integer' })
  if (!Array.isArray(body.steps) || body.steps.length > MAX_STEPS) {
    return json(res, 400, { error: `steps must be an array of at most ${MAX_STEPS}` })
  }
  // Rebuilt field by field, so what is stored is only what the page renders.
  const steps: { index: number; name: string; status: string; durationMs: number; message?: string; suggestions?: ReturnType<typeof suggestions> }[] = []
  for (const s of body.steps as unknown[]) {
    if (!isObj(s) || typeof s.status !== 'string' || !STEP_STATUSES.has(s.status)) {
      return json(res, 400, { error: 'every step needs a status of passed, failed or skipped' })
    }
    const message = str(s.message, MAX_STEP_MESSAGE)
    const suggested = s.status === 'failed' ? suggestions(s.suggestions) : []
    steps.push({
      index: nonNegInt(s.index) ?? steps.length,
      name: str(s.name, MAX_NAME) ?? '',
      status: s.status,
      durationMs: nonNegInt(s.durationMs) ?? 0,
      ...(message !== null ? { message } : {}),
      ...(suggested.length > 0 ? { suggestions: suggested } : {}),
    })
  }
  const planned = (JSON.parse(run.flows_json) as { name: string; file: string | null }[])[idx]

  const db = getDb()
  // The run can go while the body arrives — its build purged, its app deleted — and the insert would then
  // fail its foreign key as a 500 with a stack in the log, for an answer that is just "not found".
  // `ownRun` judged the run before the body arrived; it is judged again here, where nothing can interleave.
  const refusal = db.transaction((): 'gone' | 'finished' | 'ran' | null => {
    const now = db.prepare('SELECT finished_by FROM flow_runs WHERE seq = ?').get(run.seq) as { finished_by: string | null } | undefined
    if (!now) return 'gone'
    if (now.finished_by === 'client') return 'finished'
    // A flow that ran cannot become one that was skipped: its screenshot would stay behind a row that says nothing
    // was on screen. The runner decides skips before any flow runs, so only a confused client gets here.
    if (body.status === 'skipped') {
      const was = db.prepare('SELECT status FROM flow_run_flows WHERE run_seq = ? AND idx = ?').get(run.seq, idx) as { status: string } | undefined
      if (was && was.status !== 'skipped') return 'ran'
    }
    // An upsert that keeps the screenshot: the CLI may retry a report, and the screenshot arrives separately.
    db.prepare(`
      INSERT INTO flow_run_flows (run_seq, idx, name, file, device_id, device_name, platform, status, skip_reason,
                                  failure_kind, failure_message, duration_ms, steps_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_seq, idx) DO UPDATE SET
        device_id = excluded.device_id, device_name = excluded.device_name, platform = excluded.platform,
        status = excluded.status, skip_reason = excluded.skip_reason, failure_kind = excluded.failure_kind,
        failure_message = excluded.failure_message, duration_ms = excluded.duration_ms, steps_json = excluded.steps_json
    `).run(
      run.seq, idx, planned.name, planned.file,
      str(body.deviceId, MAX_NAME), str(body.deviceName, MAX_NAME), str(body.platform, 50),
      body.status, skipReason ?? null, body.status === 'skipped' ? null : str(body.failureKind, 50), str(body.failureMessage, MAX_MESSAGE),
      durationMs, JSON.stringify(steps),
    )
    db.prepare(`UPDATE flow_runs SET last_activity_at = datetime('now') WHERE seq = ?`).run(run.seq)
    return null
  })()
  if (refusal === 'gone') return json(res, 404, { error: 'Run not found' })
  if (refusal === 'finished') return json(res, 409, { error: 'Run already finished' })
  if (refusal === 'ran') return json(res, 409, { error: 'This flow already ran; it cannot be reported as skipped' })
  json(res, 200, { ok: true })
}

/**
 * The runner started flow `idx` on a device. Without it the page could only guess the first unreported flow, which a
 * run on several devices makes wrong: several flows run at once, and not in order. A start for a flow already
 * reported changes nothing on the page, which reads a reported flow's row before this, so nothing here checks for one
 * or forgets an entry when its flow reports; entries go with the run, and there are at most `flows_total`.
 */
export async function handleStartFlow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const idx = Number(params.idx)
  if (!Number.isInteger(idx) || idx < 0 || idx >= run.flows_total) return json(res, 404, { error: 'No such flow in this run' })
  const body = await readJsonBody(req, res)
  if (!body) return
  const sessionId = str(body.sessionId, MAX_NAME)
  if (sessionId === null) return json(res, 400, { error: 'sessionId is required' })
  const db = getDb()
  // Judged after the body, as the flow report is: the run may have finished or gone while it arrived.
  const now = db.prepare('SELECT status FROM flow_runs WHERE seq = ?').get(run.seq) as { status: string } | undefined
  if (!now) return json(res, 404, { error: 'Run not found' })
  // A run the relay closed (`holder-lost`) still takes the runner's reports, as `ownRun` allows, but has nothing
  // running to show; `ownRun` already refused one the runner finished itself.
  if (now.status === 'running') {
    let started = startedFlows.get(run.id)
    if (!started) { started = new Map(); startedFlows.set(run.id, started) }
    started.set(idx, { sessionId, deviceId: str(body.deviceId, MAX_NAME), deviceName: str(body.deviceName, MAX_NAME) })
  }
  db.prepare(`UPDATE flow_runs SET last_activity_at = datetime('now') WHERE seq = ?`).run(run.seq)
  json(res, 200, { ok: true })
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** The type the bytes are, not the type the request says — the file is served back to browsers. */
function imageKind(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return { mime: 'image/png', ext: '.png' }
  if (buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return { mime: 'image/jpeg', ext: '.jpg' }
  return null
}

export async function handleUploadFlowScreenshot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  screenshotsDir: string,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const current = getDb().prepare('SELECT screenshot_file, status FROM flow_run_flows WHERE run_seq = ? AND idx = ?')
  const row = current.get(run.seq, Number(params.idx)) as { status: string } | undefined
  if (!row) return json(res, 404, { error: 'Report the flow before its screenshot' })
  // Nothing was on a screen for a flow that never ran.
  if (row.status === 'skipped') return json(res, 409, { error: 'A skipped flow has no screenshot' })

  const buf = await readBodyLimited(req, MAX_SCREENSHOT_BYTES)
  if (buf === null) return json(res, 413, { error: `Screenshot larger than ${MAX_SCREENSHOT_BYTES} bytes` })
  const kind = imageKind(buf)
  if (!kind) return json(res, 415, { error: 'Screenshot must be PNG or JPEG' })

  fs.mkdirSync(screenshotsDir, { recursive: true })
  const filename = `${randomUUID()}${kind.ext}`
  await fs.promises.writeFile(path.join(screenshotsDir, filename), buf)
  // **Re-read after the awaits, with nothing awaited between the read and the update.** Two uploads for one
  // flow (a retry) both read the same old name before their bodies arrived, and a run deleted with its build
  // meanwhile updates no row. Either way a file no row names would stay forever: nothing sweeps this
  // directory, so a file kept here outlives the run it was "deleted with".
  const before = current.get(run.seq, Number(params.idx)) as { screenshot_file: string | null } | undefined
  const updated = getDb().prepare('UPDATE flow_run_flows SET screenshot_file = ?, screenshot_mime = ? WHERE run_seq = ? AND idx = ?')
    .run(filename, kind.mime, run.seq, Number(params.idx))
  if (updated.changes === 0) {
    unlinkSafe(path.join(screenshotsDir, filename), 'run screenshot')
    return json(res, 404, { error: 'Run not found' })
  }
  if (before?.screenshot_file) unlinkSafe(path.join(screenshotsDir, before.screenshot_file), 'run screenshot')
  json(res, 200, { ok: true })
}

/**
 * What the run's device was reset of. `requested` is what the run asked at creation; `cold` and `report` are what its
 * boot answered, sent right after the boot so a run that fails to install, is cancelled or loses its runner keeps it.
 */
interface DeviceReset {
  requested: boolean
  /** The boot answered and the runner said so. Absent: the run never reached a device (every flow skipped, no device,
   *  a boot that failed or timed out), which is not the same as a reset nobody confirmed. */
  booted?: true
  cold?: boolean
  report?: RunResetReport
  /** Each device the run booted, from a runner that names its session. The fields above stay the first device's, so a
   *  reader that knows only them reads one real device rather than a mix of several. */
  devices?: RunDevice[]
}

interface RunDevice {
  sessionId: string
  deviceId?: string
  deviceName?: string
  cold?: boolean
  report?: RunResetReport
}

export async function handleReportDevice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const body = await readJsonBody(req, res)
  if (!body) return
  // A field that cannot be read is dropped rather than refused, as the create's are: recording never fails a run.
  const report = readRunResetReport(body.runReset)
  const cold = typeof body.cold === 'boolean' ? { cold: body.cold } : {}
  const sessionId = str(body.sessionId, MAX_NAME)
  const deviceId = str(body.deviceId, MAX_NAME)
  const deviceName = str(body.deviceName, MAX_NAME)
  const db = getDb()
  // **Read inside the write, not from `run`**: that row was read before the body arrived, and the devices of a parallel
  // run report at once, so merging into it would keep whichever report wrote last and lose the others.
  const gone = db.transaction((): boolean => {
    const row = db.prepare('SELECT device_reset_json FROM flow_runs WHERE seq = ?').get(run.seq) as { device_reset_json: string | null } | undefined
    if (!row) return true
    const before = row.device_reset_json ? JSON.parse(row.device_reset_json) as DeviceReset : null
    const devices = [...(before?.devices ?? [])]
    if (sessionId !== null) {
      const device: RunDevice = {
        sessionId, ...(deviceId !== null ? { deviceId } : {}), ...(deviceName !== null ? { deviceName } : {}), ...cold, ...(report ? { report } : {}),
      }
      const at = devices.findIndex((d) => d.sessionId === sessionId)
      if (at >= 0) devices[at] = device
      else devices.push(device)
    }
    const first = sessionId === null || devices[0]?.sessionId === sessionId
    const next: DeviceReset = first
      ? { requested: before?.requested ?? false, booted: true, ...cold, ...(report ? { report } : {}), ...(devices.length > 0 ? { devices } : {}) }
      : { ...before!, devices }
    db.prepare(`UPDATE flow_runs SET device_reset_json = ?, last_activity_at = datetime('now') WHERE seq = ?`).run(JSON.stringify(next), run.seq)
    return false
  })()
  if (gone) return json(res, 404, { error: 'Run not found' })
  json(res, 200, { ok: true })
}

const FINAL_STATUSES = new Set(['passed', 'failed', 'aborted'])

export async function handleFinishRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const body = await readJsonBody(req, res)
  if (!body) return
  if (typeof body.status !== 'string' || !FINAL_STATUSES.has(body.status)) {
    return json(res, 400, { error: 'status must be passed, failed or aborted' })
  }
  const exitCode = nonNegInt(body.exitCode)
  if (exitCode === null) return json(res, 400, { error: 'exitCode must be a non-negative integer' })
  // A run the relay closed as `holder-lost` is still finished here: after a relay restart the CLI is alive,
  // reports its own outcome, and knows it better than the relay's guess.
  // The state is checked in the update itself, not only in `ownRun`: two finishes (a retry after a timeout) can
  // both pass that check while their bodies arrive, and the second would overwrite the first.
  const db = getDb()
  const updated = db.prepare(`
    UPDATE flow_runs
       SET status = ?, finished_by = 'client', exit_code = ?, failure_kind = ?, error_message = ?,
           finished_at = datetime('now'), last_activity_at = datetime('now')
     WHERE seq = ? AND (finished_by IS NULL OR finished_by = 'relay')
  `).run(body.status, exitCode, str(body.failureKind, 50), str(body.errorMessage, MAX_MESSAGE), run.seq)
  if (updated.changes === 0) {
    return db.prepare('SELECT 1 FROM flow_runs WHERE seq = ?').get(run.seq)
      ? json(res, 409, { error: 'Run already finished' })
      : json(res, 404, { error: 'Run not found' })
  }
  startedFlows.delete(run.id)
  json(res, 200, { ok: true })
}

// ── reads (anyone who may view) ─────────────────────────────────────────────

interface BuildSummary { id: number; appName: string | null; versionName: string | null; buildNumber: string | null; platform: string | null }

function buildSummary(buildId: number | null): BuildSummary | null {
  if (buildId === null) return null
  const b = getDb().prepare(`
    SELECT b.id, ap.name AS app_name, b.version_name, b.build_number, ap.platform
      FROM builds_effective b LEFT JOIN apps ap ON ap.id = b.app_id WHERE b.id = ?
  `).get(buildId) as { id: number; app_name: string | null; version_name: string | null; build_number: string | null; platform: string | null } | undefined
  if (!b) return null
  return { id: b.id, appName: b.app_name, versionName: b.version_name, buildNumber: b.build_number, platform: b.platform }
}

function creatorName(userId: number | null): string | null {
  if (userId === null) return null
  const u = getDb().prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId) as
    { email: string; display_name: string | null } | undefined
  if (!u) return null
  return u.display_name ?? u.email.split('@')[0]
}

function runSummary(run: RunRow) {
  return {
    id: run.id,
    status: run.status,
    finishedBy: run.finished_by,
    failureKind: run.failure_kind,
    errorMessage: run.error_message,
    exitCode: run.exit_code,
    isCi: run.is_ci === 1,
    ci: run.is_ci === 1
      ? { provider: run.ci_provider, branch: run.ci_branch, commit: run.ci_commit, jobUrl: run.ci_job_url }
      : null,
    serviceTier: run.service_tier_json ? JSON.parse(run.service_tier_json) as ServiceTier : null,
    deviceReset: run.device_reset_json ? JSON.parse(run.device_reset_json) as DeviceReset : null,
    build: buildSummary(run.build_id),
    createdBy: creatorName(run.created_by),
    flowsTotal: run.flows_total,
    createdAt: run.created_at,
    finishedAt: run.finished_at,
  }
}

export function handleListRuns(req: http.IncomingMessage, res: http.ServerResponse, holders: RunHolders): void {
  if (!requireViewAuth(req, res)) return
  settleOrphanedRuns(holders)

  const q = new URL(req.url ?? '/', 'http://x').searchParams
  const where: string[] = []
  const args: (string | number)[] = []
  // A number that is not an id is refused rather than read: `build=abc` would match nothing, and a malformed cursor
  // would quietly answer the newest page — a valid-looking reply holding the wrong runs. An empty value is "none".
  // **The text is checked, not `Number(text)`**, which reads " " as 0, "0x10" as 16 and "1e2" as 100 — and then the
  // number too, since a long enough run of digits becomes Infinity or loses its last digits.
  const ids: Partial<Record<'build' | 'before' | 'after', number>> = {}
  for (const key of ['build', 'before', 'after'] as const) {
    const v = q.get(key)
    if (!v) continue
    const id = Number(v)
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(id)) return json(res, 400, { error: `${key} must be a non-negative integer` })
    ids[key] = id
  }
  if (ids.build !== undefined) { where.push('r.build_id = ?'); args.push(ids.build) }
  const status = q.get('status')
  if (status !== null) { where.push('r.status = ?'); args.push(status) }
  const ci = q.get('ci')
  if (ci === '1' || ci === '0') { where.push('r.is_ci = ?'); args.push(Number(ci)) }
  const flow = q.get('flow')
  if (flow !== null) {
    // The planned list, not the reported rows: a run that never reached the flow still ran with it. A part of the
    // name, as the runs page searches as you type. SQLite's `lower` folds ASCII only, so "Über" is still
    // case-sensitive; Hangul has no case.
    where.push(`EXISTS (SELECT 1 FROM json_each(r.flows_json) j WHERE instr(lower(json_extract(j.value, '$.name')), lower(?)) > 0)`)
    args.push(flow)
  }
  const limitParam = Number(q.get('limit'))
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, PAGE_MAX) : PAGE_DEFAULT

  // Pages by cursor in both directions: `before` for the page of older runs, `after` for newer ones. Not by number,
  // because new runs keep arriving on top and a page number would slide. `after` reads upward from the cursor and
  // is turned back to newest first, so it is the page directly above the one it came from.
  const filtered = (extra: string | null) => [...where, ...(extra ? [extra] : [])]
  const sql = (conds: string[], order: 'ASC' | 'DESC') => `
    SELECT r.*,
           (SELECT COUNT(*) FROM flow_run_flows f WHERE f.run_seq = r.seq AND f.status = 'passed') AS flows_passed,
           (SELECT COUNT(*) FROM flow_run_flows f WHERE f.run_seq = r.seq AND f.status = 'failed') AS flows_failed,
           (SELECT COUNT(*) FROM flow_run_flows f WHERE f.run_seq = r.seq AND f.status = 'skipped') AS flows_skipped
      FROM flow_runs r
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY r.seq ${order}
     LIMIT ?`
  type Row = RunRow & { flows_passed: number; flows_failed: number; flows_skipped: number }
  const db = getDb()
  const { before, after } = ids
  const page = after !== undefined
    ? (db.prepare(sql(filtered('r.seq > ?'), 'ASC')).all(...args, after, limit) as Row[]).reverse()
    : before !== undefined
      ? db.prepare(sql(filtered('r.seq < ?'), 'DESC')).all(...args, before, limit) as Row[]
      : db.prepare(sql(filtered(null), 'DESC')).all(...args, limit) as Row[]

  // A cursor only where a page exists past it, so the page's Newer and Older are offered only when they lead somewhere.
  const exists = (cond: string, seq: number) => Boolean(
    db.prepare(`SELECT 1 FROM flow_runs r WHERE ${filtered(cond).join(' AND ')} LIMIT 1`).get(...args, seq),
  )
  const first = page[0]
  const last = page[page.length - 1]
  json(res, 200, {
    items: page.map((r) => ({ ...runSummary(r), flowsPassed: r.flows_passed, flowsFailed: r.flows_failed, flowsSkipped: r.flows_skipped })),
    nextCursor: last && exists('r.seq < ?', last.seq) ? String(last.seq) : null,
    prevCursor: first && exists('r.seq > ?', first.seq) ? String(first.seq) : null,
  })
}

export function handleGetRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  holders: RunHolders,
  videosOf: (run: RunRow) => Map<number, unknown> = () => new Map(),
): void {
  if (!requireViewAuth(req, res)) return
  settleOrphanedRuns(holders)
  const run = findRun(params.id)
  if (!run) return json(res, 404, { error: 'Run not found' })
  const videos = videosOf(run)

  const reported = new Map(
    (getDb().prepare('SELECT * FROM flow_run_flows WHERE run_seq = ? ORDER BY idx').all(run.seq) as FlowRow[])
      .map((f) => [f.idx, f]),
  )
  const planned = JSON.parse(run.flows_json) as { name: string; file: string | null }[]
  const firstUnreported = planned.findIndex((_, i) => !reported.has(i))
  if (run.status !== 'running') startedFlows.delete(run.id)
  const started = startedFlows.get(run.id)
  const flows = planned.map((p, idx) => {
    const f = reported.get(idx)
    if (!f) {
      if (run.status !== 'running') return { idx, name: p.name, file: p.file, status: 'not-run', video: videos.get(idx) ?? null }
      // A runner that reports starts says which flows are on a device. One that predates them leaves a guess: the
      // first unreported flow is the one running, which holds while a run replays its flows one at a time.
      const on = started?.get(idx)
      if (on) {
        const device = { id: on.deviceId, name: on.deviceName, sessionId: on.sessionId }
        return { idx, name: p.name, file: p.file, status: 'running', device, video: videos.get(idx) ?? null }
      }
      const status = !started && idx === firstUnreported ? 'running' : 'pending'
      return { idx, name: p.name, file: p.file, status, video: videos.get(idx) ?? null }
    }
    // A skipped flow never ran, so it has no device, steps, duration or screen to report.
    if (f.status === 'skipped') {
      return { idx, name: f.name, file: f.file, status: f.status, skipReason: f.skip_reason, failureMessage: f.failure_message, video: videos.get(idx) ?? null }
    }
    return {
      idx, name: f.name, file: f.file, status: f.status,
      device: f.device_id ? { id: f.device_id, name: f.device_name, platform: f.platform } : null,
      failureKind: f.failure_kind, failureMessage: f.failure_message, durationMs: f.duration_ms,
      steps: JSON.parse(f.steps_json) as unknown[],
      hasScreenshot: f.screenshot_file !== null,
      video: videos.get(idx) ?? null,
    }
  })

  // The session to watch is the one the holder holds **now**, never a stored one: session ids outlive runs,
  // so a stored id would open whoever took the device next.
  const watchSessionIds = run.status === 'running' ? holders.heldSessions(holderKeys(run.created_by, run.holder_client)) : []
  json(res, 200, { ...runSummary(run), flows, watchSessionId: watchSessionIds[0] ?? null, watchSessionIds })
}

export function handleGetFlowScreenshot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  screenshotsDir: string,
): void {
  if (!requireViewAuth(req, res)) return
  const row = getDb().prepare(`
    SELECT f.screenshot_file, f.screenshot_mime FROM flow_run_flows f JOIN flow_runs r ON r.seq = f.run_seq
     WHERE r.id = ? AND f.idx = ?
  `).get(params.id, Number(params.idx)) as { screenshot_file: string | null; screenshot_mime: string | null } | undefined
  if (!row?.screenshot_file) return json(res, 404, { error: 'No screenshot' })
  let data: Buffer
  try {
    data = fs.readFileSync(path.join(screenshotsDir, row.screenshot_file))
  } catch {
    return json(res, 404, { error: 'No screenshot' })
  }
  res.writeHead(200, {
    'Content-Type': row.screenshot_mime ?? 'image/png',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  })
  res.end(data)
}

// ── retention ───────────────────────────────────────────────────────────────

/** Runs with no build, past their own expiry. A build's runs go with the build (`deleteBuildsWithDependents`). */
export function purgeExpiredRuns(screenshotsDir: string, videosDir: string, holders: RunHolders): void {
  settleOrphanedRuns(holders)
  const db = getDb()
  forgetStartedFlowsOfStoppedRuns()
  const expired = db.prepare(`
    SELECT seq FROM flow_runs WHERE build_id IS NULL AND delete_after IS NOT NULL AND delete_after < datetime('now')
  `).all() as { seq: number }[]
  if (expired.length === 0) return
  const files: string[] = []
  const videos: string[] = []
  db.transaction(() => {
    const shots = db.prepare('SELECT screenshot_file FROM flow_run_flows WHERE run_seq = ? AND screenshot_file IS NOT NULL')
    // Evicted videos have no file left; their rows go with the run (ON DELETE CASCADE).
    const vids = db.prepare('SELECT file FROM flow_run_videos WHERE run_seq = ? AND evicted_at IS NULL')
    const del = db.prepare('DELETE FROM flow_runs WHERE seq = ?')
    for (const { seq } of expired) {
      for (const s of shots.all(seq) as { screenshot_file: string }[]) files.push(s.screenshot_file)
      for (const v of vids.all(seq) as { file: string }[]) videos.push(v.file)
      del.run(seq)
    }
  })()
  for (const f of files) unlinkSafe(path.join(screenshotsDir, f), 'run screenshot')
  for (const f of videos) unlinkSafe(path.join(videosDir, f), 'run video')
}
