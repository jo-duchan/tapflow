import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'

// Wraps `getAuth` to count calls; everything else in the module is the real thing.
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>()
  return { ...actual, getAuth: vi.fn(actual.getAuth) }
})

import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { getAuth, signJwt } from '../middleware/auth.js'
import { waitForOpen } from '@tapflowio/test-utils'

// A removed member's cookie is still validly signed for up to seven days. Every cookie path goes
// through `getAuth`, which now reads the users row, so each of these answers 401 — including the ones
// that never called `requireAuth` (`/uploads`, recordings download, the build-auth cookie branch).
// `POST /tokens` used to reach the insert and fail on the foreign key with a 500.
//
// Mutation: `getAuth` without the row lookup → every row but the control fails.

function request(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: object): Promise<number> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const h: Record<string, string | number> = { ...headers }
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('a removed member', () => {
  let tmpDir: string
  let server: RelayServer
  let port: number
  let recordingsDir: string
  const cookie = () => ({ Cookie: `tapflow_token=${signJwt({ userId: 9, email: 'gone@test.local', role: 'Admin' })}` })

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-removed-member-'))
    initDb(path.join(tmpDir, 'test.db'))
    const uploadsDir = path.join(tmpDir, 'uploads')
    fs.mkdirSync(path.join(uploadsDir, 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, 'avatars', 'a.png'), 'png')
    recordingsDir = path.join(tmpDir, 'recordings')
    fs.mkdirSync(recordingsDir, { recursive: true })
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM recordings').run()
    db.prepare('DELETE FROM users').run()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (9, 'gone@test.local', 'Admin', 'x')").run()
    db.prepare("INSERT INTO recordings (filename, file_size, mime, expires_at) VALUES ('r.webm', 4, 'video/webm', datetime('now', '+1 day'))").run()
    // Written after start: the boot-time purge removes recording files that have no row.
    fs.writeFileSync(path.join(recordingsDir, 'r.webm'), 'webm')
  })
  afterEach(() => { vi.mocked(getAuth).mockClear() })

  const routes: [string, string, object?][] = [
    ['GET', '/api/v1/apps'],
    ['GET', '/api/v1/builds'],
    ['POST', '/api/v1/recordings/upload'],
    ['GET', '/api/v1/recordings/r.webm'],
    ['PATCH', '/api/v1/profile', { display_name: 'x' }],
    ['GET', '/api/v1/relay/host'],
    ['POST', '/api/v1/tokens', { name: 'mine' }],
    ['GET', '/uploads/avatars/a.png'],
  ]

  it('is served while still a member (control)', async () => {
    expect(await request(port, 'GET', '/uploads/avatars/a.png', cookie())).toBe(200)
    expect(await request(port, 'GET', '/api/v1/recordings/r.webm', cookie())).toBe(200)
  })

  it.each(routes)('%s %s → 401 after removal', async (method, urlPath, body) => {
    getDb().prepare('DELETE FROM users WHERE id = 9').run()
    expect(await request(port, method, urlPath, cookie(), body)).toBe(401)
  })

  it('reads the cookie once per WebSocket connection', async () => {
    vi.mocked(getAuth).mockClear()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: cookie() })
    await waitForOpen(ws)
    expect(vi.mocked(getAuth)).toHaveBeenCalledTimes(1)
    ws.terminate()
  })
})
