import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { RelayServer } from '../RelayServer'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import {
  validateWebhookUrl,
  signPayload,
  deliverWebhooks,
  type FetchLike,
  type WebhookPayload,
} from '../lib/webhooks'

// ── helpers ──────────────────────────────────────────────────────────────────

function insertAppAndBuild(): number {
  const db = getDb()
  db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Coffee', 'com.example.coffee', 'ios')`).run()
  const app = db.prepare('SELECT id FROM apps WHERE bundle_id_key = ?').get('com.example.coffee') as { id: number }
  const r = db.prepare(`
    INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
    VALUES (?, '1.0.0', '1', 'com.example.coffee', '/tmp/x.zip')
  `).run(app.id)
  return Number(r.lastInsertRowid)
}

function httpJson(port: number, method: string, urlPath: string, cookie: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers: Record<string, string> = { Cookie: cookie }
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length) }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// A local HTTP receiver that records incoming webhook requests.
function makeReceiver(): { server: http.Server; requests: { headers: http.IncomingHttpHeaders; body: string }[] } {
  const requests: { headers: http.IncomingHttpHeaders; body: string }[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.writeHead(200)
      res.end()
    })
  })
  return { server, requests }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── unit: validateWebhookUrl ───────────────────────────────────────────────────

describe('validateWebhookUrl', () => {
  it('#16 rejects loopback and metadata addresses', () => {
    expect(validateWebhookUrl('http://127.0.0.1/hook')).toBeTruthy()
    expect(validateWebhookUrl('http://localhost/hook')).toBeTruthy()
    expect(validateWebhookUrl('http://169.254.169.254/latest/meta-data')).toBeTruthy()
    expect(validateWebhookUrl('http://[::1]/hook')).toBeTruthy()
  })
  it('#17 allows private LAN and public addresses', () => {
    expect(validateWebhookUrl('http://10.0.1.5/hook')).toBeNull()
    expect(validateWebhookUrl('http://192.168.1.20/hook')).toBeNull()
    expect(validateWebhookUrl('https://hooks.slack.com/services/xxx')).toBeNull()
  })
  it('rejects non-http(s) schemes and malformed URLs', () => {
    expect(validateWebhookUrl('ftp://example.com')).toBeTruthy()
    expect(validateWebhookUrl('not a url')).toBeTruthy()
  })
})

// ── unit: signPayload ──────────────────────────────────────────────────────────

describe('signPayload', () => {
  it('#8 produces an HMAC-SHA256 of the body, prefixed sha256=', () => {
    const body = JSON.stringify({ hello: 'world' })
    const expected = 'sha256=' + crypto.createHmac('sha256', 's3cr3t').update(body).digest('hex')
    expect(signPayload('s3cr3t', body)).toBe(expected)
  })
})

// ── unit: deliverWebhooks (injected fetch) ─────────────────────────────────────

describe('deliverWebhooks', () => {
  let tmpDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-deliver-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })
  afterEach(() => { getDb().exec('DELETE FROM webhook_endpoints') })

  const payload: WebhookPayload = {
    event: 'build.status_changed',
    build: { id: '1', platform: 'ios', appVersion: '1.0.0', status: 'Done' },
    changedAt: '2026-07-03T00:00:00.000Z',
  }

  function record(): { fetchFn: FetchLike; calls: { url: string; headers: Record<string, string>; body: string }[] } {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      return { ok: true, status: 200 }
    }
    return { fetchFn, calls }
  }

  it('#14 fans out to every enabled endpoint', async () => {
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.1/a', null)
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.2/b', null)
    const { fetchFn, calls } = record()
    await deliverWebhooks(payload, { fetchFn })
    expect(calls.map((c) => c.url).sort()).toEqual(['http://10.0.0.1/a', 'http://10.0.0.2/b'])
  })

  it('#7 skips disabled endpoints', async () => {
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 0)').run('http://10.0.0.9/off', null)
    const { fetchFn, calls } = record()
    await deliverWebhooks(payload, { fetchFn })
    expect(calls).toHaveLength(0)
  })

  it('#8/#9 signs only when a secret is set', async () => {
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.1/signed', 'topsecret')
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.2/plain', null)
    const { fetchFn, calls } = record()
    await deliverWebhooks(payload, { fetchFn })
    const signed = calls.find((c) => c.url.endsWith('/signed'))!
    const plain = calls.find((c) => c.url.endsWith('/plain'))!
    expect(signed.headers['X-Tapflow-Signature']).toBe(signPayload('topsecret', signed.body))
    expect(plain.headers['X-Tapflow-Signature']).toBeUndefined()
  })

  it('#6 no endpoints → no fetch', async () => {
    const { fetchFn, calls } = record()
    await deliverWebhooks(payload, { fetchFn })
    expect(calls).toHaveLength(0)
  })

  it('#15 one endpoint failing does not stop the others', async () => {
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.1/bad', null)
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run('http://10.0.0.2/good', null)
    const calls: string[] = []
    const fetchFn: FetchLike = async (url) => {
      calls.push(url)
      if (url.endsWith('/bad')) throw new Error('connection refused')
      return { ok: true, status: 200 }
    }
    await expect(deliverWebhooks(payload, { fetchFn })).resolves.toBeUndefined()
    expect(calls.sort()).toEqual(['http://10.0.0.1/bad', 'http://10.0.0.2/good'])
  })
})

