import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import busboy from 'busboy'
import { requireAuth, getAuth } from '../middleware/auth.js'
import { getDb } from '../db.js'

const TTL_MS = 72 * 60 * 60 * 1000

function expiresAt(): string {
  return new Date(Date.now() + TTL_MS).toISOString().replace('T', ' ').slice(0, 19)
}

export function handleUploadRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recordingsDir: string,
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const u = new URL(req.url ?? '/', 'http://x')
  const sessionId = u.searchParams.get('sessionId') ?? null

  fs.mkdirSync(recordingsDir, { recursive: true })

  let filePath = ''
  let filename = ''
  let mime = 'video/webm'
  let saved = false

  const bb = busboy({ headers: req.headers as Record<string, string | string[]> })
  bb.on('file', (_field, fileStream, info) => {
    const ext = path.extname(info.filename || '.webm') || '.webm'
    mime = info.mimeType || mime
    filename = `${randomUUID()}-${Date.now()}${ext}`
    filePath = path.join(recordingsDir, filename)
    fileStream.pipe(fs.createWriteStream(filePath))
    saved = true
  })
  bb.on('finish', () => {
    if (!saved) { res.writeHead(400); res.end('No file'); return }

    const stat = fs.statSync(filePath)
    const db = getDb()
    db.prepare(`
      INSERT INTO recordings (filename, session_id, uploader_id, file_size, mime, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(filename, sessionId, auth.userId, stat.size, mime, expiresAt())

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ url: `/api/v1/recordings/${filename}` }))
  })
  bb.on('error', () => { res.writeHead(500); res.end('Upload failed') })
  req.pipe(bb)
}

export function handleListRecordings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const u = new URL(req.url ?? '/', 'http://x')
  const sessionId = u.searchParams.get('sessionId')

  const db = getDb()
  const rows = sessionId
    ? db.prepare(`
        SELECT id, filename, session_id, file_size, mime, created_at, expires_at
        FROM recordings
        WHERE expires_at > datetime('now') AND session_id = ?
        ORDER BY created_at DESC
      `).all(sessionId)
    : db.prepare(`
        SELECT id, filename, session_id, file_size, mime, created_at, expires_at
        FROM recordings
        WHERE expires_at > datetime('now')
        ORDER BY created_at DESC
      `).all()

  const result = (rows as {
    id: number
    filename: string
    session_id: string | null
    file_size: number
    mime: string
    created_at: string
    expires_at: string
  }[]).map((r) => ({
    id: r.id,
    url: `/api/v1/recordings/${r.filename}`,
    sessionId: r.session_id,
    fileSize: r.file_size,
    mime: r.mime,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }))

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

export function handleDownloadRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recordingsDir: string,
): void {
  const auth = getAuth(req)
  if (!auth) { res.writeHead(401); res.end('Unauthorized'); return }

  const filename = (req.url ?? '/').split('/').pop() ?? ''
  if (!filename || filename.includes('..') || filename.includes('/')) {
    res.writeHead(400); res.end('Invalid filename'); return
  }

  const db = getDb()
  const row = db.prepare(`
    SELECT status, expires_at FROM recordings WHERE filename = ?
  `).get(filename) as { status: string; expires_at: string } | undefined

  if (!row) { res.writeHead(404); res.end('Not found'); return }

  if (row.status === 'expired' || new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM recordings WHERE filename = ?`).run(filename)
    fs.unlink(path.join(recordingsDir, filename), () => {})
    res.writeHead(404); res.end('Expired'); return
  }

  const filePath = path.join(recordingsDir, filename)
  if (!fs.existsSync(filePath)) {
    db.prepare(`DELETE FROM recordings WHERE filename = ?`).run(filename)
    res.writeHead(404); res.end('Not found'); return
  }

  const stat = fs.statSync(filePath)
  res.writeHead(200, {
    'Content-Type': row.status === 'ready' ? 'video/webm' : 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
  })
  fs.createReadStream(filePath).pipe(res)
}

export function purgeExpiredRecordings(recordingsDir: string): void {
  if (!fs.existsSync(recordingsDir)) return

  try {
    const db = getDb()
    const expired = db.prepare(`
      SELECT filename FROM recordings
      WHERE status = 'ready' AND expires_at < datetime('now')
    `).all() as { filename: string }[]

    for (const { filename } of expired) {
      fs.unlink(path.join(recordingsDir, filename), () => {})
    }
    if (expired.length > 0) {
      const placeholders = expired.map(() => '?').join(',')
      db.prepare(`DELETE FROM recordings WHERE filename IN (${placeholders})`).run(...expired.map((r) => r.filename))
    }

    // orphan 파일 정리 (DB row 없는 파일)
    for (const file of fs.readdirSync(recordingsDir)) {
      const row = db.prepare(`SELECT id FROM recordings WHERE filename = ?`).get(file)
      if (!row) fs.unlink(path.join(recordingsDir, file), () => {})
    }
  } catch {
    // DB 미초기화 시 (테스트 등) — 파일명 기반 TTL fallback
    for (const file of fs.readdirSync(recordingsDir)) {
      const match = file.match(/-(\d+)\.[^.]+$/)
      if (match && Date.now() - Number(match[1]) > TTL_MS) {
        fs.unlink(path.join(recordingsDir, file), () => {})
      }
    }
  }
}
