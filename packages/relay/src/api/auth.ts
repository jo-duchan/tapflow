import http from 'http'
import { getDb } from '../db.js'
import { makePasswordHash, verifyPassword, isInitialized, createAdminAccount } from '../lib/adminAccount.js'
import { signJwt, requireAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { config } from '../lib/config.js'
import { resolveRequestClient } from '../lib/clientAddress.js'
import { createRateLimiter, type RateLimiter } from '../middleware/rateLimit.js'

// 로그인 무차별 대입 방어: IP+계정 단위로 실패를 세고 지수 백오프로 잠근다.
const loginLimiter = createRateLimiter()

// Hashing and the first-owner rules live in `lib/adminAccount.ts`, because the boot-time bootstrap
// needs them too and a `lib/` module must not import this layer. Re-exported here so the callers
// that already reach for them through this module keep their import path.
export { makePasswordHash, verifyPassword, isInitialized, createAdminAccount } from '../lib/adminAccount.js'
export type { CreateAdminResult } from '../lib/adminAccount.js'

export async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  trustedProxies: string[] = config.local.trustedProxies,
  limiter: RateLimiter = loginLimiter,
): Promise<void> {
  const body = await readJson<{ email: string; password: string }>(req)
  if (!body.email || !body.password) return json(res, 400, { error: 'email and password required' })

  const key = `${resolveRequestClient(req, trustedProxies).addr}|${body.email.toLowerCase()}`
  const gate = limiter.check(key)
  if (!gate.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) })
    res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }))
    return
  }

  const db = getDb()
  const user = db.prepare(
    'SELECT id, email, role, password_hash FROM users WHERE email = ?'
  ).get(body.email) as { id: number; email: string; role: string; password_hash: string | null } | undefined

  if (!user || !user.password_hash || !verifyPassword(body.password, user.password_hash)) {
    limiter.recordFailure(key)
    return json(res, 401, { error: 'Invalid credentials' })
  }
  limiter.reset(key)

  const token = signJwt({ userId: user.id, email: user.email, role: user.role })
  const cookie = `tapflow_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie })
  res.end(JSON.stringify({ ok: true, role: user.role }))
}

export function handleMe(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const user = db.prepare('SELECT id, email, display_name, avatar_url, role FROM users WHERE id = ?').get(auth.userId) as
    { id: number; email: string; display_name: string | null; avatar_url: string | null; role: string } | undefined

  if (!user) return json(res, 404, { error: 'User not found' })
  const displayName = user.display_name ?? user.email.split('@')[0]
  json(res, 200, { id: user.id, email: user.email, displayName, avatarUrl: user.avatar_url, role: user.role })
}

export async function handleChangePassword(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  const body = await readJson<{ currentPassword: string; newPassword: string }>(req)
  if (!body.currentPassword || !body.newPassword) return json(res, 400, { error: 'currentPassword and newPassword required' })
  if (body.newPassword.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

  const db = getDb()
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(auth.userId) as { password_hash: string | null } | undefined
  if (!user?.password_hash) return json(res, 400, { error: 'No password set' })
  if (!verifyPassword(body.currentPassword, user.password_hash)) return json(res, 401, { error: 'Incorrect current password' })

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(makePasswordHash(body.newPassword), auth.userId)
  json(res, 200, { ok: true })
}

export function handleLogout(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': 'tapflow_token=; HttpOnly; Path=/; Max-Age=0',
  })
  res.end(JSON.stringify({ ok: true }))
}

// The one rule for who may create the first admin, read by both `auth/init` and `auth/status` so the
// page that asks for the account and the endpoint that refuses it cannot disagree.
function mayInitialize(req: http.IncomingMessage, trustedProxies: string[]): boolean {
  return resolveRequestClient(req, trustedProxies).isLocal
}

// `canInitialize` lets the setup page show the instruction instead of a form this browser could only
// submit to a 403. It is advice to the page, not the gate: `handleInit` still refuses on its own.
export function handleAuthStatus(req: http.IncomingMessage, res: http.ServerResponse, trustedProxies: string[] = config.local.trustedProxies): void {
  const initialized = isInitialized()
  json(res, 200, { initialized, canInitialize: !initialized && mayInitialize(req, trustedProxies) })
}

export async function handleInit(req: http.IncomingMessage, res: http.ServerResponse, trustedProxies: string[] = config.local.trustedProxies): Promise<void> {
  // 무인증 부트스트랩(`auth/init`)은 노출 인스턴스에서 최초 부팅~소유자 설정 사이 선점당할 수 있다.
  // localhost 출처만 허용 → 원격 선점 차단. 헤드리스 서버는 SSH로 들어가 그 서버에서 admin init 실행.
  if (!mayInitialize(req, trustedProxies)) {
    return json(res, 403, { error: 'Initialization is only allowed from localhost. Run `tapflow admin init` on the relay host.' })
  }

  // The owner check stays ahead of reading the body, as it was: an already-initialized install
  // answers 403 without parsing anything.
  if (isInitialized()) return json(res, 403, { error: 'Already initialized' })

  const body = await readJson<{ email: string; password: string }>(req)
  const result = createAdminAccount(body.email, body.password)
  switch (result) {
    case 'missing-fields': return json(res, 400, { error: 'email and password required' })
    case 'password-too-short': return json(res, 400, { error: 'Password must be at least 8 characters' })
    case 'ok': return json(res, 201, { ok: true })
    // `noImplicitReturns` is off here, so a new member of `CreateAdminResult` would compile and fall
    // through — leaving the request with no response at all, hanging until the caller's own timeout.
    // `never` makes that a type error instead. The boot path guards the same way.
    default: {
      const unreachable: never = result
      return json(res, 500, { error: `Unhandled result: ${String(unreachable)}` })
    }
  }
}
