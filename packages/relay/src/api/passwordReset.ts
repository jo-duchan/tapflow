import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { makePasswordHash } from './auth.js'
import { sendMail } from '../lib/mailer.js'
import { json, readJson } from '../router.js'

export async function sendPasswordResetEmail(userId: number, origin: string): Promise<boolean> {
  const db = getDb()
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: number; email: string } | undefined
  if (!user) return false

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt)

  const link = `${origin}/reset-password?token=${token}`
  const html = `<p>A password reset was requested for your tapflow account.</p>
<p><a href="${link}">Reset your password</a></p>
<p>This link expires in 2 hours. If you did not request this, ignore this email.</p>`

  return sendMail(user.email, 'Reset your tapflow password', html)
}

export function handleVerifyReset(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  if (!token) return json(res, 400, { error: 'token required' })

  const db = getDb()
  const row = db.prepare(`
    SELECT id FROM password_reset_tokens
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(token) as { id: number } | undefined

  if (!row) return json(res, 410, { error: 'Token expired or not found' })
  json(res, 200, { ok: true })
}

export async function handleDoReset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ token: string; password: string }>(req)
  if (!body.token || !body.password) return json(res, 400, { error: 'token and password required' })
  if (body.password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

  const db = getDb()
  const row = db.prepare(`
    SELECT id, user_id FROM password_reset_tokens
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(body.token) as { id: number; user_id: number } | undefined

  if (!row) return json(res, 410, { error: 'Token expired or not found' })

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(makePasswordHash(body.password), row.user_id)
  db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id)

  json(res, 200, { ok: true })
}

export async function handleSendMemberReset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const db = getDb()
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(params.id) as { id: number } | undefined
  if (!member) return json(res, 404, { error: 'Member not found' })

  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
  const origin = `${proto}://${req.headers.host}`
  const emailSent = await sendPasswordResetEmail(member.id, origin)

  json(res, 200, { ok: true, emailSent })
}
