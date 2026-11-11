import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { sessionCookie } from '../middleware/auth.js'
import { normalizeEmail, EMAIL_KEY_SQL, SYNTHETIC_EMAIL_DOMAIN } from '../lib/email.js'
import { makePasswordHash } from './auth.js'
import { json } from '../router.js'

// token, password, display_name — with room for a client that sends one more.
const ACCEPT_FIELDS = 8
const ACCEPT_FIELD_BYTES = 16 * 1024

export function handleVerify(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  if (!token) return json(res, 400, { error: 'token required' })

  const db = getDb()
  const inv = db.prepare(`
    SELECT role FROM invitations
    WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
  `).get(token) as { role: string } | undefined

  if (!inv) return json(res, 410, { error: 'Invitation expired or not found' })
  json(res, 200, { role: inv.role })
}

export function handleAccept(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string,
): void {
  // Bounded on every axis, because nothing here is checked until the whole form is read and anyone may send one:
  // busboy's defaults are 1 MiB per field and no limit on how many, so distinct field names held memory without
  // end. The form has three text fields and one file.
  const bb = busboy({
    headers: req.headers,
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: ACCEPT_FIELDS, fieldSize: ACCEPT_FIELD_BYTES },
  })
  const fields: Record<string, string> = {}
  let fileBuffer: Buffer | null = null
  let fileMime = ''
  let sizeError = false
  let formTooLarge = false

  bb.on('field', (name, val, info) => {
    if (info.valueTruncated) { formTooLarge = true; return }
    fields[name] = val
  })
  bb.on('fieldsLimit', () => { formTooLarge = true })
  bb.on('filesLimit', () => { formTooLarge = true })

  bb.on('file', (_field, stream, info) => {
    // busboy destroys a file's stream with an error when the body ends inside it, and a stream with no
    // `'error'` listener throws. The response is `bb`'s own `'error'` handler's job.
    stream.on('error', () => {})
    const allowed = ['image/png', 'image/jpeg']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    fileMime = info.mimeType
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => { chunks.push(c) })
    // busboy stops at `fileSize` rather than passing it, so counting bytes here never saw an oversized file and
    // kept its first 2 MB as the avatar. `'limit'` is how it says the file was cut.
    stream.on('limit', () => { sizeError = true })
    stream.on('end', () => { if (!sizeError) fileBuffer = Buffer.concat(chunks) })
  })

  bb.on('finish', () => {
    if (formTooLarge) return json(res, 413, { error: 'Body too large' })
    if (sizeError) return json(res, 400, { error: 'Max 2MB for avatar' })

    const { token, password } = fields
    if (!token || !password) return json(res, 400, { error: 'token and password required' })
    if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

    const db = getDb()
    const inv = db.prepare(`
      SELECT id, email, role FROM invitations
      WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    `).get(token) as { id: number; email: string | null; role: string } | undefined

    if (!inv) return json(res, 410, { error: 'Invitation expired or not found' })

    const passwordHash = makePasswordHash(password)
    const displayName = fields.display_name?.trim() || (inv.email?.split('@')[0] ?? 'User')

    // An invitation creates an account; it never changes one. Accepting for an address that already
    // has an account used to overwrite that account's password, role and name — an invite link worked
    // as a password reset nobody approved. The address may have joined since the invitation was made,
    // so this is checked here as well as when inviting.
    if (inv.email && isMemberEmail(inv.email)) {
      return json(res, 409, { error: 'This email already has an account. Sign in instead.' })
    }

    const result = db.prepare(
      'INSERT INTO users (email, role, password_hash, display_name) VALUES (?, ?, ?, ?)'
    ).run(inv.email ? normalizeEmail(inv.email) : `user_${crypto.randomBytes(4).toString('hex')}${SYNTHETIC_EMAIL_DOMAIN}`, inv.role, passwordHash, displayName)
    const userId = result.lastInsertRowid as number

    if (fileBuffer && fileMime) {
      const ext = fileMime === 'image/png' ? '.png' : '.jpg'
      const avatarPath = path.join(uploadsDir, 'avatars', `user-${userId}${ext}`)
      fs.mkdirSync(path.dirname(avatarPath), { recursive: true })
      fs.writeFileSync(avatarPath, fileBuffer)
      db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(`/uploads/avatars/user-${userId}${ext}`, userId)
    }

    db.prepare("UPDATE invitations SET used_at = datetime('now') WHERE id = ?").run(inv.id)

    const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(userId) as { email: string; role: string }
    const cookie = sessionCookie({ userId, email: user.email, role: user.role })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie })
    res.end(JSON.stringify({ ok: true }))
  })

  bb.on('error', () => json(res, 500, { error: 'Failed to process request' }))
  req.pipe(bb)
}

/** Whether an address already belongs to a member, however it was capitalized or spaced when stored. */
export function isMemberEmail(email: string): boolean {
  return getDb().prepare(`SELECT 1 FROM users WHERE ${EMAIL_KEY_SQL} = ?`).get(normalizeEmail(email)) !== undefined
}
