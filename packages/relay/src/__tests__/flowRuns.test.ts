import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered, SessionJoined } from '@tapflowio/protocol'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { signJwt, hashPat } from '../middleware/auth'
import { purgeExpiredBuilds } from '../api/builds'

// Run records written by `tapflow flow run` (A3). The CLI writes with its `builds:write` token; anyone who
// may view reads. The cases are the plan's table: who may write, what liveness means, and that a run's
// files go wherever its build or its own expiry takes it.

const PAT_CI = 'tflw_pat_runs_ci'
const PAT_CI_OTHER = 'tflw_pat_runs_ci_other'
const PAT_VIEW = 'tflw_pat_runs_view'
const PAT_SOMEONE = 'tflw_pat_runs_someone'
const PAT_VIEWER_ROLE = 'tflw_pat_runs_viewer_role'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])

/** The fields these tests read, across the run, list and error answers. */
interface Body {
  id: string
  status: string
  isCi: boolean
  createdBy: string | null
  ci: { jobUrl: string | null } | null
  build: unknown
  flows: { name: string; status: string; hasScreenshot?: boolean; steps?: object[] }[]
  watchSessionId: string | null
  items: { id: string }[]
  nextCursor: string | null
}

const bearer = (pat: string) => ({ Authorization: `Bearer ${pat}` })
const cookie = () => ({ cookie: `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.test', role: 'Admin' })}` })

