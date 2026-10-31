import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { RelayServer } from '../RelayServer'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// The App Center's version search is a substring match. `%`, `_` and `\` typed into it are characters to find,
// not LIKE wildcards: before this, `%` matched every build and `1_0` matched `1.0.5`.

function listVersions(port: number, cookie: string, q: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: `/api/v1/builds?q=${encodeURIComponent(q)}`, method: 'GET', headers: { Cookie: cookie } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { items: { version_name: string }[] }
          resolve(body.items.map((i) => i.version_name).sort())
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/v1/builds?q= matches the text literally', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-search-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    db.prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
    db.prepare(`INSERT INTO apps (name, platform) VALUES ('Coffee', 'ios')`).run()
    const insert = db.prepare(`INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path) VALUES (1, ?, '1', 'com.example.coffee', ?)`)
    for (const v of ['1.2.0', '1.0.5', '1_0', '50%', 'a\\b', 'Beta-1']) insert.run(v, `/tmp/${v}.zip`)
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-search-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  it('`%` finds only a version containing a percent sign', async () => {
    expect(await listVersions(port, cookie, '%')).toEqual(['50%'])
  })
  it('`_` is one underscore, not any one character', async () => {
    expect(await listVersions(port, cookie, '1_0')).toEqual(['1_0'])
  })
  // Not a regression: `\` was literal before too. This holds the escape character itself, which an `ESCAPE` clause
  // without escaping `\` would break.
  it('a backslash is a character, not an escape', async () => {
    expect(await listVersions(port, cookie, 'a\\b')).toEqual(['a\\b'])
    expect(await listVersions(port, cookie, '\\')).toEqual(['a\\b'])
  })
  it('a plain substring still matches, ignoring case for A–Z', async () => {
    expect(await listVersions(port, cookie, '1.2')).toEqual(['1.2.0'])
    expect(await listVersions(port, cookie, 'beta')).toEqual(['Beta-1'])
  })
})
