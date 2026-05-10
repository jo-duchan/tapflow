import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { makePasswordHash } from './auth'
import { json, readJson } from '../router'

export function handleVerify(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  if (!token) return json(res, 400, { error: 'token required' })

  const db = getDb()
  const inv = db.prepare(`
    SELECT role FROM invitations
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(token) as { role: string } | undefined

  if (!inv) return json(res, 410, { error: 'Invitation expired or not found' })
  json(res, 200, { role: inv.role })
}

export async function handleAccept(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ token: string; password: string }>(req)
  if (!body.token || !body.password) return json(res, 400, { error: 'token and password required' })
  if (body.password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

  const db = getDb()
  const inv = db.prepare(`
    SELECT id, email, role FROM invitations
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(body.token) as { id: number; email: string | null; role: string } | undefined

  if (!inv) return json(res, 410, { error: 'Invitation expired or not found' })

  const passwordHash = makePasswordHash(body.password)
  const displayName = inv.email?.split('@')[0] ?? 'User'

  let userId: number
  const existing = inv.email
    ? db.prepare('SELECT id FROM users WHERE email = ?').get(inv.email) as { id: number } | undefined
    : undefined

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?')
      .run(passwordHash, inv.role, existing.id)
    userId = existing.id
  } else {
    const result = db.prepare(
      'INSERT INTO users (email, role, password_hash, display_name) VALUES (?, ?, ?, ?)'
    ).run(inv.email ?? `user_${Date.now()}@tapflow.local`, inv.role, passwordHash, displayName)
    userId = result.lastInsertRowid as number
  }

  db.prepare('UPDATE invitations SET used_at = datetime(\'now\') WHERE id = ?').run(inv.id)

  const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(userId) as { email: string; role: string }
  const jwtToken = signJwt({ userId, email: user.email, role: user.role })
  const cookie = `tapflow_token=${jwtToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie })
  res.end(JSON.stringify({ ok: true }))
}
