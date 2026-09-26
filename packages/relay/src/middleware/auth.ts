import http from 'http'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { AuthError } from '@tapflowio/agent-core'
import { getDb } from '../db.js'
import { getJwtSecret } from '../lib/config.js'

export interface AuthContext {
  userId: number
  email: string
  role: string
}

const JWT_EXPIRES = '7d'

export function signJwt(payload: AuthContext): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES })
}

export function verifyJwtOrThrow(token: string): AuthContext {
  try {
    return jwt.verify(token, getJwtSecret()) as AuthContext
  } catch (cause) {
    throw new AuthError('Invalid or expired auth token', { cause })
  }
}

export function verifyJwt(token: string): AuthContext | null {
  try {
    return verifyJwtOrThrow(token)
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

// The cookie JWT carries a role for its whole 7-day life, so a demoted member would keep their old
// rights for a week and a promoted one would be refused for a week. Every role decision reads the
// users table instead; the JWT only says who is asking. A missing row means the member was removed.
export function currentRole(res: http.ServerResponse, userId: number): string | null {
  const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as
    | { role: string }
    | undefined
  if (!row) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  return row.role
}

export function requireRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roles: string[]
): AuthContext | null {
  const auth = requireAuth(req, res)
  if (!auth) return null
  const role = currentRole(res, auth.userId)
  if (role === null) return null
  if (!roles.includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Forbidden' }))
    return null
  }
  return { ...auth, role }
}

// Viewer is read-only: it can look at builds, test them in a QA Session and comment, but not change
// builds, apps or webhooks. Called after a route's own auth, so it never changes which credentials
// the route accepts. The PAT path matters most here: any role can mint a builds:write token through
// the API, so the owner's role is what decides, at the moment the token is used.
export function assertCanWrite(res: http.ServerResponse, userId: number): boolean {
  const role = currentRole(res, userId)
  if (role === null) return false
  if (role === 'Viewer') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Viewers have read-only access' }))
    return false
  }
  return true
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
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function requireViewAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): AuthContext | null {
  const cookieAuth = getAuth(req)
  if (cookieAuth) return cookieAuth
  const pat = verifyPat(req)
  if (!pat) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  if (!pat.scope.split(',').map((s) => s.trim()).includes('view')) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Insufficient scope' }))
    return null
  }
  const user = getDb()
    .prepare('SELECT email, role FROM users WHERE id = ?')
    .get(pat.userId) as { email: string; role: string } | undefined
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  return { userId: pat.userId, email: user.email, role: user.role }
}

export function requireBuildAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse
): { userId: number } | null {
  const pat = verifyPat(req)
  if (pat !== null) {
    if (!pat.scope.split(',').map((s) => s.trim()).includes('builds:write')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Insufficient scope' }))
      return null
    }
    return { userId: pat.userId }
  }
  const auth = requireAuth(req, res)
  if (!auth) return null
  return { userId: auth.userId }
}
