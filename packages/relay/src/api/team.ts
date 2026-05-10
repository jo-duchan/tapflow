import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db'
import { requireRole } from '../middleware/auth'
import { json, readJson } from '../router'

export function handleListMembers(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const db = getDb()
  const members = db.prepare(
    'SELECT id, email, display_name, role, joined_at FROM users ORDER BY joined_at ASC'
  ).all()
  json(res, 200, members)
}

export async function handleInvite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const body = await readJson<{ email?: string; role?: string }>(req)
  const role = ['Admin', 'Developer', 'QA', 'Viewer'].includes(body.role ?? '')
    ? body.role!
    : 'QA'

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()

  const db = getDb()
  db.prepare('INSERT INTO invitations (token, email, role, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, body.email ?? null, role, expiresAt)

  json(res, 201, { token })
}

export async function handleUpdateMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const body = await readJson<{ role?: string }>(req)
  if (!body.role || !['Admin', 'Developer', 'QA', 'Viewer'].includes(body.role)) {
    return json(res, 400, { error: 'Valid role required' })
  }

  const db = getDb()
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Member not found' })
  json(res, 200, { ok: true })
}

export function handleDeleteMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  if (String(auth.userId) === params.id) {
    return json(res, 400, { error: 'Cannot remove yourself' })
  }

  const db = getDb()
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Member not found' })
  json(res, 204, null)
}
