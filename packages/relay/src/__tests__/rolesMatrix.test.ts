import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt, hashPat } from '../middleware/auth'

// Role model: Viewer is read-only (it can look at builds, test them and comment); Admin, Developer and
// QA can change builds, apps and webhooks. Every route below is exercised per role and per credential
// the route accepts, and roles are read from the users table rather than from the 7-day JWT.
//
// Mutations run against this file (with auth.test.ts), each turning it red:
// - `assertCanWrite` without its Viewer branch → all 17 Viewer 403 / nothing-changes rows, the
//   demotion row and the Viewer-owned PAT row fail.
// - `requireRole` comparing `auth.role` (the JWT) again → the demotion, promotion and demoted-Admin
//   rows fail.
// - PATCH /builds/:id judging the JWT role instead of calling `assertCanWrite` → its Viewer row, the
//   demotion, promotion and removed-member rows fail.
// - 'QA' dropped from `APP_MANAGERS` in apps.ts → the three QA app rows and the promotion row fail.

type Role = 'Admin' | 'Developer' | 'QA' | 'Viewer'
const ROLES: Role[] = ['Admin', 'Developer', 'QA', 'Viewer']
const WRITERS: Role[] = ['Admin', 'Developer', 'QA']
const USER_ID: Record<Role, number> = { Admin: 1, Developer: 2, QA: 3, Viewer: 4 }
const pat = (role: Role) => `tflw_pat_roles_${role.toLowerCase()}`
const cookieFor = (userId: number, role: string) =>
  `tapflow_token=${signJwt({ userId, email: `u${userId}@example.com`, role })}`

type Cred = 'cookie' | 'pat'
function headersFor(role: Role, cred: Cred): Record<string, string> {
  return cred === 'cookie'
    ? { Cookie: cookieFor(USER_ID[role], role) }
    : { Authorization: `Bearer ${pat(role)}` }
}

interface Res { status: number; body: Record<string, unknown> }

