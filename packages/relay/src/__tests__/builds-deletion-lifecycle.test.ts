import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { purgeExpiredBuilds } from '../api/builds'
import { RelayServer } from '../RelayServer'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// issue #258 — review status ("Done") decoupled from the deletion lifecycle.
// delete_after is the sole purge driver; completed_at is informational only.

// ── helpers ────────────────────────────────────────────────────────────────

function insertAppAndBuild(filePath: string): number {
  const db = getDb()
  db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Coffee', 'com.example.coffee', 'ios')`).run()
  const app = db.prepare('SELECT id FROM apps WHERE bundle_id_key = ?').get('com.example.coffee') as { id: number }
  const r = db.prepare(`
    INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
    VALUES (?, '1.0.0', '1', 'com.example.coffee', ?)
  `).run(app.id, filePath)
  return Number(r.lastInsertRowid)
}

function deleteAfterOf(id: number): string | null {
  return (getDb().prepare('SELECT delete_after FROM builds WHERE id = ?').get(id) as { delete_after: string | null }).delete_after
}
function completedAtOf(id: number): string | null {
  return (getDb().prepare('SELECT completed_at FROM builds WHERE id = ?').get(id) as { completed_at: string | null }).completed_at
}

// ── Migration 012: schema + grandfather ──────────────────────────────────────

describe('Migration 012: delete_after column', () => {
  let tmpDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-da-mig-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('#1 builds table has delete_after column + index', () => {
    const cols = (getDb().prepare('PRAGMA table_info(builds)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('delete_after')
    const idx = (getDb().prepare('PRAGMA index_list(builds)').all() as { name: string }[]).map(i => i.name)
    expect(idx).toContain('idx_builds_delete_after')
  })

  it('#3/#4 grandfather: completed_at → delete_after = completed_at + 7d; NULL stays NULL', () => {
    const db = getDb()
    const completed = insertAppAndBuild('/tmp/completed.zip')
    const fresh = insertAppAndBuild('/tmp/fresh.zip')
    // simulate pre-012 state (rows that existed before the migration ran)
    db.prepare(`UPDATE builds SET completed_at = '2026-06-01 00:00:00', delete_after = NULL WHERE id = ?`).run(completed)
    db.prepare(`UPDATE builds SET completed_at = NULL, delete_after = NULL WHERE id = ?`).run(fresh)

    // run the exact grandfather UPDATE shipped in the migration
    const sql = fs.readFileSync(path.join(import.meta.dirname, '../migrations/012_build_delete_after.sql'), 'utf-8')
    const stripped = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    const update = stripped.split(';').map(s => s.trim()).find(s => s.toUpperCase().startsWith('UPDATE'))
    expect(update).toBeTruthy()
    db.exec(update!)

    expect(deleteAfterOf(completed)).toBe('2026-06-08 00:00:00')
    expect(deleteAfterOf(fresh)).toBeNull()
  })
})

// ── purgeExpiredBuilds keys off delete_after ─────────────────────────────────

describe('purgeExpiredBuilds: delete_after is the purge driver', () => {
  let tmpDir: string
  let recordingsDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-da-purge-'))
    recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-da-rec-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(recordingsDir, { recursive: true, force: true })
  })

  it('#9/#10 deletes only past delete_after; Done-but-unscheduled and future survive', () => {
    const db = getDb()
    const expired = insertAppAndBuild('/tmp/expired.zip')
    const future = insertAppAndBuild('/tmp/future.zip')
    const doneUnscheduled = insertAppAndBuild('/tmp/done.zip')

    db.prepare(`UPDATE builds SET delete_after = datetime('now','-1 hour') WHERE id = ?`).run(expired)
    db.prepare(`UPDATE builds SET delete_after = datetime('now','+1 hour') WHERE id = ?`).run(future)
    // Done but never scheduled: completed_at set, delete_after NULL → must NOT be purged
    db.prepare(`UPDATE builds SET status_label = 'Done', completed_at = datetime('now'), delete_after = NULL WHERE id = ?`).run(doneUnscheduled)

    purgeExpiredBuilds(recordingsDir)

    const ids = (db.prepare('SELECT id FROM builds').all() as { id: number }[]).map(r => r.id)
    expect(ids).not.toContain(expired)
    expect(ids).toContain(future)
    expect(ids).toContain(doneUnscheduled)
  })

  it('#11 cascade: expired build removes its recording row + file', () => {
    const db = getDb()
    const build = insertAppAndBuild('/tmp/withrec.zip')
    const recFile = 'rec-cascade.mp4'
    fs.writeFileSync(path.join(recordingsDir, recFile), 'x')
    db.prepare(`INSERT INTO recordings (filename, file_size, mime, expires_at, build_id) VALUES (?, 1, 'video/mp4', datetime('now','+1 day'), ?)`).run(recFile, build)
    db.prepare(`UPDATE builds SET delete_after = datetime('now','-1 hour') WHERE id = ?`).run(build)

    purgeExpiredBuilds(recordingsDir)

    const rec = db.prepare('SELECT id FROM recordings WHERE build_id = ?').get(build)
    expect(rec).toBeUndefined()
    expect(fs.existsSync(path.join(recordingsDir, recFile))).toBe(false)
  })
})