// ── HTTP: CRUD ─────────────────────────────────────────────────────────────────

describe('webhooks CRUD', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-crud-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    getDb().exec('DELETE FROM webhook_endpoints')
  })

  it('creates a webhook and never returns the secret', async () => {
    const r = await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { url: 'https://hooks.slack.com/x', secret: 'shh' })
    expect(r.status).toBe(201)
    expect(r.body.url).toBe('https://hooks.slack.com/x')
    expect(r.body.has_secret).toBe(true)
    expect(r.body).not.toHaveProperty('secret')
  })

  it('#16 rejects a loopback URL at registration', async () => {
    const r = await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { url: 'http://127.0.0.1:9000/hook' })
    expect(r.status).toBe(400)
  })

  it('requires a url', async () => {
    const r = await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { secret: 'x' })
    expect(r.status).toBe(400)
  })

  it('lists webhooks without secrets', async () => {
    await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { url: 'https://a.example/x', secret: 'shh' })
    const r = await httpJson(port, 'GET', '/api/v1/webhooks', cookie)
    expect(r.status).toBe(200)
    const list = r.body.webhooks as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('secret')
    expect(list[0].has_secret).toBe(true)
  })

  it('toggles enabled via PATCH', async () => {
    const created = await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { url: 'https://a.example/x' })
    const id = created.body.id
    const r = await httpJson(port, 'PATCH', `/api/v1/webhooks/${id}`, cookie, { enabled: false })
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(false)
  })

  it('DELETE removes a webhook; missing id → 404', async () => {
    const created = await httpJson(port, 'POST', '/api/v1/webhooks', cookie, { url: 'https://a.example/x' })
    const del = await httpJson(port, 'DELETE', `/api/v1/webhooks/${created.body.id}`, cookie)
    expect(del.status).toBe(200)
    const missing = await httpJson(port, 'DELETE', '/api/v1/webhooks/999999', cookie)
    expect(missing.status).toBe(404)
  })

  it('rejects unauthenticated requests', async () => {
    const r = await httpJson(port, 'GET', '/api/v1/webhooks', '')
    expect(r.status).toBe(401)
  })
})

// ── HTTP: firing on status transition ──────────────────────────────────────────

describe('webhook firing on build status transition', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string
  let buildId: number
  let receiver: ReturnType<typeof makeReceiver>
  let recvPort: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-fire-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    buildId = insertAppAndBuild()
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-fireup-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
    receiver = makeReceiver()
    recvPort = await listen(receiver.server)
    // Register the receiver directly (bypasses URL validation, which rejects loopback).
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)')
      .run(`http://127.0.0.1:${recvPort}/hook`, 'sig-secret')
  })
  afterEach(async () => {
    await server.stop()
    await new Promise<void>((r) => receiver.server.close(() => r()))
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    getDb().exec('DELETE FROM builds; DELETE FROM apps; DELETE FROM webhook_endpoints')
  })

  it('#1/#8/#11 fires on transition to Done with signed metadata-only payload', async () => {
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Done' })
    expect(r.status).toBe(200)
    await waitFor(() => receiver.requests.length === 1)

    const got = receiver.requests[0]
    const parsed = JSON.parse(got.body) as WebhookPayload
    expect(parsed.event).toBe('build.status_changed')
    expect(parsed.build).toEqual({ id: String(buildId), platform: 'ios', appVersion: '1.0.0', status: 'Done' })
    // signature matches the exact delivered body
    expect(got.headers['x-tapflow-signature']).toBe(signPayload('sig-secret', got.body))
    // metadata only: no binary / file path / download url leaked
    expect(got.body).not.toMatch(/file_path|uploads|\.zip|\.tar/)
  })

  it('#2 fires on transition to Rejected', async () => {
    await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Rejected' })
    await waitFor(() => receiver.requests.length === 1)
    expect((JSON.parse(receiver.requests[0].body) as WebhookPayload).build.status).toBe('Rejected')
  })

  it('#3 does not fire on transition to In Progress', async () => {
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'In Progress' })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 150))
    expect(receiver.requests).toHaveLength(0)
  })

  it('#4 does not fire on a no-op PATCH (Done → Done)', async () => {
    getDb().prepare('UPDATE builds SET status_label = ? WHERE id = ?').run('Done', buildId)
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Done' })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 150))
    expect(receiver.requests).toHaveLength(0)
  })

  it('#5 does not fire when only version_label changes', async () => {
    getDb().prepare('UPDATE builds SET status_label = ? WHERE id = ?').run('Done', buildId)
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { version_label: 'v2' })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 150))
    expect(receiver.requests).toHaveLength(0)
  })

  it('#10 a dead receiver does not fail the PATCH', async () => {
    getDb().prepare('DELETE FROM webhook_endpoints').run()
    await new Promise<void>((r) => receiver.server.close(() => r())) // now nothing is listening on recvPort
    getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)')
      .run(`http://127.0.0.1:${recvPort}/hook`, null)
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Done' })
    expect(r.status).toBe(200)
    const status = (getDb().prepare('SELECT status_label FROM builds WHERE id = ?').get(buildId) as { status_label: string }).status_label
    expect(status).toBe('Done')
  })
})
