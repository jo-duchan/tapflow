import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { getDb } from '../db'
import { requireRole, requireAuth } from '../middleware/auth'
import { json } from '../router'

export function handleGetSettings(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const settings = db.prepare('SELECT team_name, logo_path FROM team_settings WHERE id = 1').get() as
    { team_name: string; logo_path: string | null } | undefined

  json(res, 200, {
    team_name: settings?.team_name ?? 'tapflow',
    logo_url: settings?.logo_path ? `/uploads/team/${path.basename(settings.logo_path)}` : null,
  })
}

export function handleUpdateSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let logoPath = ''
  let sizeError = false

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    const allowed = ['image/png', 'image/jpeg']
    if (!allowed.includes(info.mimeType)) { stream.resume(); return }
    const ext = info.mimeType === 'image/png' ? '.png' : '.jpg'
    logoPath = path.join(uploadsDir, 'team', `logo${ext}`)
    fs.mkdirSync(path.dirname(logoPath), { recursive: true })

    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) sizeError = true
    })
    stream.pipe(fs.createWriteStream(logoPath))
  })

  bb.on('finish', () => {
    if (sizeError) return json(res, 400, { error: 'Max 2MB for logo' })

    const db = getDb()
    const updates: string[] = ['updated_at = datetime(\'now\')']
    const params: unknown[] = []

    if (fields.team_name) { updates.push('team_name = ?'); params.push(fields.team_name) }
    if (logoPath) { updates.push('logo_path = ?'); params.push(logoPath) }

    params.push(1)
    db.prepare(`UPDATE team_settings SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    json(res, 200, { ok: true })
  })

  bb.on('error', () => json(res, 500, { error: 'Update failed' }))
  req.pipe(bb)
}
