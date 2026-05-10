import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { getDb } from '../db'
import { requireAuth } from '../middleware/auth'
import { json } from '../router'

export function handleListComments(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const buildId = new URL(req.url ?? '/', 'http://x').searchParams.get('build_id')
  if (!buildId) return json(res, 400, { error: 'build_id required' })

  const db = getDb()
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, u.display_name as author,
           u.email
    FROM comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.build_id = ?
    ORDER BY c.created_at ASC
  `).all(buildId)

  const attachments = db.prepare(`
    SELECT ca.id, ca.comment_id, ca.file_path, ca.mime
    FROM comment_attachments ca
    JOIN comments c ON c.id = ca.comment_id
    WHERE c.build_id = ?
  `).all(buildId) as { id: number; comment_id: number; file_path: string; mime: string }[]

  const attachMap = new Map<number, typeof attachments>()
  for (const a of attachments) {
    if (!attachMap.has(a.comment_id)) attachMap.set(a.comment_id, [])
    attachMap.get(a.comment_id)!.push(a)
  }

  const result = (comments as { id: number; body: string; created_at: string; author: string; email: string }[])
    .map((c) => ({
      ...c,
      author: c.author || c.email,
      attachments: (attachMap.get(c.id) ?? []).map((a) => ({
        id: a.id,
        file_path: `/uploads/comments/${path.basename(a.file_path)}`,
        mime: a.mime,
      })),
    }))

  json(res, 200, result)
}

export function handleCreateComment(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let attachmentPath = ''
  let attachmentMime = ''
  let sizeError = false

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[info.mimeType]!
    const fileName = `${Date.now()}${ext}`
    attachmentPath = path.join(uploadsDir, 'comments', fileName)
    attachmentMime = info.mimeType
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true })

    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 5 * 1024 * 1024) sizeError = true
    })
    stream.pipe(fs.createWriteStream(attachmentPath))
  })

  bb.on('finish', () => {
    if (sizeError) return json(res, 400, { error: 'Max 5MB per attachment' })
    if (!fields.build_id || !fields.body?.trim()) {
      return json(res, 400, { error: 'build_id and body required' })
    }

    const db = getDb()
    const commentResult = db.prepare(
      'INSERT INTO comments (build_id, author_id, body) VALUES (?, ?, ?)'
    ).run(fields.build_id, auth.userId, fields.body.trim())

    const commentId = commentResult.lastInsertRowid as number

    if (attachmentPath) {
      const size = fs.statSync(attachmentPath).size
      db.prepare(
        'INSERT INTO comment_attachments (comment_id, file_path, mime, size) VALUES (?, ?, ?, ?)'
      ).run(commentId, attachmentPath, attachmentMime, size)
    }

    const comment = db.prepare(`
      SELECT c.id, c.body, c.created_at, u.display_name as author
      FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(commentId)

    json(res, 201, comment)
  })

  bb.on('error', () => json(res, 500, { error: 'Upload failed' }))
  req.pipe(bb)
}

export function handleDeleteComment(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const comment = db.prepare('SELECT author_id FROM comments WHERE id = ?').get(params.id) as { author_id: number } | undefined
  if (!comment) return json(res, 404, { error: 'Comment not found' })

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(auth.userId) as { role: string }
  if (comment.author_id !== auth.userId && user.role !== 'Admin') {
    return json(res, 403, { error: 'Forbidden' })
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(params.id)
  json(res, 204, null)
}
