import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { json } from '../router.js'

export function handleListComments(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const buildId = new URL(req.url ?? '/', 'http://x').searchParams.get('build_id')
  if (!buildId) return json(res, 400, { error: 'build_id required' })

  const db = getDb()
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at,
           COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1)) as author,
           u.avatar_url as authorAvatarUrl
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

  const result = (comments as { id: number; body: string; created_at: string; author: string; authorAvatarUrl: string | null }[])
    .map((c) => ({
      ...c,
      attachments: (attachMap.get(c.id) ?? []).map((a) => ({
        id: a.id,
        file_path: `/uploads/comments/${path.basename(a.file_path)}`,
        mime: a.mime,
      })),
    }))

  json(res, 200, result)
}

// 첨부 크기 상한(바이트). 기본 5 MB, TAPFLOW_MAX_COMMENT_BYTES로 조정 가능.
function maxCommentAttachmentBytes(): number {
  const v = Number(process.env.TAPFLOW_MAX_COMMENT_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024
}

export function handleCreateComment(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: maxCommentAttachmentBytes() } })
  const fields: Record<string, string> = {}
  let attachmentPath = ''
  let attachmentMime = ''
  let sizeError = false
  let writePromise: Promise<void> = Promise.resolve()

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[info.mimeType]!
    const fileName = `${Date.now()}${ext}`
    attachmentPath = path.join(uploadsDir, 'comments', fileName)
    attachmentMime = info.mimeType
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true })

    const ws = fs.createWriteStream(attachmentPath)
    writePromise = new Promise((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
    // 크기 상한 초과 시 busboy가 스트림을 잘라 보내므로, 잘린 첨부를 저장하면 안 된다.
    stream.on('limit', () => { sizeError = true })
    stream.pipe(ws)
  })

  bb.on('finish', async () => {
    // 쓰기 완료를 기다린 뒤 삭제해야 잘린 파일이 디스크에 남지 않는다.
    await writePromise.catch(() => {})
    if (sizeError) {
      if (attachmentPath) { try { fs.unlinkSync(attachmentPath) } catch { /* already gone */ } }
      return json(res, 400, { error: 'Max 5MB per attachment' })
    }
    if (!fields.build_id || !fields.body?.trim()) {
      return json(res, 400, { error: 'build_id and body required' })
    }

    const db = getDb()
    const commentResult = db.prepare(
      "INSERT INTO comments (build_id, author_id, body, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
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
