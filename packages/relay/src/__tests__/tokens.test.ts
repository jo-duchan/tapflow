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

  describe('expires_in_days', () => {
    const expiresAtOf = (rawToken: string): string | null => {
      const row = getDb()
        .prepare('SELECT expires_at FROM personal_access_tokens WHERE token_hash = ?')
        .get(hashPat(rawToken)) as { expires_at: string | null }
      return row.expires_at
    }

    it.each([
      ['omitted', {}],
      ['0', { expires_in_days: 0 }],
    ])('%s creates a token with no expiry', async (_label, extra) => {
      const res = await createToken('Admin', { name: 'no-expiry', ...extra })
      expect(res.status).toBe(201)
      const { token } = await res.json() as { token: string }
      expect(expiresAtOf(token)).toBeNull()
    })

    it('a positive count sets the expiry that many days out, above the dialog limit too', async () => {
      const res = await createToken('Admin', { name: 'long', expires_in_days: 400 })
      expect(res.status).toBe(201)
      const { token } = await res.json() as { token: string }
      const days = (new Date(expiresAtOf(token) ?? 0).getTime() - Date.now()) / (24 * 3600 * 1000)
      expect(days).toBeGreaterThan(399)
      expect(days).toBeLessThanOrEqual(400)
    })

    it.each([
      ['negative', -1],
      ['not a number', 'soon'],
      ['too large for a date', 1e12],
    ])('%s is rejected with 400 and creates nothing', async (label, value) => {
      // A name per case, so one case's stray row cannot fail the next.
      const name = `bad-expiry-${label}`
      const res = await createToken('Admin', { name, expires_in_days: value })
      expect(res.status).toBe(400)
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM personal_access_tokens WHERE name = ?').get(name)).toEqual({ n: 0 })
    })
  })

  // #271 follow-up — 대시보드 agent 커맨드용 릴레이 LAN 주소 조회
  describe('GET /api/v1/relay/host', () => {
    it('인증 없으면 401', async () => {
      const res = await fetch(`http://localhost:${port}/api/v1/relay/host`)
      expect(res.status).toBe(401)
    })

    it('인증 시 lanHost(IPv4 또는 null)와 실제 포트를 반환한다', async () => {
      const cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@test.local', role: 'Admin' })}`
      const res = await fetch(`http://localhost:${port}/api/v1/relay/host`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = await res.json() as { lanHost: string | null; port: number }
      expect(body.port).toBe(port)
      if (body.lanHost !== null) expect(body.lanHost).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    })
  })
})
