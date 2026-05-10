import http from 'http'
import jwt from 'jsonwebtoken'
import { getDb } from '../db'

export interface AuthContext {
  userId: number
  email: string
  role: string
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'tapflow-dev-secret-change-in-production'
const JWT_EXPIRES = '7d'

export function signJwt(payload: AuthContext): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

export function verifyJwt(token: string): AuthContext | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthContext
  } catch {
    return null
  }
}

export function getAuth(req: http.IncomingMessage): AuthContext | null {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)tapflow_token=([^;]+)/.exec(cookie)
  if (!match) return null
  return verifyJwt(match[1])
}

export function requireAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse
): AuthContext | null {
  const auth = getAuth(req)
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  return auth
}

export function requireRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roles: string[]
): AuthContext | null {
  const auth = requireAuth(req, res)
  if (!auth) return null
  if (!roles.includes(auth.role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Forbidden' }))
    return null
  }
  return auth
}

export function verifyPat(req: http.IncomingMessage): { userId: number; scope: string } | null {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer tflw_pat_')) return null
  const token = header.slice(7)
  const hash = hashPat(token)
  const db = getDb()
  const row = db.prepare(`
    SELECT pat.user_id, pat.scope
    FROM personal_access_tokens pat
    WHERE pat.token_hash = ?
      AND (pat.expires_at IS NULL OR pat.expires_at > datetime('now'))
  `).get(hash) as { user_id: number; scope: string } | undefined
  if (!row) return null
  db.prepare(`UPDATE personal_access_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`).run(hash)
  return { userId: row.user_id, scope: row.scope }
}

export function hashPat(token: string): string {
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(token).digest('hex')
}
