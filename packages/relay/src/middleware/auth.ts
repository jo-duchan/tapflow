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

/** A signed-in session: who the cookie names, as the users table describes them now. */
export interface SessionAuth extends AuthContext {
  /** The JWT's `exp` (seconds since the epoch), so an open socket can be closed when it passes. */
  exp?: number
}

/**
 * The cookie's user, **checked against the users table on every call**.
 *
 * The JWT lives seven days and removing a member deletes their row, so a signature check alone kept a
 * removed member signed in for up to a week on every cookie path: this function, `requireViewAuth`,
 * `requireBuildAuth`, recordings, and the WebSocket handshake. This is the one place all of them pass,
 * so the row check lives here. User ids are `AUTOINCREMENT`, so a removed id never comes back and "the
 * row exists" is a sound test. `email` and `role` come from the row, never from the JWT.
 *
 * Only the JWT verification failure becomes `null`. A database error propagates: turning a transient
 * `SQLITE_BUSY` into "not signed in" would sign everyone out and hide the fault.
 */
export function getAuth(req: http.IncomingMessage): SessionAuth | null {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)tapflow_token=([^;]+)/.exec(cookie)
  if (!match) return null
  const claims = verifyJwt(match[1]) as (AuthContext & { exp?: number }) | null
  if (!claims) return null
  const user = findUser(claims.userId)
  if (!user) return null
  return { userId: claims.userId, email: user.email, role: user.role, exp: claims.exp }
}

export function findUser(userId: number): { email: string; role: string } | null {
  const row = getDb().prepare('SELECT email, role FROM users WHERE id = ?').get(userId) as
    | { email: string; role: string }
    | undefined
  return row ?? null
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

/** A live PAT and its owner, as the database describes them now. */
export interface PatAuth {
  patId: number
  userId: number
  scopes: string[]
  ownerEmail: string
  ownerRole: string
}

interface PatRow { id: number; user_id: number; scope: string; email: string; role: string }

function toPatAuth(row: PatRow): PatAuth {
  return {
    patId: row.id,
    userId: row.user_id,
    scopes: row.scope.split(',').map((s) => s.trim()),
    ownerEmail: row.email,
    ownerRole: row.role,
  }
}

// Joined with users so the owner's current role comes with the token: an `agent` token is only as good
// as its owner's Admin role, and a Viewer's `builds:write` token is refused on write routes.
// `datetime(expires_at)`, not the bare column: it is written by `toISOString()` ('2026-09-27T10:00:00.000Z')
// and `datetime('now')` is '2026-09-27 10:00:00'. Compared as text, 'T' sorts after ' ', so a token that
// expired this morning kept passing until the end of its UTC day.
const PAT_SELECT = `
  SELECT pat.id, pat.user_id, pat.scope, u.email, u.role
  FROM personal_access_tokens pat
  JOIN users u ON u.id = pat.user_id
  WHERE (pat.expires_at IS NULL OR datetime(pat.expires_at) > datetime('now'))`

/**
 * The PAT on this request, or null when there is none, it is unknown, or it has expired.
 *
 * **Reads only.** `last_used_at` is written by `touchPat` once the credential check has accepted the
 * token: a token refused there (a scope it lacks, a WebSocket refused for its scope or its owner's
 * role) is not used, and a "last used" that moved on those told an Admin a leaked token was in use
 * when nothing got through. A route that accepts the token and then refuses the request on the
 * owner's role (`assertCanWrite` for a Viewer) still counts as a use — the token did reach the route.
 */
export function verifyPat(req: http.IncomingMessage): PatAuth | null {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer tflw_pat_')) return null
  const hash = hashPat(header.slice(7))
  const row = getDb().prepare(`${PAT_SELECT} AND pat.token_hash = ?`).get(hash) as PatRow | undefined
  return row ? toPatAuth(row) : null
}

/** The same lookup by id, for re-checking a token an open socket was accepted with. */
export function findPat(patId: number): PatAuth | null {
  const row = getDb().prepare(`${PAT_SELECT} AND pat.id = ?`).get(patId) as PatRow | undefined
  return row ? toPatAuth(row) : null
}

export function touchPat(patId: number): void {
  getDb().prepare(`UPDATE personal_access_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(patId)
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
  if (!pat.scopes.includes('view')) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Insufficient scope' }))
    return null
  }
  touchPat(pat.patId)
  return { userId: pat.userId, email: pat.ownerEmail, role: pat.ownerRole }
}

export function requireBuildAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse
): { userId: number } | null {
  const pat = verifyPat(req)
  if (pat !== null) {
    if (!pat.scopes.includes('builds:write')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Insufficient scope' }))
      return null
    }
    touchPat(pat.patId)
    return { userId: pat.userId }
  }
  const auth = requireAuth(req, res)
  if (!auth) return null
  return { userId: auth.userId }
}
