import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type http from 'http'

// getDb는 named import이므로 vi.mock으로 모듈 전체를 교체
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('../db.js', () => ({ getDb: mockGet }))

import {
  signJwt,
  verifyJwt,
  verifyJwtOrThrow,
  getAuth,
  requireAuth,
  requireRole,
  hashPat,
  verifyPat,
  requireBuildAuth,
} from '../middleware/auth.js'
import type { AuthContext } from '../middleware/auth.js'
import { AuthError } from '@tapflowio/agent-core'

// --- 헬퍼 ---

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

// --- JWT ---

describe('signJwt / verifyJwt', () => {
  it('서명한 토큰을 그대로 검증할 수 있다', () => {
    const token = signJwt(SAMPLE)
    const result = verifyJwt(token)
    expect(result).toMatchObject(SAMPLE)
  })

  it('변조된 토큰은 null 반환', () => {
    const token = signJwt(SAMPLE)
    const tampered = token.slice(0, -4) + 'XXXX'
    expect(verifyJwt(tampered)).toBeNull()
  })

  it('임의 문자열은 null 반환', () => {
    expect(verifyJwt('not.a.jwt')).toBeNull()
    expect(verifyJwt('')).toBeNull()
  })

  it('invalid JWT throws AuthError via verifyJwtOrThrow', () => {
    expect(() => verifyJwtOrThrow('not.a.jwt')).toThrow(AuthError)
  })

  it('페이로드에 userId·email·role이 담긴다', () => {
    const token = signJwt({ userId: 42, email: 'bob@test.com', role: 'Developer' })
    const result = verifyJwt(token)!
    expect(result.userId).toBe(42)
    expect(result.email).toBe('bob@test.com')
    expect(result.role).toBe('Developer')
  })
})

// --- getAuth (cookie 파싱) ---

describe('getAuth', () => {
  it('유효한 tapflow_token 쿠키가 있으면 AuthContext 반환', () => {
    const token = signJwt(SAMPLE)
    const req = makeReq({ cookie: `tapflow_token=${token}` })
    const ctx = getAuth(req)
    expect(ctx).toMatchObject(SAMPLE)
  })

  it('tapflow_token이 없으면 null', () => {
    const req = makeReq({ cookie: 'other=foo' })
    expect(getAuth(req)).toBeNull()
  })

  it('cookie 헤더 자체가 없으면 null', () => {
    expect(getAuth(makeReq())).toBeNull()
  })

  it('다른 쿠키와 함께 있어도 tapflow_token만 추출', () => {
    const token = signJwt(SAMPLE)
    const req = makeReq({ cookie: `session=abc; tapflow_token=${token}; other=xyz` })
    expect(getAuth(req)).toMatchObject(SAMPLE)
  })

  it('만료된/변조된 토큰 쿠키는 null', () => {
    const req = makeReq({ cookie: 'tapflow_token=invalid.jwt.value' })
    expect(getAuth(req)).toBeNull()
  })
})

// --- requireAuth ---

