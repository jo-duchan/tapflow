import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// H-A/H-B: an .apk whose metadata can't be extracted (aapt missing or the file isn't a real APK)
// must never be absorbed into a caller-named app. A dummy .apk yields a null bundleId on every
// host — aapt fails to parse it, or (no build-tools) aapt is absent — so the guard fires regardless.

function multipartBody(boundary: string, parts: { name: string; filename?: string; contentType?: string; data: Buffer | string }[]): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    let disp = `Content-Disposition: form-data; name="${p.name}"`
    if (p.filename) disp += `; filename="${p.filename}"`
    chunks.push(Buffer.from(disp + '\r\n'))
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

type UploadResult = { status: number; body: { error?: string; id?: number; app_id?: number; bundle_id?: string; platform?: string } }

function postApk(port: number, boundary: string, fields: { name: string; filename?: string; contentType?: string; data: Buffer | string }[], cookie: string): Promise<UploadResult> {
  const body = multipartBody(boundary, fields)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/v1/builds', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('POST /api/v1/builds — .apk metadata guard', () => {
  let server: RelayServer
  let port: number
  let dbDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-apk-db-'))
    initDb(path.join(dbDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-apk-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  const buildsDir = () => path.join(uploadsDir, 'builds')
  const leftover = () => (fs.existsSync(buildsDir()) ? fs.readdirSync(buildsDir()) : [])

  const dummyApk = () => Buffer.from('PK not a real apk')

  it('app_id + unextractable metadata → 400, no stored file, named app untouched', async () => {
    const db = getDb()
    // A pre-existing iOS app — the unidentifiable apk must not be absorbed here.
    const info = db.prepare("INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Foods', 'com.example.foods', 'ios')").run()
    const appId = Number(info.lastInsertRowid)

    const r = await postApk(port, 'A1', [
      { name: 'app_id', data: String(appId) },
      { name: 'file', filename: 'mystery.apk', contentType: 'application/vnd.android.package-archive', data: dummyApk() },
    ], cookie)

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/apk|build-tools|bundle|metadata/i)
    expect(leftover()).toEqual([])

    // The named app must be untouched: platform preserved, no build created.
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(appId) as { platform: string }
    expect(app.platform).toBe('ios')
    const builds = db.prepare('SELECT COUNT(*) AS n FROM builds WHERE app_id = ?').get(appId) as { n: number }
    expect(builds.n).toBe(0)
  })

  it('app_id + spoofed platform=ios on an .apk → still 400 (guard keys off the file, not the field)', async () => {
    const db = getDb()
    const info = db.prepare("INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Spoof', 'com.example.spoof', 'ios')").run()
    const appId = Number(info.lastInsertRowid)

    const r = await postApk(port, 'A3', [
      { name: 'app_id', data: String(appId) },
      { name: 'platform', data: 'ios' }, // spoofed — the artifact is still an .apk
      { name: 'file', filename: 'mystery.apk', contentType: 'application/vnd.android.package-archive', data: dummyApk() },
    ], cookie)

    expect(r.status).toBe(400)
    expect(leftover()).toEqual([])
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(appId) as { platform: string }
    expect(app.platform).toBe('ios') // not absorbed / not promoted to 'both'
  })

  it('no app_id + unextractable metadata → 201, isolated under an __unknown__ app', async () => {
    const db = getDb()
    const r = await postApk(port, 'A2', [
      { name: 'file', filename: 'orphan.apk', contentType: 'application/vnd.android.package-archive', data: dummyApk() },
    ], cookie)

    expect(r.status).toBe(201)
    // Verify it landed in the __unknown__ bucket, not a real app.
    const app = db.prepare('SELECT bundle_id_key FROM apps WHERE id = ?').get(r.body.app_id) as { bundle_id_key: string } | undefined
    expect(app?.bundle_id_key).toBe('__unknown__')
  })
})