// ── HTTP: status decoupling + schedule/cancel endpoints ──────────────────────

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

describe('builds deletion lifecycle: HTTP endpoints', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string
  let buildId: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-da-http-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    buildId = insertAppAndBuild('/tmp/http.zip')
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-da-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    getDb().exec('DELETE FROM builds; DELETE FROM apps')
  })

  it('#5 PATCH status_label=Done records completed_at but does NOT set delete_after', async () => {
    const r = await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Done' })
    expect(r.status).toBe(200)
    expect(completedAtOf(buildId)).not.toBeNull()
    expect(deleteAfterOf(buildId)).toBeNull()
  })

  it('#7 POST schedule-deletion sets delete_after in the future, status unchanged', async () => {
    await httpJson(port, 'PATCH', `/api/v1/builds/${buildId}`, cookie, { status_label: 'Done' })
    const r = await httpJson(port, 'POST', `/api/v1/builds/${buildId}/schedule-deletion`, cookie)
    expect(r.status).toBe(200)
    const da = deleteAfterOf(buildId)
    expect(da).not.toBeNull()
    expect(r.body.delete_after).toBe(da) // server returns the authoritative timestamp
    expect(new Date(da! + 'Z').getTime()).toBeGreaterThan(Date.now())
    const status = (getDb().prepare('SELECT status_label FROM builds WHERE id = ?').get(buildId) as { status_label: string }).status_label
    expect(status).toBe('Done')
  })

  it('#8 DELETE schedule-deletion clears delete_after', async () => {
    await httpJson(port, 'POST', `/api/v1/builds/${buildId}/schedule-deletion`, cookie)
    expect(deleteAfterOf(buildId)).not.toBeNull()
    const r = await httpJson(port, 'DELETE', `/api/v1/builds/${buildId}/schedule-deletion`, cookie)
    expect(r.status).toBe(200)
    expect(deleteAfterOf(buildId)).toBeNull()
  })

  it('schedule-deletion on missing build → 404', async () => {
    const r = await httpJson(port, 'POST', `/api/v1/builds/999999/schedule-deletion`, cookie)
    expect(r.status).toBe(404)
  })

  it('#12 GET build includes delete_after field', async () => {
    await httpJson(port, 'POST', `/api/v1/builds/${buildId}/schedule-deletion`, cookie)
    const r = await httpJson(port, 'GET', `/api/v1/builds/${buildId}`, cookie)
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('delete_after')
    expect(r.body.delete_after).not.toBeNull()
  })
})
