import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { signJwt, requireAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { config } from '../lib/config.js'
import { resolveClientAddress } from '../lib/clientAddress.js'
import { createRateLimiter, type RateLimiter } from '../middleware/rateLimit.js'

function resolveClient(req: http.IncomingMessage, trustedProxies: string[]) {
  const xff = req.headers['x-forwarded-for']
  return resolveClientAddress({
    socketAddr: req.socket.remoteAddress ?? '',
    forwardedFor: Array.isArray(xff) ? xff[0] : xff,
    trustedProxies,
  })
}

// 로그인 무차별 대입 방어: IP+계정 단위로 실패를 세고 지수 백오프로 잠근다.
const loginLimiter = createRateLimiter()

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
}

export function makePasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashPassword(password, salt)
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const computed = Buffer.from(hashPassword(password, salt), 'hex')
  const expected = Buffer.from(hash, 'hex')
  // 저장 해시 포맷 손상 시 길이 불일치로 timingSafeEqual이 RangeError → 안전 실패로 처리.
  if (computed.length !== expected.length) return false
  return crypto.timingSafeEqual(computed, expected)
}

export async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  trustedProxies: string[] = config.local.trustedProxies,
  limiter: RateLimiter = loginLimiter,
): Promise<void> {
  const body = await readJson<{ email: string; password: string }>(req)
  if (!body.email || !body.password) return json(res, 400, { error: 'email and password required' })

  const key = `${resolveClient(req, trustedProxies).addr}|${body.email.toLowerCase()}`
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

export function handleAuthStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb()
  const { n } = db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  json(res, 200, { initialized: n > 0 })
}

export async function handleInit(req: http.IncomingMessage, res: http.ServerResponse, trustedProxies: string[] = config.local.trustedProxies): Promise<void> {
  // 무인증 부트스트랩(`auth/init`)은 노출 인스턴스에서 최초 부팅~소유자 설정 사이 선점당할 수 있다.
  // localhost 출처만 허용 → 원격 선점 차단. 헤드리스 서버는 SSH로 들어가 그 서버에서 admin init 실행.
  if (!resolveClient(req, trustedProxies).isLocal) {
    return json(res, 403, { error: 'Initialization is only allowed from localhost. Run `tapflow admin init` on the relay host.' })
  }

  const db = getDb()
  const { n } = db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  if (n > 0) return json(res, 403, { error: 'Already initialized' })

  const body = await readJson<{ email: string; password: string }>(req)
  if (!body.email || !body.password) return json(res, 400, { error: 'email and password required' })
  if (body.password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

  db.prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(body.email, 'Admin', 'Admin', makePasswordHash(body.password))

  json(res, 201, { ok: true })
}