describe('requireAuth', () => {
  it('유효한 쿠키가 있으면 AuthContext 반환, 응답 없음', () => {
    const token = signJwt(SAMPLE)
    const req = makeReq({ cookie: `tapflow_token=${token}` })
    const res = makeRes()
    const ctx = requireAuth(req, res)
    expect(ctx).toMatchObject(SAMPLE)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('쿠키 없으면 401 반환 후 null', () => {
    const req = makeReq()
    const res = makeRes()
    const ctx = requireAuth(req, res)
    expect(ctx).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
    const body = JSON.parse(res._calls[0]?.body ?? '{}')
    expect(body.error).toBe('Unauthorized')
  })
})

// --- requireRole ---

describe('requireRole', () => {
  it('역할이 허용 목록에 있으면 AuthContext 반환', () => {
    const token = signJwt(SAMPLE)
    const req = makeReq({ cookie: `tapflow_token=${token}` })
    const res = makeRes()
    const ctx = requireRole(req, res, ['Admin', 'Developer'])
    expect(ctx).toMatchObject(SAMPLE)
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('역할이 허용 목록에 없으면 403 반환 후 null', () => {
    const token = signJwt(SAMPLE) // role: 'Admin'
    const req = makeReq({ cookie: `tapflow_token=${token}` })
    const res = makeRes()
    const ctx = requireRole(req, res, ['Developer'])
    expect(ctx).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
    const body = JSON.parse(res._calls[0]?.body ?? '{}')
    expect(body.error).toBe('Forbidden')
  })

  it('인증 자체가 없으면 requireRole도 null (401)', () => {
    const req = makeReq()
    const res = makeRes()
    const ctx = requireRole(req, res, ['Admin'])
    expect(ctx).toBeNull()
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
    const hash = hashPat('any-token')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// --- verifyPat ---

describe('verifyPat', () => {
  beforeEach(() => vi.resetAllMocks())

  it('Bearer tflw_pat_ 아닌 헤더는 null', () => {
    const req = makeReq({ authorization: 'Bearer other_token' })
    expect(verifyPat(req)).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('Authorization 헤더 없으면 null', () => {
    expect(verifyPat(makeReq())).toBeNull()
  })

  it('DB에 토큰이 있으면 userId·scope 반환, last_used_at 업데이트', () => {
    const rawToken = 'tflw_pat_test-token-abc'
    const tokenHash = hashPat(rawToken)

    const preparedGet = vi.fn().mockReturnValue({ user_id: 7, scope: 'read' })
    const preparedRun = vi.fn()
    mockGet.mockReturnValue({
      prepare: vi.fn()
        .mockReturnValueOnce({ get: preparedGet })    // SELECT
        .mockReturnValueOnce({ run: preparedRun }),   // UPDATE
    })

    const req = makeReq({ authorization: `Bearer ${rawToken}` })
    const result = verifyPat(req)

    expect(result).toEqual({ userId: 7, scope: 'read' })
    expect(preparedGet).toHaveBeenCalledWith(tokenHash)
    expect(preparedRun).toHaveBeenCalledWith(tokenHash)
  })

  it('DB에 토큰이 없으면 null', () => {
    const preparedGet = vi.fn().mockReturnValue(undefined)
    mockGet.mockReturnValue({
      prepare: vi.fn().mockReturnValue({ get: preparedGet }),
    })

    const req = makeReq({ authorization: 'Bearer tflw_pat_unknown-token' })
    expect(verifyPat(req)).toBeNull()
  })
})

// --- requireBuildAuth ---

describe('requireBuildAuth', () => {
  beforeEach(() => vi.resetAllMocks())

  it('PAT가 있고 builds:write scope이면 userId 반환', () => {
    const rawToken = 'tflw_pat_test-build-token'
    const preparedGet = vi.fn().mockReturnValue({ user_id: 3, scope: 'builds:write' })
    const preparedRun = vi.fn()
    mockGet.mockReturnValue({
      prepare: vi.fn()
        .mockReturnValueOnce({ get: preparedGet })
        .mockReturnValueOnce({ run: preparedRun }),
    })

    const req = makeReq({ authorization: `Bearer ${rawToken}` })
    const res = makeRes()
    const result = requireBuildAuth(req, res)

    expect(result).toEqual({ userId: 3 })
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('PAT가 있지만 scope이 부족하면 403 반환 후 null', () => {
    const rawToken = 'tflw_pat_test-wrong-scope'
    const preparedGet = vi.fn().mockReturnValue({ user_id: 5, scope: 'other:scope' })
    const preparedRun = vi.fn()
    mockGet.mockReturnValue({
      prepare: vi.fn()
        .mockReturnValueOnce({ get: preparedGet })
        .mockReturnValueOnce({ run: preparedRun }),
    })

    const req = makeReq({ authorization: `Bearer ${rawToken}` })
    const res = makeRes()
    const result = requireBuildAuth(req, res)

    expect(result).toBeNull()
    expect(res._calls[0]?.status).toBe(403)
    expect(JSON.parse(res._calls[0]?.body ?? '{}')).toMatchObject({ error: 'Insufficient scope' })
  })

  it('PAT 없고 유효한 JWT 쿠키면 userId 반환', () => {
    const token = signJwt(SAMPLE)
    const req = makeReq({ cookie: `tapflow_token=${token}` })
    const res = makeRes()
    const result = requireBuildAuth(req, res)

    expect(result).toEqual({ userId: SAMPLE.userId })
    expect(res.writeHead).not.toHaveBeenCalled()
  })

  it('PAT 없고 JWT 쿠키도 없으면 401 반환 후 null', () => {
    const req = makeReq()
    const res = makeRes()
    const result = requireBuildAuth(req, res)

    expect(result).toBeNull()
    expect(res._calls[0]?.status).toBe(401)
  })

  it('PAT가 만료/무효이면 JWT 쿠키로 fallback', () => {
    mockGet.mockReturnValue({
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    })

    const token = signJwt(SAMPLE)
    const req = makeReq({
      authorization: 'Bearer tflw_pat_expired-token',
      cookie: `tapflow_token=${token}`,
    })
    const res = makeRes()
    const result = requireBuildAuth(req, res)

    expect(result).toEqual({ userId: SAMPLE.userId })
  })
})
