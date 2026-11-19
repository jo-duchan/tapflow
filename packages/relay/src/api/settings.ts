import http from 'http'
import fs from 'fs'
import path from 'path'
import busboy from 'busboy'
import { randomUUID } from 'crypto'
import { getDb } from '../db.js'
import { requireRole, requireAuth } from '../middleware/auth.js'
import { json } from '../router.js'
import { pipeUpload, unlinkSafe, StorageFullError } from '../lib/uploads.js'
import { diskRoomFor, videoSettings, videoUsageBytes } from './runVideos.js'

/** Bounds for the video policy fields: 0 days keeps no passed video; the cap is at least 100 MB. */
const MAX_RETENTION_DAYS = 365
const MIN_CAP_MB = 100
const MAX_CAP_MB = 10 * 1024 * 1024

export function handleGetSettings(req: http.IncomingMessage, res: http.ServerResponse, videosDir?: string): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const settings = db.prepare('SELECT team_name, logo_path FROM team_settings WHERE id = 1').get() as
    { team_name: string; logo_path: string | null } | undefined

  // The video policy and what it is using. **The effective cap is the smaller of the setting and the disk's
  // room**, because a cap larger than the volume is a promise the disk cannot keep — the floor the relay keeps for
  // itself comes off first.
  const video = videoSettings()
  const usage = videoUsageBytes()
  const room = videosDir ? diskRoomFor(videosDir) : { free: Number.MAX_SAFE_INTEGER, floor: 0 }
  json(res, 200, {
    team_name: settings?.team_name ?? 'tapflow',
    logo_url: settings?.logo_path ? `/uploads/team/${path.basename(settings.logo_path)}` : null,
    video_pass_retention_days: video.passRetentionDays,
    video_storage_cap_mb: Math.round(video.storageCapBytes / (1024 * 1024)),
    video_usage_bytes: usage,
    video_effective_cap_bytes: Math.min(video.storageCapBytes, usage + Math.max(0, room.free - room.floor)),
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
    logoPath = path.join(uploadsDir, 'team', `logo${ext}`)
    fs.mkdirSync(path.dirname(logoPath), { recursive: true })

    // **Staged, then renamed into place.** It used to be written straight over the live image, so an upload
    // that failed partway left the current one empty or truncated. busboy also stops at the size limit
    // rather than erroring, which `'limit'` reports.
    stagedPath = `${logoPath}.${randomUUID()}.part`
    stream.on('limit', () => { sizeError = true })
    written = pipeUpload(stream, stagedPath, 'staged team logo')
  })

  bb.on('finish', async () => {
    // The policy fields are checked before the logo is put in place, so a refused update changes nothing.
    const videoFields: [string, number][] = []
    for (const [field, min, max] of [
      ['video_pass_retention_days', 0, MAX_RETENTION_DAYS],
      ['video_storage_cap_mb', MIN_CAP_MB, MAX_CAP_MB],
    ] as const) {
      const raw = fields[field]
      if (raw === undefined) continue
      const n = Number(raw)
      if (!/^\d+$/.test(raw) || n < min || n > max) {
        if (stagedPath) { await written?.catch(() => {}); unlinkSafe(stagedPath, 'staged team logo') }
        return json(res, 400, { error: `${field} must be an integer from ${min} to ${max}` })
      }
      videoFields.push([field, n])
    }
    if (sizeError) {
      if (stagedPath) unlinkSafe(stagedPath, 'oversized team logo')
      return json(res, 400, { error: 'Max 2MB for logo' })
    }
    if (written) {
      try {
        await written
        fs.renameSync(stagedPath, logoPath)
      } catch (err) {
        unlinkSafe(stagedPath, 'staged team logo')
        if (err instanceof StorageFullError) return json(res, 507, { error: err.message })
        return json(res, 500, { error: 'Update failed' })
      }
    }

    const db = getDb()
    const updates: string[] = ['updated_at = datetime(\'now\')']
    const params: unknown[] = []

    // Trimmed, and a blank one is skipped like an empty one: a name of only spaces showed blank in the sidebar.
    const teamName = fields.team_name?.trim()
    if (teamName) { updates.push('team_name = ?'); params.push(teamName) }
    for (const [field, n] of videoFields) { updates.push(`${field} = ?`); params.push(n) }
    if (logoPath) { updates.push('logo_path = ?'); params.push(logoPath) }

    params.push(1)
    db.prepare(`UPDATE team_settings SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    json(res, 200, { ok: true })
  })

  bb.on('error', () => json(res, 500, { error: 'Update failed' }))
  req.pipe(bb)
}
