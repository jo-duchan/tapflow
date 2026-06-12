import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash, verifyPassword } from '../api/auth'

// P0-1 — verifyPassword: 손상된 해시 포맷에서 RangeError 대신 안전 실패(false)
describe('verifyPassword — 손상 해시 가드', () => {
  it('정상 해시: 맞는 비번 true, 틀린 비번 false', () => {
    const stored = makePasswordHash('correct horse')
    expect(verifyPassword('correct horse', stored)).toBe(true)
    expect(verifyPassword('wrong', stored)).toBe(false)
  })

  it('콜론 없는 손상 포맷 → false (throw 안 함)', () => {
    expect(verifyPassword('x', 'no-colon-here')).toBe(false)
  })

  it('해시 부분이 비어 손상 → false', () => {
    expect(verifyPassword('x', 'deadbeef:')).toBe(false)
  })

  it('길이 불일치 해시 → false (RangeError 회피)', () => {
    expect(verifyPassword('x', 'abcd:ef')).toBe(false)
  })

  it('빈 문자열 → false', () => {
    expect(verifyPassword('x', '')).toBe(false)
  })
})

interface PostResult { status: number; retryAfter: string | undefined; body: { error?: string; ok?: boolean } }

function httpPost(port: number, urlPath: string, payload: unknown): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, retryAfter: res.headers['retry-after'] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString()) }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

// P0-1 — 로그인 무차별 대입: 연속 실패 후 잠금(429)
describe('POST /api/v1/auth/login — rate limiting', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-login-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    getDb().prepare('DELETE FROM users').run()
    // 모듈 싱글톤 limiter는 키(IP|email)로 격리되므로 테스트마다 고유 email을 쓴다.
    for (const email of ['bruteforce@example.com', 'happy@example.com']) {
      getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
        .run(email, 'Admin', 'Admin', makePasswordHash('correct-password'))
    }
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  it('잘못된 비번 5회 → 401, 이후 잠금되어 429 + Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await httpPost(port, '/api/v1/auth/login', { email: 'bruteforce@example.com', password: 'wrong' })
      expect(r.status).toBe(401)
    }
    const locked = await httpPost(port, '/api/v1/auth/login', { email: 'bruteforce@example.com', password: 'wrong' })
    expect(locked.status).toBe(429)
    expect(locked.retryAfter).toBeDefined()
    // 잠긴 동안에는 올바른 비번도 거부 (계정 잠금)
    const correctButLocked = await httpPost(port, '/api/v1/auth/login', { email: 'bruteforce@example.com', password: 'correct-password' })
    expect(correctButLocked.status).toBe(429)
  })

  it('정상 로그인은 잠금 없이 통과 (200)', async () => {
    const r = await httpPost(port, '/api/v1/auth/login', { email: 'happy@example.com', password: 'correct-password' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})
