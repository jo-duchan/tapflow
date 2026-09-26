import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { RelayServer, parseLogLines, LOGS_FORBIDDEN_MESSAGE } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'

// `/api/v1/logs` answers only the relay host. Every request here comes from loopback for real, so the
// remote cases are made the two ways a remote client actually reaches a relay on this machine: through
// a trusted reverse proxy that names it in X-Forwarded-For, and through the tunnel listener (the latter
// in `tunnelIngress.test.ts`, next to the rest of that listener's cases).
//
// Mutations run against this file, each turning it red:
// - the `isLocal` check dropped from the route → the trusted-proxy rows fail (and the tunnel row).
// - the route passing `[]` instead of `options.trustedProxies` → the trusted-proxy rows fail.
// - `Number()` back in place of `parseLogLines` → the `abc` / `-5` rows fail.

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') as unknown }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/v1/logs', () => {
  let tmpDir: string
  let server: RelayServer
  let port: number

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-logs-route-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'admin@example.com', 'Admin', 'x')").run()
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  afterEach(async () => { await server.stop() })

  const start = async (options: { trustedProxies?: string[] } = {}) => {
    server = new RelayServer({ port: 0, ...options })
    await server.start()
    port = (server.address() as net.AddressInfo).port
    for (let i = 0; i < 600; i++) server.pushLog(`line ${i}`)
  }

  it('answers the relay host with the buffer', async () => {
    await start()
    const r = await get(port, '/api/v1/logs')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect((r.body as string[]).length).toBe(100)
    expect((r.body as string[]).at(-1)).toContain('line 599')
  })

  it('refuses a remote client behind a trusted proxy, with the instruction', async () => {
    await start({ trustedProxies: ['127.0.0.1', '::1'] })
    const r = await get(port, '/api/v1/logs', { 'X-Forwarded-For': '203.0.113.9' })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: LOGS_FORBIDDEN_MESSAGE })
  })

  it('refuses a remote client behind a trusted proxy even with a live session cookie', async () => {
    await start({ trustedProxies: ['127.0.0.1', '::1'] })
    const cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
    const r = await get(port, '/api/v1/logs', { 'X-Forwarded-For': '203.0.113.9', Cookie: cookie })
    expect(r.status).toBe(403)
  })

  it('still answers the host itself when a proxy is trusted and no header is forwarded', async () => {
    await start({ trustedProxies: ['127.0.0.1', '::1'] })
    expect((await get(port, '/api/v1/logs')).status).toBe(200)
  })

  it.each([
    ['abc', 100],
    ['-5', 1],
    ['9999', 500],
    ['7', 7],
  ])('?lines=%s → %i entries', async (lines, expected) => {
    await start()
    const r = await get(port, `/api/v1/logs?lines=${lines}`)
    expect(r.status).toBe(200)
    expect((r.body as string[]).length).toBe(expected)
  })
})

describe('parseLogLines', () => {
  it.each([
    [null, 100], ['', 100], ['  ', 100], ['abc', 100], ['NaN', 100], ['Infinity', 100],
    ['-5', 1], ['0', 1], ['1', 1], ['2.9', 2], ['500', 500], ['501', 500], ['9999', 500],
  ] as const)('%s → %i', (raw, expected) => {
    expect(parseLogLines(raw)).toBe(expected)
  })
})
