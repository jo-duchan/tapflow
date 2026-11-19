import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { randomUUID } from 'crypto'
import { getDb } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { json } from '../router.js'
import { pipeUpload, unlinkSafe, StorageFullError } from '../lib/uploads.js'

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
  let stagedPath = ''
  let written: Promise<void> | null = null
  let sizeError = false

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    // busboy destroys a file's stream with an error when the body ends inside it, and a stream with no
    // `'error'` listener throws. The response is `bb`'s own `'error'` handler's job.
    stream.on('error', () => {})
    const allowed = ['image/png', 'image/jpeg']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    const ext = info.mimeType === 'image/png' ? '.png' : '.jpg'
    avatarPath = path.join(uploadsDir, 'avatars', `user-${auth.userId}${ext}`)
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true })

    // **Staged, then renamed into place.** It used to be written straight over the live image, so an upload
    // that failed partway left the current one empty or truncated. busboy also stops at the size limit
    // rather than erroring, which `'limit'` reports.
    stagedPath = `${avatarPath}.${randomUUID()}.part`
    stream.on('limit', () => { sizeError = true })
    written = pipeUpload(stream, stagedPath, 'staged avatar')
  })

  bb.on('finish', async () => {
    if (sizeError) {
      if (stagedPath) unlinkSafe(stagedPath, 'oversized avatar')
      return json(res, 400, { error: 'Max 2MB for avatar' })
    }
    if (written) {
      try {
        await written
        fs.renameSync(stagedPath, avatarPath)
      } catch (err) {
        unlinkSafe(stagedPath, 'staged avatar')
        if (err instanceof StorageFullError) return json(res, 507, { error: err.message })
        return json(res, 500, { error: 'Update failed' })
      }
    }

    const db = getDb()
    const updates: string[] = []
    const params: unknown[] = []

    // Trimmed, as invitations.ts does: a name of only spaces is stored as NULL, which `/me`, comments, builds and
    // runs turn into the email's local part, rather than as a blank name and a blank avatar.
    if (fields.display_name !== undefined) { updates.push('display_name = ?'); params.push(fields.display_name.trim() || null) }
    if (avatarPath) { updates.push('avatar_url = ?'); params.push(`/uploads/avatars/${path.basename(avatarPath)}`) }

    if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

    params.push(auth.userId)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    json(res, 200, { ok: true })
  })

  bb.on('error', () => json(res, 500, { error: 'Update failed' }))
  req.pipe(bb)
}
