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
import { forgetStartedFlowsOfStoppedRuns, startedFlowRunCount } from '../api/runs'

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
  serviceTier: unknown
  deviceReset: unknown
  build: unknown
  flows: { name: string; status: string; hasScreenshot?: boolean; steps?: object[]; skipReason?: string; device?: unknown }[]
  watchSessionId: string | null
  watchSessionIds: string[]
  items: { id: string; flowsSkipped?: number }[]
  nextCursor: string | null
  prevCursor: string | null
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
    db.prepare(`INSERT INTO apps (id, name, platform) VALUES (1, 'Coffee', 'ios')`).run()
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

  it('keeps the service tier the run asked for, and drops one that is not a tier', async () => {
    const tiered = await create({ serviceTier: { name: 'slim', keep: ['push'] } })
    expect((await call('GET', `/api/v1/runs/${tiered}`, bearer(PAT_VIEW))).body.serviceTier).toEqual({ name: 'slim', keep: ['push'] })
    const bogus = await create({ serviceTier: { name: 'turbo', keep: [] } })
    expect((await call('GET', `/api/v1/runs/${bogus}`, bearer(PAT_VIEW))).body.serviceTier).toBeNull()
    const none = await create({})
    expect((await call('GET', `/api/v1/runs/${none}`, bearer(PAT_VIEW))).body.serviceTier).toBeNull()
  })

  it('records the reset a run asked for, then what its boot answered, and drops a report it cannot read', async () => {
    const get = async (id: string) => (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.deviceReset
    const asked = await create({ resetRequested: true })
    expect(await get(asked)).toEqual({ requested: true })
    const report = { done: ['app-uninstall', 'keychain'], failed: ['location'] }
    expect((await call('POST', `/api/v1/runs/${asked}/device`, bearer(PAT_CI), { cold: false, runReset: report })).status).toBe(200)
    expect(await get(asked)).toEqual({ requested: true, booted: true, cold: false, report })

    // Asked, and the boot said nothing about it: an agent or relay too old to reset. Kept apart from "not asked".
    const unconfirmed = await create({ resetRequested: true })
    await call('POST', `/api/v1/runs/${unconfirmed}/device`, bearer(PAT_CI), { cold: true, runReset: { done: 'all' } })
    expect(await get(unconfirmed)).toEqual({ requested: true, booted: true, cold: true })

    const declined = await create({ resetRequested: false })
    await call('POST', `/api/v1/runs/${declined}/device`, bearer(PAT_CI), { cold: false })
    expect(await get(declined)).toEqual({ requested: false, booted: true, cold: false })

    expect(await get(await create({}))).toBeNull()
  })

  it('lets only the run\'s own runner report its device, and not after it finished', async () => {
    const id = await create({ resetRequested: true })
    expect((await call('POST', `/api/v1/runs/${id}/device`, bearer(PAT_SOMEONE), { cold: false })).status).toBe(403)
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await call('POST', `/api/v1/runs/${id}/device`, bearer(PAT_CI), { cold: false })).status).toBe(409)
  })

  // A parallel run's devices report at once, each naming its session; none may overwrite another's.
  it('keeps each device a run booted, by session, with the first one\'s account at the top', async () => {
    const id = await create({ resetRequested: true })
    const a = { done: ['app-uninstall'], failed: [] }
    const b = { done: ['app-uninstall'], failed: ['location'] }
    // A's body arrives after B's report is written: A must merge into the row as B left it, not as it was when A
    // was authorized.
    const late = sendLate(`/api/v1/runs/${id}/device`, Buffer.from(JSON.stringify({ sessionId: 's-a', deviceId: 'dev-a', deviceName: 'iPhone A', cold: true, runReset: a })), () => {})
    await new Promise((r) => setTimeout(r, 30))
    expect((await call('POST', `/api/v1/runs/${id}/device`, bearer(PAT_CI), { sessionId: 's-b', deviceName: 'iPhone B', cold: false, runReset: b })).status).toBe(200)
    expect(await late).toBe(200)
    type Reset = { report: unknown; cold: boolean; devices: object[] }
    const reset = (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.deviceReset as Reset
    expect(reset.devices).toEqual([
      { sessionId: 's-b', deviceName: 'iPhone B', cold: false, report: b },
      { sessionId: 's-a', deviceId: 'dev-a', deviceName: 'iPhone A', cold: true, report: a },
    ])
    expect(reset).toMatchObject({ requested: true, booted: true, cold: false, report: b })

    // A device reporting again replaces its own entry, and leaves the top alone when it is not the first.
    await call('POST', `/api/v1/runs/${id}/device`, bearer(PAT_CI), { sessionId: 's-a', deviceName: 'again', cold: false })
    const after = (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.deviceReset as Reset
    expect(after.devices[1]).toEqual({ sessionId: 's-a', deviceName: 'again', cold: false })
    expect(after).toMatchObject({ cold: false, report: b })
  })

  it('shows the flows the runner says are on a device as running, and no guess once it says so', async () => {
    const id = (await call('POST', '/api/v1/runs', bearer(PAT_CI), {
      client: 'runner-1', flows: [{ name: 'one' }, { name: 'two' }, { name: 'three' }],
    })).body.id
    const flows = async () => (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.flows.map((f) => [f.name, f.status, f.device ?? null])
    expect(await flows()).toEqual([['one', 'running', null], ['two', 'pending', null], ['three', 'pending', null]])

    await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_CI), { sessionId: 's-a', deviceId: 'dev-a', deviceName: 'iPhone A' })
    await call('POST', `/api/v1/runs/${id}/flows/2/start`, bearer(PAT_CI), { sessionId: 's-b', deviceName: 'iPhone B' })
    expect(await flows()).toEqual([
      ['one', 'running', { id: 'dev-a', name: 'iPhone A', sessionId: 's-a' }],
      ['two', 'pending', null],
      ['three', 'running', { id: null, name: 'iPhone B', sessionId: 's-b' }],
    ])

    // Reported: no longer running, and the first unreported flow is not guessed to be.
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    expect((await flows()).slice(1)).toEqual([['two', 'pending', null], ['three', 'running', { id: null, name: 'iPhone B', sessionId: 's-b' }]])
    // A start arriving after the report cannot make the flow running again.
    await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_CI), { sessionId: 's-a' })
    expect((await flows())[0]![1]).toBe('passed')

    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'failed', exitCode: 2 })
    expect((await flows()).map((f) => f[1])).toEqual(['passed', 'not-run', 'not-run'])
  })

  // A run's row can go under it (its build or app deleted) by code that never tells the run records; the daily purge
  // lets go of what such a run had started.
  it('lets go of the started flows of a run deleted while it ran', async () => {
    const before = startedFlowRunCount()
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_CI), { sessionId: 's-a' })
    const live = await create()
    await call('POST', `/api/v1/runs/${live}/flows/0/start`, bearer(PAT_CI), { sessionId: 's-b' })
    expect(startedFlowRunCount()).toBe(before + 2)
    getDb().prepare('DELETE FROM flow_runs WHERE id = ?').run(id)
    forgetStartedFlowsOfStoppedRuns()
    expect(startedFlowRunCount()).toBe(before + 1)
    await call('POST', `/api/v1/runs/${live}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect(startedFlowRunCount()).toBe(before)
  })

  it('takes a flow start only from the run\'s runner, for a flow of the run, naming a session', async () => {
    const id = await create()
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_SOMEONE), { sessionId: 's' })).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${id}/flows/2/start`, bearer(PAT_CI), { sessionId: 's' })).status).toBe(404)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_CI), {})).status).toBe(400)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.flows[0]!.device).toBeUndefined()
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/start`, bearer(PAT_CI), { sessionId: 's' })).status).toBe(409)
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

  // L1: a flow the runner did not replay, and why. Mutations: drop skipped from the status set; drop skip_reason from
  // the upsert's update list; let a passed flow carry a reason.
  it('records a skipped flow with its reason and message, and counts it apart from passed and failed', async () => {
    const id = await create()
    const skipped = { status: 'skipped', skipReason: 'app-mismatch', failureMessage: 'flow is for com.a, build 7 is com.b', durationMs: 0, steps: [] }
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), skipped)).status).toBe(200)
    expect((await call('POST', `/api/v1/runs/${id}/flows/1`, bearer(PAT_CI), passed)).status).toBe(200)

    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    // Only what a flow that never ran has: no device, steps, duration or screenshot.
    expect(r.body.flows[0]).toEqual({
      idx: 0, name: 'login', file: 'flows/login.yaml', status: 'skipped', skipReason: 'app-mismatch',
      failureMessage: 'flow is for com.a, build 7 is com.b', video: null,
    })
    expect(r.body.flows[1]).not.toHaveProperty('skipReason')
    const list = await call('GET', '/api/v1/runs', bearer(PAT_VIEW))
    expect(list.body.items[0]).toMatchObject({ id, flowsPassed: 1, flowsFailed: 0, flowsSkipped: 1, flowsTotal: 2 })
  })

  it('clears the reason when a retried report turns a skipped flow into a run one', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { status: 'skipped', skipReason: 'tag-filter', durationMs: 0, steps: [] })
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)).status).toBe(200)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.flows[0]).toMatchObject({ status: 'passed' })
    expect(getDb().prepare('SELECT skip_reason FROM flow_run_flows WHERE idx = 0').get()).toEqual({ skip_reason: null })
  })

  it('refuses a skip with no reason or an unknown one, and a reason on a flow that ran', async () => {
    const id = await create()
    const url = `/api/v1/runs/${id}/flows/0`
    expect((await call('POST', url, bearer(PAT_CI), { status: 'skipped', durationMs: 0, steps: [] })).status).toBe(400)
    expect((await call('POST', url, bearer(PAT_CI), { status: 'skipped', skipReason: 'bored', durationMs: 0, steps: [] })).status).toBe(400)
    expect((await call('POST', url, bearer(PAT_CI), { ...passed, skipReason: 'tag-filter' })).status).toBe(400)
  })

  it('refuses to turn a flow that ran into a skipped one, so its screenshot is not left behind a skip', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), passed)
    await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { status: 'skipped', skipReason: 'tag-filter', durationMs: 0, steps: [] })).status).toBe(409)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.flows[0]).toMatchObject({ status: 'passed', hasScreenshot: true })
  })

  it('takes a null skipReason on a flow that ran as no reason', async () => {
    const id = await create()
    expect((await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { ...passed, skipReason: null })).status).toBe(200)
  })

  it('refuses a screenshot for a skipped flow', async () => {
    const id = await create()
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { status: 'skipped', skipReason: 'tag-filter', durationMs: 0, steps: [] })
    expect((await call('POST', `/api/v1/runs/${id}/flows/0/screenshot`, bearer(PAT_CI), PNG)).status).toBe(409)
  })

  // B2: a failed tapOn's suggestions are stored whole or not at all — a cut line is a different selector.
  it('keeps a failed step\'s suggestions, at most three, and drops one it would have to cut', async () => {
    const id = await create()
    const ok = (label: string) => ({ yaml: `tapOn: "${label}"`, element: { role: 'button', label } })
    const step = {
      index: 0, name: 'tapOn("Sign inn")', status: 'failed', durationMs: 900, message: 'no element',
      suggestions: [
        ok('Sign in'),
        { yaml: `tapOn: "${'x'.repeat(700)}"`, element: { role: 'button', label: 'x' } },
        { yaml: 'assertVisible: "Sign in"', element: { role: 'button', label: 'Sign in' } },
        { yaml: 'tapOn: { id: "login" }', element: { role: 'button', label: 'Log in', identifier: 'login', extra: 1 } },
        ok('Sign up'), ok('Sign out'),
      ],
    }
    await call('POST', `/api/v1/runs/${id}/flows/0`, bearer(PAT_CI), { status: 'failed', durationMs: 900, steps: [step] })
    const r = await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))
    expect((r.body.flows[0].steps as { suggestions?: unknown }[])[0]!.suggestions).toEqual([
      ok('Sign in'),
      { yaml: 'tapOn: { id: "login" }', element: { role: 'button', label: 'Log in', identifier: 'login' } },
      ok('Sign up'),
    ])
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

  it('refuses a second finish that overlapped the first, and a finish for a run that went', async () => {
    const id = await create()
    const late = sendLate(`/api/v1/runs/${id}/finish`, Buffer.from(JSON.stringify({ status: 'failed', exitCode: 1 })), () => {})
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })).status).toBe(200)
    expect(await late).toBe(409)
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.status).toBe('passed')

    const gone = await create()
    const status = await sendLate(`/api/v1/runs/${gone}/finish`, Buffer.from(JSON.stringify({ status: 'passed', exitCode: 0 })), () => {
      getDb().prepare('DELETE FROM flow_runs WHERE id = ?').run(gone)
    })
    expect(status).toBe(404)
  })

  it('refuses a flow report that arrives after the run was finished', async () => {
    const id = await create()
    const late = sendLate(`/api/v1/runs/${id}/flows/0`, Buffer.from(JSON.stringify(passed)), () => {})
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect(await late).toBe(409)
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

  // A parallel run: one runner, a socket per device, every one of them under the run's client id.
  it('offers every session the runner\'s sockets hold to watch', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'mac',
      devices: [{ id: 'dev0', name: 'iPhone', platform: 'ios', status: 'shutdown' }, { id: 'dev1', name: 'iPad', platform: 'ios', status: 'shutdown' }],
    }))
    const sessions = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions.map((r) => r.sessionId)
    const id = await create()
    for (const sessionId of sessions) {
      const ws = await runnerSocket()
      ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'flow-runner' }))
      await waitForType<SessionJoined>(ws, 'session:joined')
    }
    const body = (await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body
    expect([...body.watchSessionIds].sort()).toEqual([...sessions].sort())
    expect(sessions).toContain(body.watchSessionId)
    await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })
    expect((await call('GET', `/api/v1/runs/${id}`, bearer(PAT_VIEW))).body.watchSessionIds).toEqual([])
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
    expect(await ids('?flow=BOARD')).toEqual([ci])
    expect(await ids('?flow=log')).toEqual([buildless, local])

    const first = await call('GET', '/api/v1/runs?limit=2', bearer(PAT_VIEW))
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([buildless, ci])
    expect(first.body.prevCursor).toBeNull()
    const older = await call('GET', `/api/v1/runs?limit=2&before=${first.body.nextCursor}`, bearer(PAT_VIEW))
    expect(older.body.items.map((i: { id: string }) => i.id)).toEqual([local])
    expect(older.body.nextCursor).toBeNull()
    // Newer from the older page is the page directly above it, newest first, and no newer page past the top.
    const newer = await call('GET', `/api/v1/runs?limit=2&after=${older.body.prevCursor}`, bearer(PAT_VIEW))
    expect(newer.body.items.map((i: { id: string }) => i.id)).toEqual([buildless, ci])
    expect(newer.body.prevCursor).toBeNull()
    expect(newer.body.nextCursor).not.toBeNull()
    // `after` is the page directly above, not the newest: one a page, from the oldest run the next one up is `ci`.
    const above = await call('GET', `/api/v1/runs?limit=1&after=${older.body.prevCursor}`, bearer(PAT_VIEW))
    expect(above.body.items.map((i: { id: string }) => i.id)).toEqual([ci])
    expect(above.body.prevCursor).not.toBeNull()
    // A cursor or build id that is not one is refused, not read as the newest page or as nothing.
    for (const q of ['before=abc', 'after=1.5', 'before=-3', 'build=abc', 'after=%20', 'before=0x10', 'after=1e2',
      `before=${'9'.repeat(310)}`, 'after=9007199254740993']) {
      expect((await call('GET', `/api/v1/runs?${q}`, bearer(PAT_VIEW))).status).toBe(400)
    }
    // An empty cursor is no cursor.
    const empty = await call('GET', '/api/v1/runs?limit=2&after=', bearer(PAT_VIEW))
    expect(empty.body.items.map((i: { id: string }) => i.id)).toEqual([buildless, ci])
    // The cursors follow the filters: CI only has one run, so no page either way.
    const ciOnly = await call('GET', '/api/v1/runs?limit=2&ci=1', bearer(PAT_VIEW))
    expect([ciOnly.body.prevCursor, ciOnly.body.nextCursor]).toEqual([null, null])
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
    purgeExpiredBuilds({ uploadsDir, recordingsDir: path.join(uploadsDir, '../recordings'), runScreenshotsDir: shotsDir, runVideosDir: path.join(uploadsDir, '../run-videos') })
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
