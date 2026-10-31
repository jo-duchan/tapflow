import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { upsertApp } from '../api/builds'

// Migration 007 dropped UNIQUE(bundle_id_key, platform) to be "handled at the application level", and
// nothing handled it: POST /apps inserted a second row, so the dashboard's 409 message was unreachable.
// The rule is one app per bundle ID on any platform, not the old per-platform constraint: `upsertApp`
// finds an upload's app by the key alone, so a second row on another platform would never get a build.

const adminCookie = () => `tapflow_token=${signJwt({ userId: 1, email: 'a@example.com', role: 'Admin' })}`

interface Res { status: number; body: Record<string, unknown> }

function post(port: number, body: object): Promise<Res> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/v1/apps', method: 'POST',
      headers: { Cookie: adminCookie(), 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

const appCount = (key: string) =>
  (getDb().prepare('SELECT COUNT(DISTINCT app_id) AS n FROM app_bundle_ids WHERE bundle_id = ?').get(key) as { n: number }).n

describe('POST /api/v1/apps — duplicate bundle ID', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-apps-dup-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (1, ?, ?, ?, ?)')
      .run('a@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-apps-dup-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  it('refuses a second app with the same bundle ID with 409, and adds no row', async () => {
    const first = await post(port, { name: 'Demo', bundle_id_key: 'com.example.dup', platform: 'ios' })
    expect(first.status).toBe(201)

    const second = await post(port, { name: 'Demo again', bundle_id_key: 'com.example.dup', platform: 'ios' })
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.error).toBe('App with this bundle ID already exists')
    expect(appCount('com.example.dup')).toBe(1)
  })

  it('compares the trimmed bundle ID, since that is what is stored', async () => {
    await post(port, { name: 'Trim', bundle_id_key: 'com.example.trim', platform: 'android' })
    const padded = await post(port, { name: 'Trim', bundle_id_key: '  com.example.trim ', platform: 'android' })
    expect(padded.status).toBe(409)
    expect(appCount('com.example.trim')).toBe(1)
  })

  it('refuses a duplicate of an app that an upload created', async () => {
    upsertApp('Uploaded', 'com.example.uploaded', 'ios')
    const r = await post(port, { name: 'Manual', bundle_id_key: 'com.example.uploaded', platform: 'ios' })
    expect(r.status).toBe(409)
  })

  // The case the old per-platform constraint allowed: the android row would never receive an upload
  // made without app_id, because upsertApp returns the ios row for the key and promotes it to 'both'.
  it('refuses the same bundle ID on another platform, including both', async () => {
    await post(port, { name: 'Cross', bundle_id_key: 'com.example.cross', platform: 'ios' })
    expect((await post(port, { name: 'Cross', bundle_id_key: 'com.example.cross', platform: 'android' })).status).toBe(409)
    expect((await post(port, { name: 'Cross', bundle_id_key: 'com.example.cross', platform: 'both' })).status).toBe(409)
    expect(appCount('com.example.cross')).toBe(1)
  })

  it('still creates apps whose bundle IDs differ', async () => {
    expect((await post(port, { name: 'One', bundle_id_key: 'com.example.one', platform: 'ios' })).status).toBe(201)
    expect((await post(port, { name: 'Two', bundle_id_key: 'com.example.two', platform: 'ios' })).status).toBe(201)
  })
})
