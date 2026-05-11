import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import busboy from 'busboy'
import { requireAuth } from '../middleware/auth.js'
import type { SessionManager } from '../SessionManager.js'

const TTL_MS = 72 * 60 * 60 * 1000

export function handleUploadRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recordingsDir: string,
  sessions: SessionManager,
): void {
  const u = new URL(req.url ?? '/', 'http://x')
  const sessionId = u.searchParams.get('sessionId') ?? ''
  if (!sessions.get(sessionId)) {
    res.writeHead(403); res.end('Invalid session'); return
  }

  fs.mkdirSync(recordingsDir, { recursive: true })

  let filePath = ''
  let saved = false

  const bb = busboy({ headers: req.headers as Record<string, string | string[]> })
  bb.on('file', (_field, fileStream, info) => {
    const ext = path.extname(info.filename || '.mov') || '.mov'
    filePath = path.join(recordingsDir, `${randomUUID()}-${Date.now()}${ext}`)
    fileStream.pipe(fs.createWriteStream(filePath))
    saved = true
  })
  bb.on('finish', () => {
    if (!saved) { res.writeHead(400); res.end('No file'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ url: `/api/v1/recordings/${path.basename(filePath)}` }))
  })
  bb.on('error', () => { res.writeHead(500); res.end('Upload failed') })
  req.pipe(bb)
}

export function handleDownloadRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recordingsDir: string,
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const filename = (req.url ?? '/').split('/').pop() ?? ''
  if (!filename || filename.includes('..') || filename.includes('/')) {
    res.writeHead(400); res.end('Invalid filename'); return
  }

  const filePath = path.join(recordingsDir, filename)
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return
  }

  const match = filename.match(/-(\d+)\.[^.]+$/)
  if (match && Date.now() - Number(match[1]) > TTL_MS) {
    fs.unlink(filePath, () => {})
    res.writeHead(404); res.end('Expired'); return
  }

  const stat = fs.statSync(filePath)
  res.writeHead(200, {
    'Content-Type': 'video/quicktime',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
  })
  fs.createReadStream(filePath).pipe(res)
}

export function purgeExpiredRecordings(recordingsDir: string): void {
  if (!fs.existsSync(recordingsDir)) return
  for (const file of fs.readdirSync(recordingsDir)) {
    const match = file.match(/-(\d+)\.[^.]+$/)
    if (match && Date.now() - Number(match[1]) > TTL_MS) {
      fs.unlink(path.join(recordingsDir, file), () => {})
    }
  }
}
