import http from 'http'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { requireAuth, hashPat } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { AGENT_SCOPE } from '../lib/connectionAuth.js'

const ALLOWED_SCOPES = new Set(['view', 'builds:write', AGENT_SCOPE])
const DEFAULT_SCOPE = 'view,builds:write'

export function handleListTokens(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const tokens = db.prepare(
    'SELECT id, name, scope, last_used_at, expires_at, created_at FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(auth.userId)
  json(res, 200, tokens)
}

export async function handleCreateToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  const body = await readJson<{ name?: string; expires_in_days?: number; scope?: string }>(req)
  if (!body.name?.trim()) return json(res, 400, { error: 'name required' })

  const scopes = (body.scope?.trim() || DEFAULT_SCOPE).split(',').map((s) => s.trim())
  if (scopes.some((s) => !ALLOWED_SCOPES.has(s))) {
    return json(res, 400, { error: `Invalid scope. Allowed: ${[...ALLOWED_SCOPES].join(', ')}` })
  }
  // agent 스코프 토큰은 화면을 공급하는 에이전트의 자격이므로 발급을 Admin으로 제한한다 (#271).
  if (scopes.includes(AGENT_SCOPE) && auth.role !== 'Admin') {
    return json(res, 403, { error: `'${AGENT_SCOPE}' scope requires the Admin role` })
  }

  const rawToken = `tflw_pat_${crypto.randomBytes(32).toString('hex')}`
  const tokenHash = hashPat(rawToken)
  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 24 * 3600 * 1000).toISOString()
    : null

  const db = getDb()
  db.prepare(
    'INSERT INTO personal_access_tokens (user_id, name, token_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(auth.userId, body.name.trim(), tokenHash, scopes.join(','), expiresAt)

  json(res, 201, { token: rawToken })
}

export function handleRevokeToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const result = db.prepare(
    'DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?'
  ).run(params.id, auth.userId)

  if (result.changes === 0) return json(res, 404, { error: 'Token not found' })
  json(res, 204, null)
}
