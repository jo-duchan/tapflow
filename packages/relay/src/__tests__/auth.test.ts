import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type http from 'http'
import { initDb, closeDb, getDb } from '../db.js'
import {
  signJwt,
  verifyJwt,
  verifyJwtOrThrow,
  getAuth,
  requireAuth,
  requireRole,
  requireViewAuth,
  hashPat,
  verifyPat,
  findPat,
  touchPat,
  requireBuildAuth,
} from '../middleware/auth.js'
import type { AuthContext } from '../middleware/auth.js'
import { AuthError } from '@tapflowio/agent-core'

// Against a real database, not a mocked `getDb`: since the cookie path reads the users row, what these
// functions return depends on what the table says, and a mock that answers every `get` the same way
// would pass a lookup that asked the wrong question.
//
// Mutations run against this file, each turning it red:
// - `getAuth` without the row lookup → the removed-member rows (getAuth, requireAuth, requireViewAuth,
//   requireBuildAuth) fail.
// - `getAuth` returning the JWT's role / email → the "DB role" row fails.
// - `getAuth` catching everything into null → the "database fault throws" row fails.
// - `last_used_at` written in `verifyPat` again → the "verifyPat does not write" and refused-scope rows fail.

function makeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  const em = new EventEmitter() as http.IncomingMessage
  em.headers = headers
  em.method = 'GET'
  return em
}

function makeRes() {
  const calls: { status: number; headers: Record<string, string>; body: string }[] = []
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      calls.push({ status, headers, body: '' })
    }),
    end: vi.fn((body: string) => {
      if (calls.length > 0) calls[calls.length - 1].body = body
    }),
    _calls: calls,
  }
  return res as unknown as http.ServerResponse & { _calls: typeof calls }
}

const SAMPLE: AuthContext = { userId: 1, email: 'alice@example.com', role: 'Admin' }
const cookieOf = (ctx: AuthContext) => ({ cookie: `tapflow_token=${signJwt(ctx)}` })

let tmpDir: string
function openDb(): void { initDb(path.join(tmpDir, 'auth.db')) }

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-auth-'))
  openDb()
})
afterAll(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true })
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM personal_access_tokens').run()
  db.prepare('DELETE FROM users').run()
  db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'alice@example.com', 'Admin', 'x')").run()
})

let patSeq = 0
function seedPat(userId: number, scope: string, expiresAt: string | null = null): { raw: string; id: number } {
  const raw = `tflw_pat_auth_${++patSeq}`
  const r = getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 't', hashPat(raw), scope, expiresAt)
  return { raw, id: Number(r.lastInsertRowid) }
}
const lastUsed = (id: number) =>
  (getDb().prepare('SELECT last_used_at FROM personal_access_tokens WHERE id = ?').get(id) as { last_used_at: string | null }).last_used_at

// --- JWT ---

describe('signJwt / verifyJwt', () => {
  it('서명한 토큰을 그대로 검증할 수 있다', () => {
    expect(verifyJwt(signJwt(SAMPLE))).toMatchObject(SAMPLE)
  })

  it('변조된 토큰은 null 반환', () => {
    const token = signJwt(SAMPLE)
    expect(verifyJwt(token.slice(0, -4) + 'XXXX')).toBeNull()
  })

  it('임의 문자열은 null 반환', () => {
    expect(verifyJwt('not.a.jwt')).toBeNull()
    expect(verifyJwt('')).toBeNull()
  })

  it('invalid JWT throws AuthError via verifyJwtOrThrow', () => {
    expect(() => verifyJwtOrThrow('not.a.jwt')).toThrow(AuthError)
  })

  it('페이로드에 userId·email·role이 담긴다', () => {
    const result = verifyJwt(signJwt({ userId: 42, email: 'bob@test.com', role: 'Developer' }))!
    expect(result.userId).toBe(42)
    expect(result.email).toBe('bob@test.com')
    expect(result.role).toBe('Developer')
  })
})

// --- getAuth ---

