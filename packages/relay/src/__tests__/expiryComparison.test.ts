import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { hashPat, verifyPat, findPat } from '../middleware/auth'

// Every expiry the relay writes with `toISOString()` ('…T…Z') is compared against `datetime('now')`
// ('… …'). As text, 'T' sorts after ' ', so an expiry earlier *today* read as still in the future
// until the end of that UTC day. The fixtures are therefore written exactly the way the code writes
// them — `toISOString()`, a minute in the past — never with SQLite's own `datetime(...)`, which has
// the same shape as `now` and would pass with or without the fix.
//
// Mutations: dropping `datetime(...)` around `expires_at` in `PAT_SELECT` turns the PAT rows red;
// in `invitations.ts` the invitation rows; in `passwordReset.ts` the reset rows. (Run within a UTC
// day whose date is today, which is always the case for "a minute ago" except in the minute after
// midnight UTC.)

const minuteAgo = () => new Date(Date.now() - 60_000).toISOString()
const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString()

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) }).on('error', reject)
  })
}

describe('ISO expiry timestamps are compared as times, not text', () => {
  let tmpDir: string
  let server: RelayServer
  let port: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-expiry-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  beforeEach(async () => {
    const db = getDb()
    db.prepare('DELETE FROM personal_access_tokens').run()
    db.prepare('DELETE FROM password_reset_tokens').run()
    db.prepare('DELETE FROM invitations').run()
    db.prepare('DELETE FROM users').run()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'a@test.local', 'Admin', 'x')").run()
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as net.AddressInfo).port
  })
  afterEach(async () => { await server.stop() })

  const seedPat = (raw: string, expiresAt: string) => Number(getDb()
    .prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope, expires_at) VALUES (1, ?, ?, ?, ?)')
    .run('t', hashPat(raw), 'view', expiresAt).lastInsertRowid)
  const reqWith = (raw: string) => {
    const em = new EventEmitter() as http.IncomingMessage
    em.headers = { authorization: `Bearer ${raw}` }
    return em
  }

  it('a PAT that expired a minute ago is refused by verifyPat and findPat', () => {
    const id = seedPat('tflw_pat_expired_iso', minuteAgo())
    expect(verifyPat(reqWith('tflw_pat_expired_iso'))).toBeNull()
    expect(findPat(id)).toBeNull()
  })

  it('a PAT that expires in an hour is accepted (control)', () => {
    const id = seedPat('tflw_pat_live_iso', hourAhead())
    expect(verifyPat(reqWith('tflw_pat_live_iso'))).not.toBeNull()
    expect(findPat(id)).not.toBeNull()
  })

  it('an invitation that expired a minute ago is gone; one an hour ahead is not', async () => {
    getDb().prepare("INSERT INTO invitations (token, email, role, expires_at) VALUES ('inv-old', NULL, 'QA', ?)").run(minuteAgo())
    getDb().prepare("INSERT INTO invitations (token, email, role, expires_at) VALUES ('inv-new', NULL, 'QA', ?)").run(hourAhead())
    expect(await get(port, '/api/v1/invitations/verify?token=inv-old')).toBe(410)
    expect(await get(port, '/api/v1/invitations/verify?token=inv-new')).toBe(200)
  })

  it('a password reset link that expired a minute ago is gone; one an hour ahead is not', async () => {
    getDb().prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (1, 'rst-old', ?)").run(minuteAgo())
    getDb().prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (1, 'rst-new', ?)").run(hourAhead())
    expect(await get(port, '/api/v1/auth/reset-password/verify?token=rst-old')).toBe(410)
    expect(await get(port, '/api/v1/auth/reset-password/verify?token=rst-new')).toBe(200)
  })
})