describe('flow run records', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let shotsDir: string
  let buildId: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-runs-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    const user = db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)')
    user.run(1, 'admin@example.test', 'Admin', 'x')
    user.run(2, 'ci@example.test', 'Developer', 'x')
    user.run(3, 'someone@example.test', 'Developer', 'x')
    user.run(4, 'viewer@example.test', 'Viewer', 'x')
    const pat = db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
    pat.run(2, 'ci', hashPat(PAT_CI), 'view,builds:write')
    pat.run(2, 'ci-other', hashPat(PAT_CI_OTHER), 'view,builds:write')
    pat.run(2, 'view', hashPat(PAT_VIEW), 'view')
    pat.run(3, 'someone', hashPat(PAT_SOMEONE), 'view,builds:write')
    pat.run(4, 'viewer', hashPat(PAT_VIEWER_ROLE), 'view,builds:write')
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    uploadsDir = path.join(fs.mkdtempSync(path.join(tmpDir, 'install-')), 'uploads')
    fs.mkdirSync(path.join(uploadsDir, 'builds'), { recursive: true })
    shotsDir = path.join(uploadsDir, '../run-screenshots')
    const db = getDb()
    db.exec('DELETE FROM flow_runs; DELETE FROM recordings; DELETE FROM builds; DELETE FROM apps')
    db.prepare(`INSERT INTO apps (id, name, bundle_id_key, platform) VALUES (1, 'Coffee', 'com.example.coffee', 'ios')`).run()
    const file = path.join(uploadsDir, 'builds', 'coffee.zip')
    fs.writeFileSync(file, 'zip')
    buildId = Number(db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path) VALUES (1, '1.0.0', '7', 'com.example.coffee', ?)
    `).run(file).lastInsertRowid)
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  async function call(method: string, url: string, headers: Record<string, string>, body?: unknown) {
    const raw = Buffer.isBuffer(body) ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, body: raw, headers: { ...(typeof raw === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const isJson = res.headers.get('content-type')?.includes('json')
    return { status: res.status, headers: res.headers, buf, body: (isJson ? JSON.parse(buf.toString()) : null) as Body }
  }

  async function create(extra: Record<string, unknown> = {}, pat = PAT_CI): Promise<string> {
    const r = await call('POST', '/api/v1/runs', bearer(pat), {
      client: 'runner-1', buildId, flows: [{ name: 'login', file: 'flows/login.yaml' }, { name: 'checkout' }], ...extra,
    })
    expect(r.status).toBe(201)
    return r.body.id
  }

  const passed = { status: 'passed', durationMs: 1200, steps: [{ index: 0, name: 'tap Login', status: 'passed', durationMs: 300 }] }

  /** The runner's socket, as `RelayClient` opens it. Loopback, so the relay keys it `anon:<client>`. */
  async function runnerSocket(client = 'runner-1') {
    const ws = new WebSocket(`ws://localhost:${port}/?client=${client}`, { headers: bearer(PAT_CI) })
    await waitForOpen(ws)
    return ws
  }

  async function closed(ws: WebSocket) {
    await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close() })
    // The relay's own close handler runs on its side of the socket; give it the turn.
    await new Promise((r) => setTimeout(r, 50))
  }

  // ── who may write ─────────────────────────────────────────────────────────

  it('creates a run with builds:write and lists the planned flows', async () => {
    const id = await create()
    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('running')
    expect(r.body.build).toMatchObject({ id: buildId, appName: 'Coffee', buildNumber: '7' })
    expect(r.body.flows.map((f: { name: string; status: string }) => [f.name, f.status]))
      .toEqual([['login', 'running'], ['checkout', 'pending']])
    expect(r.body.createdBy).toBe('ci')
  })

  it('refuses to create without builds:write, without credentials, or for a Viewer', async () => {
    const body = { client: 'c', flows: [] }
    expect((await call('POST', '/api/v1/runs', bearer(PAT_VIEW), body)).status).toBe(403)
    expect((await call('POST', '/api/v1/runs', {}, body)).status).toBe(401)
    expect((await call('POST', '/api/v1/runs', bearer(PAT_VIEWER_ROLE), body)).status).toBe(403)
  })

  it('refuses a build id that names no build, and a missing client', async () => {
    expect((await call('POST', '/api/v1/runs', bearer(PAT_CI), { client: 'c', buildId: 9999, flows: [] })).status).toBe(400)
    expect((await call('POST', '/api/v1/runs', bearer(PAT_CI), { flows: [] })).status).toBe(400)
  })

  it('lets only the creating token write: not another user, not another token of the same user', async () => {
    const id = await create()
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_SOMEONE), passed)).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI_OTHER), passed)).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_SOMEONE), { status: 'passed', exitCode: 0 })).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)).status).toBe(200)
  })

  it('binds a run created with a cookie to its user, whichever credential comes next', async () => {
    const r = await call('POST', '/api/v1/runs', cookie(), { client: 'c', flows: [{ name: 'login' }] })
    expect(r.status).toBe(201)
    expect((await call('POST', `/api/v1/runs/${r.body.id}/flows/0`, bearer(PAT_SOMEONE), passed)).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${r.body.id}/flows/0`, cookie(), passed)).status).toBe(200)
  })

  it('refuses a flow index outside the plan and a malformed report', async () => {
    const id = await create()
    expect((await call('POST', `/api/v1/runs/${id}/flows/2`, bearer(PAT_CI), passed)).status).toBe(404)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { ...passed, status: 'maybe' })).status).toBe(400)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { ...passed, steps: [{ status: 'nope' }] })).status).toBe(400)
  })

  it('refuses a JSON body over 1 MB with 413', async () => {
    const id = await create()
    const huge = { ...passed, failureMessage: 'x'.repeat(1024 * 1024 + 1) }
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), huge)).status).toBe(413)
  })

  it('keeps only an http(s) job URL', async () => {
    const bad = await create({ ci: { provider: 'github', jobUrl: 'javascript:alert(1)' } })
    expect((await call('GET', `/api/v1/runs/${bad}`, bearer(PAT_VIEW))).body.ci?.jobUrl).toBeNull()
    const good = await create({ ci: { provider: 'github', jobUrl: 'https://github.com/o/r/actions/runs/1', branch: 'main', commit: 'abc' } })
    const r = await call('GET', `/api/v1/runs/${good}`, bearer(PAT_VIEW))
    expect(r.body.isCi).toBe(true)
    expect(r.body.ci).toEqual({ provider: 'github', branch: 'main', commit: 'abc', jobUrl: 'https://github.com/o/r/actions/runs/1' })
  })

  // ── results ───────────────────────────────────────────────────────────────

  it('records a failed flow, finishes, and marks the flow never reached as not run', async () => {
    const id = await create()
    const failed = {
      status: 'failed', failureKind: 'product', failureMessage: 'no element "Pay"', durationMs: 900,
      deviceId: 'dev0', deviceName: 'iPhone 16', platform: 'ios',
      steps: [{ index: 0, name: 'tap Pay', status: 'failed', durationMs: 900, message: 'no element "Pay"', extra: 'dropped' }],
    }
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), failed)).status).toBe(200)
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'failed', exitCode: 1 })).status).toBe(200)

    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    expect(r.body).toMatchObject({ status: 'failed', exitCode: 1, finishedBy: 'client' })
    expect(r.body.flows[0]).toMatchObject({
      status: 'failed', failureKind: 'product', device: { id: 'dev0', name: 'iPhone 16', platform: 'ios' },
      steps: [{ index: 0, name: 'tap Pay', status: 'failed', durationMs: 900, message: 'no element "Pay"' }],
    })
    expect(r.body.flows[0].steps?.[0]).not.toHaveProperty('extra')
    expect(r.body.flows[1]).toMatchObject({ name: 'checkout', status: 'not-run' })
  })

  it('refuses writes after the runner finished the run', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)).status).toBe(409)
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'failed', exitCode: 1 })).status).toBe(409)
  })

  it('records a run-level environment failure before any flow', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), {
      status: 'failed', exitCode: 2, failureKind: 'environment', errorMessage: 'no free iOS device',
    })
    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    expect(r.body).toMatchObject({ status: 'failed', exitCode: 2, failureKind: 'environment', errorMessage: 'no free iOS device' })
    expect(r.body.flows.every((f: { status: string }) => f.status === 'not-run')).toBe(true)
  })

  // ── screenshots ───────────────────────────────────────────────────────────

  it('stores a PNG screenshot and serves it back as image/png with nosniff', async () => {
    const id = await create()
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)).status).toBe(404)
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)).status).toBe(200)

    const r = await call('GET', `/api/v1/runs/${id}/flows/0/screenshot`, cookie())
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.buf.equals(PNG)).toBe(true)
    expect((await call('GET', `/api/v1/runs/${id}`, cookie())).body.flows[0].hasScreenshot).toBe(true)
  })

  it('replaces a screenshot and removes the file it replaced', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)
    expect(fs.readdirSync(shotsDir)).toHaveLength(1)
    await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)
    expect(fs.readdirSync(shotsDir)).toHaveLength(1)
  })

  it('keeps one file when two uploads for the same flow overlap', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    const up = () => call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)
    const answers = await Promise.all([up(), up(), up()])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    const files = fs.readdirSync(shotsDir)
    expect(files).toHaveLength(1)
    const row = getDb().prepare('SELECT screenshot_file FROM flow_run_flows').get() as { screenshot_file: string }
    expect(row.screenshot_file).toBe(files[0])
  })

  /** Send the headers, run `between` once the relay has authorized the request, then the body. */
  function sendLate(url: string, body: Buffer, between: () => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method: 'POST', headers: { ...bearer(PAT_CI), 'Content-Length': body.length } },
        (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject)
      req.flushHeaders()
      // The handler authorizes on the headers and then waits for the body; give it the turn to get there.
      setTimeout(() => { between(); req.end(body) }, 100)
    })
  }

  it('answers 404 and keeps no file when the run goes while a screenshot is arriving', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    const status = await sendLate(`/api/v1/runs/${id}/flows/0/screenshot`, PNG, () => {
      getDb().prepare('DELETE FROM flow_runs WHERE id = ?').run(id)
    })
    expect(status).toBe(404)
    expect(fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : []).toHaveLength(0)
  })

  it('answers 404 when the run goes while a flow report is arriving', async () => {
    const id = await create()
    const status = await sendLate(`/api/v1/runs/${id}/flows/0`, Buffer.from(JSON.stringify(passed)), () => {
      getDb().prepare('DELETE FROM flow_runs WHERE id = ?').run(id)
    })
    expect(status).toBe(404)
  })

  it('refuses a screenshot that is not an image, or over 5 MB', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), Buffer.from('<script>'))).status).toBe(415)
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), big)).status).toBe(413)
    expect(fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : []).toHaveLength(0)
  })

  // ── liveness ──────────────────────────────────────────────────────────────

  it('aborts a running run when its runner socket closes, and not while one is still open', async () => {
    const first = await runnerSocket()
    const second = await runnerSocket()
    const id = await create()
    await closed(first)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('running')
    await closed(second)
    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    expect(r.body).toMatchObject({ status: 'aborted', finishedBy: 'relay', failureKind: 'holder-lost' })
  })

  it('leaves a run alone when a socket of another runner closes', async () => {
    await runnerSocket()
    const other = await runnerSocket('runner-2')
    const id = await create()
    await closed(other)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('running')
  })

  it('lets the runner finish a run the relay closed as holder-lost', async () => {
    const ws = await runnerSocket()
    const id = await create()
    await closed(ws)
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'failed', exitCode: 2 })).status).toBe(200)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body).toMatchObject({ status: 'failed', finishedBy: 'client' })
  })

  it('closes an orphaned run on read once it is quiet past the grace, and not before', async () => {
    const id = await create()
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('running')
    getDb().prepare(`UPDATE flow_runs SET last_activity_at = datetime('now', '-2 minutes') WHERE id = ?`).run(id)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('aborted')
  })

  it('keeps a quiet run running while its runner is connected', async () => {
    await runnerSocket()
    const id = await create()
    getDb().prepare(`UPDATE flow_runs SET last_activity_at = datetime('now', '-2 minutes') WHERE id = ?`).run(id)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('running')
  })

  it('offers the session the runner holds now to watch, and nothing once the run is over', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'mac',
      devices: [{ id: 'dev0', name: 'iPhone', platform: 'ios', status: 'shutdown' }],
    }))
    const sessionId = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions[0]!.sessionId

    const ws = await runnerSocket()
    const id = await create()
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.watchSessionId).toBeNull()
    ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'flow-runner' }))
    await waitForType<SessionJoined>(ws, 'session:joined')
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.watchSessionId).toBe(sessionId)

    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.watchSessionId).toBeNull()
    agent.close()
  })

  // ── list ──────────────────────────────────────────────────────────────────

  it('filters by build, status, CI and flow name, newest first, and pages', async () => {
    const local = await create()
    const ci = await create({ ci: { provider: 'github' }, flows: [{ name: 'onboarding' }] })
    const buildless = await create({ buildId: undefined })
    await call('POST', `/api/v1/runs/${local}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })

    const ids = async (q: string) =>
      (await call('GET', `/api/v1/runs${q}`, bearer(PAT_VIEW))).body.items.map((i: { id: string }) => i.id)
    expect(await ids('')).toEqual([buildless, ci, local])
    expect(await ids(`?build=${buildId}`)).toEqual([ci, local])
    expect(await ids('?status=passed')).toEqual([local])
    expect(await ids('?ci=1')).toEqual([ci])
    expect(await ids('?ci=0')).toEqual([buildless, local])
    expect(await ids('?flow=onboarding')).toEqual([ci])

    const first = await call('GET', '/api/v1/runs?limit=2', bearer(PAT_VIEW))
    expect(first.body.items).toHaveLength(2)
    const rest = await call('GET', `/api/v1/runs?limit=2&before=${first.body.nextCursor}`, bearer(PAT_VIEW))
    expect(rest.body.items.map((i: { id: string }) => i.id)).toEqual([local])
    expect(rest.body.nextCursor).toBeNull()
  })

  it('needs a view credential to read', async () => {
    expect((await call('GET', '/api/v1/runs', {})).status).toBe(401)
    expect((await call('GET', '/api/v1/runs', bearer(PAT_VIEWER_ROLE))).status).toBe(200)
  })

  // ── retention ─────────────────────────────────────────────────────────────

  async function runWithScreenshot(extra: Record<string, unknown> = {}) {
    const id = await create(extra)
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)
    return id
  }

  it('purges a build with its runs and their screenshots', async () => {
    const id = await runWithScreenshot()
    getDb().prepare(`UPDATE builds SET delete_after = datetime('now', '-1 hour') WHERE id = ?`).run(buildId)
    purgeExpiredBuilds({ uploadsDir, recordingsDir: path.join(uploadsDir, '../recordings'), runScreenshotsDir: shotsDir })
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).status).toBe(404)
    expect(fs.readdirSync(shotsDir)).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM flow_run_flows').get()).toEqual({ n: 0 })
  })

  it('deletes an app that has runs and recordings, with every file they kept', async () => {
    await runWithScreenshot()
    const recordingsDir = path.join(uploadsDir, '../recordings')
    fs.mkdirSync(recordingsDir, { recursive: true })
    fs.writeFileSync(path.join(recordingsDir, 'rec.webm'), 'webm')
    getDb().prepare(`
      INSERT INTO recordings (filename, build_id, file_size, mime, expires_at) VALUES ('rec.webm', ?, 4, 'video/webm', datetime('now', '+1 day'))
    `).run(buildId)

    const r = await call('DELETE', '/api/v1/apps/1', cookie())
    expect(r.status).toBe(200)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM builds').get()).toEqual({ n: 0 })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM flow_runs').get()).toEqual({ n: 0 })
    expect(fs.readdirSync(shotsDir)).toHaveLength(0)
    expect(fs.existsSync(path.join(recordingsDir, 'rec.webm'))).toBe(false)
    expect(fs.existsSync(path.join(uploadsDir, 'builds', 'coffee.zip'))).toBe(false)
  })

  it('answers 404 for deleting an app that does not exist', async () => {
    expect((await call('DELETE', '/api/v1/apps/999', cookie())).status).toBe(404)
  })

  it('expires a run with no build after its own seven days, and keeps a newer one', async () => {
    const old = await runWithScreenshot({ buildId: undefined })
    const fresh = await create({ buildId: undefined })
    const row = getDb().prepare('SELECT delete_after FROM flow_runs WHERE id = ?').get(fresh) as { delete_after: string }
    expect(Date.parse(`${row.delete_after}Z`) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000)
    getDb().prepare(`UPDATE flow_runs SET delete_after = datetime('now', '-1 minute') WHERE id = ?`).run(old)
    getDb().prepare(`UPDATE builds SET delete_after = datetime('now', '-1 minute')`).run()

    // The daily tick: restarting runs it at start.
    await server.stop()
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port

    expect((await call('GET', `/api/v1/runs/${old}`, bearer(PAT_VIEW))).status).toBe(404)
    expect((await call('GET', `/api/v1/runs/${fresh}`, bearer(PAT_VIEW))).status).toBe(200)
    expect(fs.readdirSync(shotsDir)).toHaveLength(0)
  })
})