describe('getAuth', () => {
  it('유효한 tapflow_token 쿠키가 있으면 AuthContext와 JWT exp 반환', () => {
    const ctx = getAuth(makeReq(cookieOf(SAMPLE)))
    expect(ctx).toMatchObject(SAMPLE)
    expect(ctx?.exp).toBeGreaterThan(Date.now() / 1000)
  })

  it('tapflow_token이 없으면 null', () => {
    expect(getAuth(makeReq({ cookie: 'other=foo' }))).toBeNull()
  })

  it('cookie 헤더 자체가 없으면 null', () => {
    expect(getAuth(makeReq())).toBeNull()
  })

  it('다른 쿠키와 함께 있어도 tapflow_token만 추출', () => {
    const req = makeReq({ cookie: `session=abc; tapflow_token=${signJwt(SAMPLE)}; other=xyz` })
    expect(getAuth(req)).toMatchObject(SAMPLE)
  })

  it('만료된/변조된 토큰 쿠키는 null', () => {
    expect(getAuth(makeReq({ cookie: 'tapflow_token=invalid.jwt.value' }))).toBeNull()
  })

  it('a validly signed cookie for a removed member is null', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().prepare('DELETE FROM users WHERE id = 1').run()
    expect(getAuth(req)).toBeNull()
  })

  it('returns the role and email the users table holds now, not the ones signed into the JWT', () => {
    getDb().prepare("UPDATE users SET role = 'Viewer', email = 'alice@new.example' WHERE id = 1").run()
    expect(getAuth(makeReq(cookieOf(SAMPLE)))).toMatchObject({ userId: 1, role: 'Viewer', email: 'alice@new.example' })
  })

  it('a database fault throws rather than reading as signed out', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().close()
    try {
      expect(() => getAuth(req)).toThrow()
    } finally {
      openDb()
    }
  })
})

// --- requireAuth ---