function request(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: Buffer | object, contentType?: string): Promise<Res> {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const h: Record<string, string | number> = { ...headers }
  if (payload) {
    h['Content-Type'] = contentType ?? 'application/json'
    h['Content-Length'] = payload.length
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text || '{}') as Record<string, unknown> } catch { parsed = { raw: text } }
        resolve({ status: res.statusCode!, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function multipart(boundary: string, fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer }): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n`))
    parts.push(file.data, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

// A dummy .apk has no extractable metadata on any host, so it lands under the __unknown__ app with a
// 201 — enough to prove the upload was accepted without needing build-tools.
const uploadBody = () => multipart('RM', {}, { name: 'file', filename: 'x.apk', data: Buffer.from('PK not a real apk') })
const upload = (port: number, headers: Record<string, string>) =>
  request(port, 'POST', '/api/v1/builds', headers, uploadBody(), 'multipart/form-data; boundary=RM')

function newBuild(): number {
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO apps (name, bundle_id_key, platform) VALUES ('Coffee', 'com.example.coffee', 'ios')`).run()
  const app = db.prepare(`SELECT id FROM apps WHERE bundle_id_key = 'com.example.coffee'`).get() as { id: number }
  return Number(db.prepare(`
    INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path, status_label)
    VALUES (?, '1.0.0', '1', 'com.example.coffee', '/tmp/x.zip', 'Backlog')
  `).run(app.id).lastInsertRowid)
}
function newApp(): number {
  const key = `com.example.a${Math.random().toString(36).slice(2)}`
  return Number(getDb().prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('A', ?, 'ios')`).run(key).lastInsertRowid)
}
function newWebhook(): number {
  return Number(getDb().prepare(`INSERT INTO webhook_endpoints (url, enabled) VALUES ('http://10.0.0.5/hook', 1)`).run().lastInsertRowid)
}
const buildRow = (id: number) =>
  getDb().prepare('SELECT status_label, delete_after FROM builds WHERE id = ?').get(id) as { status_label: string; delete_after: string | null }

interface RouteCase {
  name: string
  creds: Cred[]
  ok: number
  run: (port: number, headers: Record<string, string>) => Promise<Res>
  // Evidence the refused request changed nothing: a Viewer 403 whose side effect still ran is a hole.
  unchanged?: (port: number, headers: Record<string, string>) => Promise<() => void>
}

const WRITE_ROUTES: RouteCase[] = [
  { name: 'POST /builds', creds: ['cookie', 'pat'], ok: 201, run: (p, h) => upload(p, h) },
  {
    name: 'PATCH /builds/:id', creds: ['cookie'], ok: 200,
    run: (p, h) => request(p, 'PATCH', `/api/v1/builds/${newBuild()}`, h, { status_label: 'In Progress' }),
    unchanged: async (p, h) => {
      const id = newBuild()
      await request(p, 'PATCH', `/api/v1/builds/${id}`, h, { status_label: 'In Progress' })
      return () => expect(buildRow(id).status_label).toBe('Backlog')
    },
  },
  {
    name: 'POST /builds/:id/schedule-deletion', creds: ['cookie'], ok: 200,
    run: (p, h) => request(p, 'POST', `/api/v1/builds/${newBuild()}/schedule-deletion`, h),
    unchanged: async (p, h) => {
      const id = newBuild()
      await request(p, 'POST', `/api/v1/builds/${id}/schedule-deletion`, h)
      return () => expect(buildRow(id).delete_after).toBeNull()
    },
  },
  {
    name: 'DELETE /builds/:id/schedule-deletion', creds: ['cookie'], ok: 200,
    run: (p, h) => request(p, 'DELETE', `/api/v1/builds/${newBuild()}/schedule-deletion`, h),
  },
  { name: 'GET /webhooks', creds: ['cookie', 'pat'], ok: 200, run: (p, h) => request(p, 'GET', '/api/v1/webhooks', h) },
  {
    name: 'POST /webhooks', creds: ['cookie', 'pat'], ok: 201,
    run: (p, h) => request(p, 'POST', '/api/v1/webhooks', h, { url: 'http://10.0.0.9/hook' }),
    unchanged: async (p, h) => {
      const before = (getDb().prepare('SELECT COUNT(*) AS n FROM webhook_endpoints').get() as { n: number }).n
      await request(p, 'POST', '/api/v1/webhooks', h, { url: 'http://10.0.0.9/hook' })
      return () => expect((getDb().prepare('SELECT COUNT(*) AS n FROM webhook_endpoints').get() as { n: number }).n).toBe(before)
    },
  },
  {
    name: 'PATCH /webhooks/:id', creds: ['cookie', 'pat'], ok: 200,
    run: (p, h) => request(p, 'PATCH', `/api/v1/webhooks/${newWebhook()}`, h, { enabled: false }),
  },
  {
    name: 'DELETE /webhooks/:id', creds: ['cookie', 'pat'], ok: 200,
    run: (p, h) => request(p, 'DELETE', `/api/v1/webhooks/${newWebhook()}`, h),
  },
  {
    name: 'POST /apps', creds: ['cookie'], ok: 201,
    run: (p, h) => request(p, 'POST', '/api/v1/apps', h, { name: 'New', bundle_id_key: `com.example.n${Math.random().toString(36).slice(2)}`, platform: 'ios' }),
  },
  {
    name: 'PATCH /apps/:id', creds: ['cookie'], ok: 200,
    run: (p, h) => request(p, 'PATCH', `/api/v1/apps/${newApp()}`, h, { name: 'Renamed' }),
  },
  {
    name: 'DELETE /apps/:id', creds: ['cookie'], ok: 200,
    run: (p, h) => request(p, 'DELETE', `/api/v1/apps/${newApp()}`, h),
  },
]

describe('role matrix — Viewer is read-only, Admin/Developer/QA can write', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-roles-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    for (const role of ROLES) {
      db.prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(USER_ID[role], `u${USER_ID[role]}@example.com`, role, role, makePasswordHash('password123'))
      // Any role can mint a builds:write token through POST /tokens, so a Viewer owning one is real.
      db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
        .run(USER_ID[role], 'ci', hashPat(pat(role)), 'builds:write')
    }
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-roles-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  for (const route of WRITE_ROUTES) {
    for (const cred of route.creds) {
      for (const role of WRITERS) {
        it(`${route.name} [${cred}] ${role} → ${route.ok}`, async () => {
          const r = await route.run(port, headersFor(role, cred))
          expect(r.status, JSON.stringify(r.body)).toBe(route.ok)
        })
      }
      it(`${route.name} [${cred}] Viewer → 403`, async () => {
        const r = await route.run(port, headersFor('Viewer', cred))
        expect(r.status).toBe(403)
        expect(r.body.error).toBe(route.name.includes('/apps') ? 'Forbidden' : 'Viewers have read-only access')
      })
      if (route.unchanged) {
        const unchanged = route.unchanged
        it(`${route.name} [${cred}] Viewer → nothing changes`, async () => {
          const check = await unchanged(port, headersFor('Viewer', cred))
          check()
        })
      }
    }
  }

  // The credentials a route accepts did not change: these three stay cookie-only for every role.
  for (const [method, suffix] of [['PATCH', ''], ['POST', '/schedule-deletion'], ['DELETE', '/schedule-deletion']] as const) {
    it(`${method} /builds/:id${suffix} still refuses a PAT (401), even an Admin's`, async () => {
      const r = await request(port, method, `/api/v1/builds/${newBuild()}${suffix}`, headersFor('Admin', 'pat'),
        method === 'PATCH' ? { status_label: 'In Progress' } : undefined)
      expect(r.status).toBe(401)
    })
  }

  describe('what Viewer can still do', () => {
    for (const cred of ['cookie', 'pat'] as const) {
      it(`reads the build list [${cred}] → 200`, async () => {
        newBuild()
        const r = await request(port, 'GET', '/api/v1/builds', headersFor('Viewer', cred))
        expect(r.status).toBe(200)
        expect((r.body.items as unknown[]).length).toBeGreaterThan(0)
      })

      it(`comments on a build [${cred}] → 201`, async () => {
        const body = multipart('CM', { build_id: String(newBuild()), body: 'Looks off on the second tab' })
        const r = await request(port, 'POST', '/api/v1/comments', headersFor('Viewer', cred), body, 'multipart/form-data; boundary=CM')
        expect(r.status).toBe(201)
        expect(r.body.author).toBe('Viewer')
      })
    }
  })

  // The role is read from the users table on each request, so a role change applies to a cookie that
  // was signed before it — and to a PAT, which carries no role at all.
  describe('role changes take effect without a new login or token', () => {
    const MOVER = 10
    beforeAll(() => {
      getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(MOVER, 'mover@example.com', 'Mover', 'Viewer', makePasswordHash('password123'))
      getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
        .run(MOVER, 'ci', hashPat('tflw_pat_roles_mover'), 'builds:write')
    })
    const setRole = (role: string) => getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, MOVER)

    it('demotion: a JWT that says Developer is refused once the DB says Viewer', async () => {
      setRole('Viewer')
      const r = await request(port, 'PATCH', `/api/v1/builds/${newBuild()}`, { Cookie: cookieFor(MOVER, 'Developer') }, { status_label: 'Done' })
      expect(r.status).toBe(403)
      const apps = await request(port, 'POST', '/api/v1/apps', { Cookie: cookieFor(MOVER, 'Developer') }, { name: 'X', bundle_id_key: 'com.example.demoted', platform: 'ios' })
      expect(apps.status).toBe(403)
    })

    it('promotion: a JWT that says Viewer is allowed once the DB says QA', async () => {
      setRole('QA')
      const r = await request(port, 'PATCH', `/api/v1/builds/${newBuild()}`, { Cookie: cookieFor(MOVER, 'Viewer') }, { status_label: 'In Progress' })
      expect(r.status).toBe(200)
      const apps = await request(port, 'POST', '/api/v1/apps', { Cookie: cookieFor(MOVER, 'Viewer') }, { name: 'X', bundle_id_key: 'com.example.promoted', platform: 'ios' })
      expect(apps.status).toBe(201)
    })

    it('a Viewer-owned CI token gets 403 on upload, and the same token works as soon as its owner is promoted', async () => {
      const h = { Authorization: 'Bearer tflw_pat_roles_mover' }
      setRole('Viewer')
      expect((await upload(port, h)).status).toBe(403)
      setRole('Developer')
      expect((await upload(port, h)).status).toBe(201)
    })

    it('requireRole: a demoted Admin loses the team page with the old Admin JWT', async () => {
      setRole('Developer')
      const r = await request(port, 'GET', '/api/v1/team/members', { Cookie: cookieFor(MOVER, 'Admin') })
      expect(r.status).toBe(403)
      setRole('Admin')
      const back = await request(port, 'GET', '/api/v1/team/members', { Cookie: cookieFor(MOVER, 'Viewer') })
      expect(back.status).toBe(200)
    })

    it('a removed member gets 401 on a write route with a still-valid JWT', async () => {
      const r = await request(port, 'PATCH', `/api/v1/builds/${newBuild()}`, { Cookie: cookieFor(4242, 'Admin') }, { status_label: 'In Progress' })
      expect(r.status).toBe(401)
    })
  })
})
