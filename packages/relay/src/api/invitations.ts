import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { signJwt } from '../middleware/auth.js'
import { makePasswordHash } from './auth.js'
import { json } from '../router.js'

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

export function handleAccept(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const bb = busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let fileBuffer: Buffer | null = null
  let fileMime = ''
  let sizeError = false

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    const allowed = ['image/png', 'image/jpeg']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    fileMime = info.mimeType
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (c: Buffer) => {
      size += c.length
      if (size <= 2 * 1024 * 1024) chunks.push(c)
      else sizeError = true
    })
    stream.on('end', () => { if (!sizeError) fileBuffer = Buffer.concat(chunks) })
  })

  bb.on('finish', () => {
    if (sizeError) return json(res, 400, { error: 'Max 2MB for avatar' })

    const { token, password } = fields
    if (!token || !password) return json(res, 400, { error: 'token and password required' })
    if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

    const db = getDb()
    const inv = db.prepare(`
      SELECT id, email, role FROM invitations
      WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
    `).get(token) as { id: number; email: string | null; role: string } | undefined

    if (!inv) return json(res, 410, { error: 'Invitation expired or not found' })

    const passwordHash = makePasswordHash(password)
    const displayName = fields.display_name?.trim() || (inv.email?.split('@')[0] ?? 'User')

    let userId: number
    const existing = inv.email
      ? db.prepare('SELECT id FROM users WHERE email = ?').get(inv.email) as { id: number } | undefined
      : undefined

    if (existing) {
      db.prepare('UPDATE users SET password_hash = ?, role = ?, display_name = ? WHERE id = ?')
        .run(passwordHash, inv.role, displayName, existing.id)
      userId = existing.id
    } else {
      const result = db.prepare(
        'INSERT INTO users (email, role, password_hash, display_name) VALUES (?, ?, ?, ?)'
      ).run(inv.email ?? `user_${crypto.randomBytes(4).toString('hex')}@tapflow.local`, inv.role, passwordHash, displayName)
      userId = result.lastInsertRowid as number
    }

    if (fileBuffer && fileMime) {
      const ext = fileMime === 'image/png' ? '.png' : '.jpg'
      const avatarPath = path.join(uploadsDir, 'avatars', `user-${userId}${ext}`)
      fs.mkdirSync(path.dirname(avatarPath), { recursive: true })
      fs.writeFileSync(avatarPath, fileBuffer)
      db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(`/uploads/avatars/user-${userId}${ext}`, userId)
    }

    db.prepare("UPDATE invitations SET used_at = datetime('now') WHERE id = ?").run(inv.id)

    const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(userId) as { email: string; role: string }
    const jwtToken = signJwt({ userId, email: user.email, role: user.role })
    const cookie = `tapflow_token=${jwtToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie })
    res.end(JSON.stringify({ ok: true }))
  })

  bb.on('error', () => json(res, 500, { error: 'Failed to process request' }))
  req.pipe(bb)
}
