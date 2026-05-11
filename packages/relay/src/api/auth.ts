import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { signJwt, requireAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'

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
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, salt), 'hex'),
    Buffer.from(hash, 'hex')
  )
}

export async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ email: string; password: string }>(req)
  if (!body.email || !body.password) return json(res, 400, { error: 'email and password required' })

  const db = getDb()
  const user = db.prepare(
    'SELECT id, email, role, password_hash FROM users WHERE email = ?'
  ).get(body.email) as { id: number; email: string; role: string; password_hash: string | null } | undefined

  if (!user || !user.password_hash || !verifyPassword(body.password, user.password_hash)) {
    return json(res, 401, { error: 'Invalid credentials' })
  }

  const token = signJwt({ userId: user.id, email: user.email, role: user.role })
  const cookie = `tapflow_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie })
  res.end(JSON.stringify({ ok: true, role: user.role }))
}

export function handleMe(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const user = db.prepare('SELECT id, email, display_name, role FROM users WHERE id = ?').get(auth.userId) as
    { id: number; email: string; display_name: string | null; role: string } | undefined

  if (!user) return json(res, 404, { error: 'User not found' })
  json(res, 200, { id: user.id, email: user.email, displayName: user.display_name, role: user.role })
}

export function handleLogout(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': 'tapflow_token=; HttpOnly; Path=/; Max-Age=0',
  })
  res.end(JSON.stringify({ ok: true }))
}
