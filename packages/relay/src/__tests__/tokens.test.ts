import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt, hashPat } from '../middleware/auth'

// #271 — PAT 발급 스코프: 허용 목록 검증 + agent 스코프는 Admin 전용
describe('POST /api/v1/tokens — scope', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  const createToken = (role: string, body: Record<string, unknown>) => {
    const cookie = `tapflow_token=${signJwt({ userId: role === 'Admin' ? 1 : 2, email: `${role}@test.local`, role })}`
    return fetch(`http://localhost:${port}/api/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
  }

  const scopeOf = (rawToken: string): string => {
    const row = getDb()
      .prepare('SELECT scope FROM personal_access_tokens WHERE token_hash = ?')
      .get(hashPat(rawToken)) as { scope: string } | undefined
    return row?.scope ?? ''
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-tokens-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (1, 'admin@test.local', 'Admin', 'Admin', 'x')").run()
    db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (2, 'QA@test.local', 'QA', 'QA', 'x')").run()
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('scope 미지정 시 기존 기본값 view,builds:write 유지 (BC 없음)', async () => {
    const res = await createToken('Admin', { name: 'default-scope' })
    expect(res.status).toBe(201)
    const { token } = await res.json() as { token: string }
    expect(scopeOf(token)).toBe('view,builds:write')
  })

  it('Admin은 agent 스코프 토큰을 발급할 수 있다', async () => {
    const res = await createToken('Admin', { name: 'agent-token', scope: 'agent' })
    expect(res.status).toBe(201)
    const { token } = await res.json() as { token: string }
    expect(token).toMatch(/^tflw_pat_/)
    expect(scopeOf(token)).toBe('agent')
  })

  it('Admin이 아니면 agent 스코프 발급은 403', async () => {
    const res = await createToken('QA', { name: 'qa-agent-token', scope: 'agent' })
    expect(res.status).toBe(403)
  })

  it('Admin이 아니어도 기본 스코프 토큰은 발급 가능 (기존 동작 유지)', async () => {
    const res = await createToken('QA', { name: 'qa-default', scope: 'view,builds:write' })
    expect(res.status).toBe(201)
  })

  it('허용 목록 밖 스코프는 400', async () => {
    const res = await createToken('Admin', { name: 'bad-scope', scope: 'admin:everything' })
    expect(res.status).toBe(400)
  })

  it('복합 스코프(view,agent)도 Admin이면 발급 가능', async () => {
    const res = await createToken('Admin', { name: 'mixed', scope: 'view,agent' })
    expect(res.status).toBe(201)
    const { token } = await res.json() as { token: string }
    expect(scopeOf(token)).toBe('view,agent')
  })
})
