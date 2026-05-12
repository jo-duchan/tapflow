import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { json } from '../router.js'

export function handleUpdateProfile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let avatarPath = ''
  let sizeError = false

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    const allowed = ['image/png', 'image/jpeg']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    const ext = info.mimeType === 'image/png' ? '.png' : '.jpg'
    avatarPath = path.join(uploadsDir, 'avatars', `user-${auth.userId}${ext}`)
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true })

    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) sizeError = true
    })
    stream.pipe(fs.createWriteStream(avatarPath))
  })

  bb.on('finish', () => {
    if (sizeError) return json(res, 400, { error: 'Max 2MB for avatar' })

    const db = getDb()
    const updates: string[] = []
    const params: unknown[] = []

    if (fields.display_name !== undefined) { updates.push('display_name = ?'); params.push(fields.display_name || null) }
    if (avatarPath) { updates.push('avatar_url = ?'); params.push(`/uploads/avatars/${path.basename(avatarPath)}`) }

    if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

    params.push(auth.userId)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    json(res, 200, { ok: true })
  })

  bb.on('error', () => json(res, 500, { error: 'Update failed' }))
  req.pipe(bb)
}
