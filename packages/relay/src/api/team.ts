import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { sendMail } from '../lib/mailer.js'
import { config } from '../lib/config.js'
import { buildInviteBaseUrl, forTeammates, resolvePublicBaseUrl, type TunnelRuntime } from '../lib/publicUrl.js'

export function handleListMembers(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const db = getDb()
  const members = db.prepare(
    'SELECT id, email, display_name, role, joined_at FROM users ORDER BY joined_at ASC'
  ).all()
  json(res, 200, members)
}

export async function handleInvite(req: http.IncomingMessage, res: http.ServerResponse, tunnel?: TunnelRuntime): Promise<void> {
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

  // The dashboard copies the same link the mail carries (#788). It gets null when the only address is
  // the mail's localhost fallback or a loopback relay.url, and builds from the browser's origin instead.
  const inviteUrl = `${buildInviteBaseUrl(config, tunnel)}/invite?token=${token}`
  const offered = forTeammates(resolvePublicBaseUrl(config, tunnel)) === null ? null : inviteUrl

  let emailSent = false
  if (body.email) {
    const html = `<p>You've been invited to join tapflow as <strong>${role}</strong>.</p>
<p><a href="${inviteUrl}">Accept invitation</a></p>
<p>This link expires in 7 days.</p>`
    emailSent = await sendMail(body.email, 'You have been invited to tapflow', html)
  }

  json(res, 201, { token, emailSent, inviteUrl: offered })
}

export async function handleUpdateMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  onAuthChanged: () => void = () => {},
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
  // A demoted Admin's agent tokens stop working now, including on sockets already open.
  onAuthChanged()
  json(res, 200, { ok: true })
}

export function handleDeleteMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  onAuthChanged: () => void = () => {},
): void {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  if (String(auth.userId) === params.id) {
    return json(res, 400, { error: 'Cannot remove yourself' })
  }

  const db = getDb()
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Member not found' })
  // Their cookie and PATs (cascaded) stop working on HTTP at once; this closes their open sockets too.
  onAuthChanged()
  json(res, 204, null)
}