describe('requireAuth', () => {
  it('유효한 쿠키가 있으면 AuthContext 반환, 응답 없음', () => {
    const res = makeRes()
    expect(requireAuth(makeReq(cookieOf(SAMPLE)), res)).toMatchObject(SAMPLE)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('쿠키 없으면 401 반환 후 null', () => {
    const res = makeRes()
    expect(requireAuth(makeReq(), res)).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
    expect(JSON.parse(res._calls[0]?.body ?? '{}').error).toBe('Unauthorized')
  })

  it('a removed member gets 401', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().prepare('DELETE FROM users WHERE id = 1').run()
    const res = makeRes()
    expect(requireAuth(req, res)).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })
})

// --- requireRole ---

describe('requireRole', () => {
  const setRole = (role: string) => getDb().prepare('UPDATE users SET role = ? WHERE id = 1').run(role)

  it('역할이 허용 목록에 있으면 AuthContext 반환', () => {
    const res = makeRes()
    expect(requireRole(makeReq(cookieOf(SAMPLE)), res, ['Admin', 'Developer'])).toMatchObject(SAMPLE)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('역할이 허용 목록에 없으면 403 반환 후 null', () => {
    const res = makeRes()
    expect(requireRole(makeReq(cookieOf(SAMPLE)), res, ['Developer'])).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
    expect(JSON.parse(res._calls[0]?.body ?? '{}').error).toBe('Forbidden')
  })

  it('a demoted Admin is refused although the JWT still says Admin', () => {
    setRole('Developer')
    const res = makeRes()
    expect(requireRole(makeReq(cookieOf(SAMPLE)), res, ['Admin'])).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
  })

  it('a promoted member is allowed and gets the DB role back', () => {
    const res = makeRes()
    expect(requireRole(makeReq(cookieOf({ ...SAMPLE, role: 'Viewer' })), res, ['Admin'])).toMatchObject({ userId: 1, role: 'Admin' })
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('a removed member (no users row) gets 401', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().prepare('DELETE FROM users WHERE id = 1').run()
    const res = makeRes()
    expect(requireRole(req, res, ['Admin'])).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })

  it('인증 자체가 없으면 requireRole도 null (401)', () => {
    const res = makeRes()
    expect(requireRole(makeReq(), res, ['Admin'])).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })
})

// --- hashPat ---

describe('hashPat', () => {
  it('동일 입력은 항상 동일 해시', () => {
    expect(hashPat('tflw_pat_abc123')).toBe(hashPat('tflw_pat_abc123'))
  })

  it('다른 입력은 다른 해시', () => {
    expect(hashPat('token-a')).not.toBe(hashPat('token-b'))
  })

  it('64자 hex 문자열 반환', () => {
    expect(hashPat('any-token')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// --- verifyPat / findPat / touchPat ---

describe('verifyPat', () => {
  it('Bearer tflw_pat_ 아닌 헤더는 null', () => {
    expect(verifyPat(makeReq({ authorization: 'Bearer other_token' }))).toBeNull()
  })

  it('Authorization 헤더 없으면 null', () => {
    expect(verifyPat(makeReq())).toBeNull()
  })

  it('returns the token id, owner, scopes and the owner role, and does not write last_used_at', () => {
    const { raw, id } = seedPat(1, 'view, builds:write')
    expect(verifyPat(makeReq({ authorization: `Bearer ${raw}` }))).toEqual({
      patId: id, userId: 1, scopes: ['view', 'builds:write'], ownerEmail: 'alice@example.com', ownerRole: 'Admin',
    })
    expect(lastUsed(id)).toBeNull()
  })

  it('DB에 토큰이 없으면 null', () => {
    expect(verifyPat(makeReq({ authorization: 'Bearer tflw_pat_unknown-token' }))).toBeNull()
  })

  it('an expired token is null', () => {
    const { raw } = seedPat(1, 'view', '2000-01-01 00:00:00')
    expect(verifyPat(makeReq({ authorization: `Bearer ${raw}` }))).toBeNull()
  })

  it('findPat answers the same question by id; touchPat records a use', () => {
    const { id } = seedPat(1, 'agent')
    expect(findPat(id)).toMatchObject({ patId: id, scopes: ['agent'], ownerRole: 'Admin' })
    touchPat(id)
    expect(lastUsed(id)).not.toBeNull()
    getDb().prepare('DELETE FROM personal_access_tokens WHERE id = ?').run(id)
    expect(findPat(id)).toBeNull()
  })
})

// --- requireViewAuth ---

describe('requireViewAuth', () => {
  it('a removed member cookie gets 401', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().prepare('DELETE FROM users WHERE id = 1').run()
    const res = makeRes()
    expect(requireViewAuth(req, res)).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })

  it('a view PAT is accepted with its owner and marked used', () => {
    const { raw, id } = seedPat(1, 'view')
    const res = makeRes()
    expect(requireViewAuth(makeReq({ authorization: `Bearer ${raw}` }), res)).toEqual({ userId: 1, email: 'alice@example.com', role: 'Admin' })
    expect(lastUsed(id)).not.toBeNull()
  })

  it('a PAT without view gets 403 and is not marked used', () => {
    const { raw, id } = seedPat(1, 'agent')
    const res = makeRes()
    expect(requireViewAuth(makeReq({ authorization: `Bearer ${raw}` }), res)).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
    expect(lastUsed(id)).toBeNull()
  })
})

// --- requireBuildAuth ---

describe('requireBuildAuth', () => {
  it('PAT가 있고 builds:write scope이면 userId 반환, used로 기록', () => {
    const { raw, id } = seedPat(1, 'builds:write')
    const res = makeRes()
    expect(requireBuildAuth(makeReq({ authorization: `Bearer ${raw}` }), res)).toEqual({ userId: 1 })
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(lastUsed(id)).not.toBeNull()
  })

  it('PAT가 있지만 scope이 부족하면 403 반환 후 null, used로 기록하지 않음', () => {
    const { raw, id } = seedPat(1, 'view')
    const res = makeRes()
    expect(requireBuildAuth(makeReq({ authorization: `Bearer ${raw}` }), res)).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
    expect(JSON.parse(res._calls[0]?.body ?? '{}')).toMatchObject({ error: 'Insufficient scope' })
    expect(lastUsed(id)).toBeNull()
  })

  it('PAT 없고 유효한 JWT 쿠키면 userId 반환', () => {
    const res = makeRes()
    expect(requireBuildAuth(makeReq(cookieOf(SAMPLE)), res)).toEqual({ userId: SAMPLE.userId })
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('a removed member cookie gets 401', () => {
    const req = makeReq(cookieOf(SAMPLE))
    getDb().prepare('DELETE FROM users WHERE id = 1').run()
    const res = makeRes()
    expect(requireBuildAuth(req, res)).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })

  it('PAT 없고 JWT 쿠키도 없으면 401 반환 후 null', () => {
    const res = makeRes()
    expect(requireBuildAuth(makeReq(), res)).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })

  it('PAT가 만료/무효이면 JWT 쿠키로 fallback', () => {
    const req = makeReq({ authorization: 'Bearer tflw_pat_expired-token', ...cookieOf(SAMPLE) })
    expect(requireBuildAuth(req, makeRes())).toEqual({ userId: SAMPLE.userId })
  })
})
