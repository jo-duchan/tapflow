import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { makeAppTarGz } from './helpers/tarFixture'
import { assertArchiveTools } from './helpers/archivePrereqs'

/**
 * A build's label, version and build number as a person sets them (#1084). The file's values stay in `version_name` /
 * `build_number`; a person's go in `*_override`, and every read goes through the `builds_effective` view, so the value
 * in use is the same in the list, the search, the sort and the apps list. The run records and the webhook read the
 * view too; only `buildsEffectiveReads.test.ts`, a static floor, holds them to it.
 */

const plist = (name: string | null) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.override</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>12</string>
  ${name ? `<key>CFBundleDisplayName</key><string>${name}</string>` : ''}
</dict></plist>`

const cookie = (role: 'Admin' | 'Viewer') => `tapflow_token=${signJwt({ userId: role === 'Admin' ? 1 : 2, email: `${role}@example.com`, role })}`

function multipart(parts: Array<{ name: string; filename?: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--B\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n`))
    if (p.filename) chunks.push(Buffer.from('Content-Type: application/gzip\r\n'))
    chunks.push(Buffer.from('\r\n'), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from('--B--\r\n'))
  return Buffer.concat(chunks)
}

type Json = Record<string, unknown> & { binary?: { version_name: string | null; build_number: string | null } }

function call(port: number, method: string, urlPath: string, body?: Buffer | object, role: 'Admin' | 'Viewer' = 'Admin'): Promise<{ status: number; body: Json }> {
  const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const type = Buffer.isBuffer(body) ? 'multipart/form-data; boundary=B' : 'application/json'
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { Cookie: cookie(role), ...(raw ? { 'Content-Type': type, 'Content-Length': raw.length } : {}) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Json }))
    })
    req.on('error', reject)
    req.end(raw)
  })
}

