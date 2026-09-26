import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt, hashPat } from '../middleware/auth'

// The CI recipe in docs/guide/build-distribution.md uploads a build with a PAT and then posts a
// comment with the same PAT. The comment route used to accept the cookie only, so that step got a
// 401 and failed the job under `curl -sf`.

const WRITE_PAT = 'tflw_pat_comments_write'
const VIEW_PAT = 'tflw_pat_comments_view'

function postComment(port: number, headers: Record<string, string>, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const boundary = 'CMT'
  const body = Buffer.from(
    Object.entries(fields)
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('') + `--${boundary}--\r\n`,
  )
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: '/api/v1/comments', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, ...headers },
      },
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

describe('POST /api/v1/comments auth', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let buildId: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-comments-pat-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    // Two users, so attribution can't pass by picking the first row. The CI user has no display
    // name: the POST response must fall back to the email's local part, as the comment list does.
    db.prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    db.prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('ci-bot@example.com', null, 'Developer', makePasswordHash('password123'))
    // `builds:write` alone is what the Build Distribution guide tells CI to create.
    db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (2, ?, ?, ?)')
      .run('ci', hashPat(WRITE_PAT), 'builds:write')
    db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (2, ?, ?, ?)')
      .run('viewer', hashPat(VIEW_PAT), 'view')
    db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Coffee', 'com.example.coffee', 'ios')`).run()
    const r = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (1, '1.0.0', '1', 'com.example.coffee', '/tmp/x.zip')
    `).run()
    buildId = String(r.lastInsertRowid)
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-comments-uploads-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  it('accepts a PAT with builds:write and attributes the comment to its owner', async () => {
    const r = await postComment(port, { Authorization: `Bearer ${WRITE_PAT}` }, { build_id: buildId, body: 'Branch: main' })
    expect(r.status).toBe(201)
    expect(r.body.author).toBe('ci-bot')
    expect(r.body.body).toBe('Branch: main')
  })

  it('rejects a PAT without builds:write with 403', async () => {
    const r = await postComment(port, { Authorization: `Bearer ${VIEW_PAT}` }, { build_id: buildId, body: 'nope' })
    expect(r.status).toBe(403)
  })

  it('rejects an unknown PAT with 401', async () => {
    const r = await postComment(port, { Authorization: 'Bearer tflw_pat_unknown' }, { build_id: buildId, body: 'nope' })
    expect(r.status).toBe(401)
  })

  it('rejects a request with no credentials with 401', async () => {
    const r = await postComment(port, {}, { build_id: buildId, body: 'nope' })
    expect(r.status).toBe(401)
  })

  it('still accepts the dashboard cookie', async () => {
    const cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
    const r = await postComment(port, { Cookie: cookie }, { build_id: buildId, body: 'from the dashboard' })
    expect(r.status).toBe(201)
    expect(r.body.author).toBe('Admin')
  })

  // comments.build_id is a foreign key, and the INSERT runs inside busboy's async `finish` listener:
  // an unknown id used to throw there as an unhandled rejection, which exits the relay.
  it('answers 404 for a build that does not exist, and the relay keeps serving', async () => {
    const r = await postComment(port, { Authorization: `Bearer ${WRITE_PAT}` }, { build_id: '999999', body: 'orphan' })
    expect(r.status).toBe(404)
    const again = await postComment(port, { Authorization: `Bearer ${WRITE_PAT}` }, { build_id: buildId, body: 'still up' })
    expect(again.status).toBe(201)
  })

  // A member removed by an Admin still holds a validly signed cookie for up to 7 days. It used to get
  // as far as the insert and fail on the comments.author_id FK (500); the cookie check now reads the
  // users row, so it is refused at the door — and the relay keeps serving either way.
  it('refuses a removed user with 401 instead of exiting, and keeps serving', async () => {
    const ghost = `tapflow_token=${signJwt({ userId: 4242, email: 'gone@example.com', role: 'Developer' })}`
    const r = await postComment(port, { Cookie: ghost }, { build_id: buildId, body: 'from a removed member' })
    expect(r.status).toBe(401)
    const again = await postComment(port, { Authorization: `Bearer ${WRITE_PAT}` }, { build_id: buildId, body: 'still up' })
    expect(again.status).toBe(201)
  })
})
