import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'

function httpGet(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/v1/auth/status', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-auth-status-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
    // 각 테스트 시작 전 users 테이블 초기화
    getDb().prepare('DELETE FROM users').run()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('유저 없음 → { initialized: false }', async () => {
    const { status, body } = await httpGet(port, '/api/v1/auth/status')
    expect(status).toBe(200)
    expect(body).toEqual({ initialized: false })
  })

  it('유저 있음 → { initialized: true }', async () => {
    getDb()
      .prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    const { status, body } = await httpGet(port, '/api/v1/auth/status')
    expect(status).toBe(200)
    expect(body).toEqual({ initialized: true })
  })

  it('인증 쿠키 없이도 200 응답 (public endpoint)', async () => {
    const { status } = await httpGet(port, '/api/v1/auth/status')
    expect(status).toBe(200)
  })
})