describe('build version overrides and labels (#1084)', () => {
  let server: RelayServer
  let port: number
  let dbDir: string
  let fixtureDir: string
  let uploadsDir: string

  beforeAll(() => {
    assertArchiveTools(['tar'])
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-override-db-'))
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-override-fix-'))
    initDb(path.join(dbDir, 'test.db'))
    getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (1, ?, ?, ?, ?)')
      .run('Admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (2, ?, ?, ?, ?)')
      .run('Viewer@example.com', 'Viewer', 'Viewer', makePasswordHash('password123'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    getDb().exec('DELETE FROM builds; DELETE FROM app_bundle_ids; DELETE FROM apps')
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-override-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  const upload = (fields: Record<string, string> = {}, name: string | null = 'Override App') => {
    const tar = makeAppTarGz(fixtureDir, `App${Math.random().toString(36).slice(2, 8)}`, plist(name))
    return call(port, 'POST', '/api/v1/builds', multipart([
      ...Object.entries(fields).map(([k, v]) => ({ name: k, data: v })),
      { name: 'file', filename: 'MyBuild.tar.gz', data: fs.readFileSync(tar) },
    ]))
  }
  const get = async (id: unknown) => (await call(port, 'GET', `/api/v1/builds/${String(id)}`)).body
  const patch = (id: unknown, body: object, role: 'Admin' | 'Viewer' = 'Admin') => call(port, 'PATCH', `/api/v1/builds/${String(id)}`, body, role)
  const leftover = () => (fs.existsSync(path.join(uploadsDir, 'builds')) ? fs.readdirSync(path.join(uploadsDir, 'builds')) : [])

  it('overrides the version and build number at upload, keeping the file\'s', async () => {
    const r = await upload({ version_name: ' 2.0 ', build_number: '7', label: '  staging ' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ version_name: '2.0', build_number: '7', version_label: 'staging', binary: { version_name: '1.0', build_number: '12' } })
  })

  it('stores no override for the file\'s own value or an empty field', async () => {
    const r = await upload({ version_name: '1.0', build_number: '' })
    expect(r.body).toMatchObject({ version_name: '1.0', build_number: '12', binary: { version_name: '1.0', build_number: '12' } })
    expect(getDb().prepare('SELECT version_name_override, build_number_override FROM builds').get())
      .toEqual({ version_name_override: null, build_number_override: null })
  })

  it('refuses a version over 100 characters, and keeps no file', async () => {
    const r = await upload({ version_name: 'x'.repeat(101) })
    expect(r.status).toBe(400)
    expect(leftover()).toEqual([])
  })

  // Labels had no bound before; a CI job sending a commit subject must not lose its upload to a 400.
  it('cuts a long label to 100 characters rather than refusing the upload', async () => {
    const r = await upload({ label: 'y'.repeat(150) })
    expect(r.status).toBe(201)
    expect(r.body.version_label).toBe('y'.repeat(100))
  })

  // A label is a note on the build; it used to name the app when the file had no name.
  it('does not name the app after the label', async () => {
    const r = await upload({ label: 'staging' }, null)
    expect(r.body.name).toBe('MyBuild')
  })

  it('overrides after upload, and an empty value goes back to the file\'s', async () => {
    const { body } = await upload()
    expect((await patch(body.id, { version_name: '1.2.0', build_number: '99' })).status).toBe(200)
    expect(await get(body.id)).toMatchObject({ version_name: '1.2.0', build_number: '99', binary: { version_name: '1.0', build_number: '12' } })

    await patch(body.id, { version_name: '', build_number: null })
    expect(await get(body.id)).toMatchObject({ version_name: '1.0', build_number: '12' })
  })

  it('keeps no override that says what the file says', async () => {
    const { body } = await upload()
    await patch(body.id, { version_name: '1.0' })
    expect(getDb().prepare('SELECT version_name_override FROM builds WHERE id = ?').get(body.id)).toEqual({ version_name_override: null })
  })

  it('trims a label and stores an empty one as none', async () => {
    const { body } = await upload()
    await patch(body.id, { version_label: '  feature X  ' })
    expect((await get(body.id)).version_label).toBe('feature X')
    await patch(body.id, { version_label: '   ' })
    expect((await get(body.id)).version_label).toBeNull()
  })

  it('refuses a Viewer, and a value that is not text', async () => {
    const { body } = await upload()
    expect((await patch(body.id, { version_name: '2.0' }, 'Viewer')).status).toBe(403)
    expect((await patch(body.id, { version_name: 2 })).status).toBe(400)
    expect((await patch(body.id, { build_number: 'x'.repeat(101) })).status).toBe(400)
  })

  it('searches, sorts and lists by the value in use', async () => {
    const a = (await upload({ label: 'nightly' })).body
    const b = (await upload()).body
    await patch(b.id, { version_name: '3.0' })
    const search = async (q: string) => ((await call(port, 'GET', `/api/v1/builds?q=${q}`)).body.items as Json[]).map((x) => x.id)
    expect(await search('3.0')).toEqual([b.id])
    expect(await search('nightly')).toEqual([a.id])
    const sorted = ((await call(port, 'GET', '/api/v1/builds?sort=version_name&dir=desc')).body.items as Json[]).map((x) => x.version_name)
    expect(sorted).toEqual(['3.0', '1.0'])
    // Both builds share an upload second, so the apps list's "latest" is either: give both the override.
    await patch(a.id, { version_name: '3.0' })
    const apps = (await call(port, 'GET', '/api/v1/apps')).body.items as Json[]
    expect(apps[0]).toMatchObject({ version_name: '3.0' })
  })

  it('keeps NULL the only way to say "not overridden"', () => {
    getDb().prepare("INSERT INTO apps (name, platform) VALUES ('x', 'ios')").run()
    getDb().prepare("INSERT INTO builds (app_id, file_path, platform) VALUES ((SELECT max(id) FROM apps), '/x', 'ios')").run()
    expect(() => getDb().prepare("UPDATE builds SET version_name_override = '  '").run()).toThrow(/CHECK/)
    expect(() => getDb().prepare("UPDATE builds SET build_number_override = ''").run()).toThrow(/CHECK/)
  })
})
