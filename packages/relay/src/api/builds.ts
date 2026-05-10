import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import busboy from 'busboy'
import { getDb } from '../db'
import { requireAuth, verifyPat } from '../middleware/auth'
import { json, readJson } from '../router'

function extractBundleId(ipaPath: string): string | null {
  try {
    const list = spawnSync('unzip', ['-l', ipaPath], { encoding: 'utf8' })
    if (list.status !== 0) return null
    const match = list.stdout.match(/Payload\/[^/\s]+\.app\/Info\.plist/)
    if (!match) return null
    const plistEntry = match[0].trim()

    const extract = spawnSync('unzip', ['-p', ipaPath, plistEntry])
    if (extract.status !== 0) return null

    const plutil = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '-'], {
      input: extract.stdout as Buffer,
      encoding: 'utf8',
    })
    if (plutil.status !== 0) return null
    return (plutil.stdout as string).trim() || null
  } catch {
    return null
  }
}

export function handleListBuilds(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const u = new URL(req.url ?? '/', 'http://x')
  const page = Math.max(0, Number(u.searchParams.get('page') ?? 0))
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 20)))
  const q = u.searchParams.get('q') ?? ''
  const platform = u.searchParams.get('platform') ?? ''
  const status = u.searchParams.get('status') ?? ''
  const sortKey = ['uploaded_at', 'version_label', 'status_label'].includes(u.searchParams.get('sort') ?? '')
    ? u.searchParams.get('sort')!
    : 'uploaded_at'
  const sortDir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC'

  const db = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (q) { conditions.push(`(a.name LIKE ? OR a.version_label LIKE ?)`); params.push(`%${q}%`, `%${q}%`) }
  if (platform) { conditions.push(`a.platform = ?`); params.push(platform) }
  if (status) { conditions.push(`a.status_label = ?`); params.push(status) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const total = (db.prepare(`SELECT COUNT(*) as n FROM apps a ${where}`).get(...params) as { n: number }).n
  const items = db.prepare(`
    SELECT a.id, a.name, a.version_label, a.status_label, a.platform,
           a.uploaded_at, u.display_name as uploader
    FROM apps a
    LEFT JOIN users u ON u.id = a.uploader_id
    ${where}
    ORDER BY a.${sortKey} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, page * limit)

  json(res, 200, { items, total })
}

export function handleGetBuild(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const build = db.prepare(
    'SELECT id, name, version_label, status_label, platform, bundle_id, uploaded_at FROM apps WHERE id = ?'
  ).get(params.id)

  if (!build) return json(res, 404, { error: 'Build not found' })
  json(res, 200, build)
}

export async function handleUpdateBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  const body = await readJson<{ status_label?: string | null; version_label?: string | null }>(req)

  const VALID_STATUS = ['Backlog', 'In Progress', 'Done', 'Rejected']
  const updates: string[] = []
  const values: unknown[] = []

  if ('status_label' in body) {
    if (body.status_label !== null && !VALID_STATUS.includes(body.status_label ?? '')) {
      return json(res, 400, { error: 'Invalid status_label' })
    }
    updates.push('status_label = ?')
    values.push(body.status_label ?? null)
  }

  if ('version_label' in body) {
    updates.push('version_label = ?')
    values.push(body.version_label ?? null)
  }

  if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

  const db = getDb()
  const result = db.prepare(`UPDATE apps SET ${updates.join(', ')} WHERE id = ?`).run(...values, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  json(res, 200, { ok: true })
}

export function handleUploadBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const pat = verifyPat(req)
  const auth = pat ? { userId: pat.userId } : requireAuth(req, res)
  if (!auth) return

  if (pat && !pat.scope.includes('builds:write')) {
    return json(res, 403, { error: 'Insufficient scope' })
  }

  const bb = busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let savedPath = ''
  let originalName = ''
  let fileError = ''
  let writePromise: Promise<void> = Promise.resolve()

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    originalName = info.filename
    const ext = path.extname(originalName).toLowerCase()
    if (!['.ipa', '.apk'].includes(ext)) {
      fileError = 'Only .ipa or .apk files allowed'
      stream.resume()
      return
    }
    const fileName = `${Date.now()}_${path.basename(originalName)}`
    savedPath = path.join(uploadsDir, 'apps', fileName)
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    const ws = fs.createWriteStream(savedPath)
    writePromise = new Promise((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
    stream.pipe(ws)
  })

  bb.on('finish', async () => {
    if (fileError) return json(res, 400, { error: fileError })
    if (!savedPath) return json(res, 400, { error: 'File required' })

    await writePromise

    const ext = path.extname(originalName).toLowerCase()
    const platform = fields.platform ?? (ext === '.ipa' ? 'ios' : 'android')
    const status = ['Backlog', 'In Progress', 'Done', 'Rejected'].includes(fields.status)
      ? fields.status : null
    const bundleId = ext === '.ipa' ? extractBundleId(savedPath) : null

    const db = getDb()
    const result = db.prepare(`
      INSERT INTO apps (name, platform, file_path, label, version_label, status_label, bundle_id, uploader_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      path.basename(originalName, path.extname(originalName)),
      platform,
      savedPath,
      fields.label ?? null,
      fields.label ?? null,
      status,
      bundleId,
      auth.userId
    )

    const build = db.prepare('SELECT * FROM apps WHERE id = ?').get(result.lastInsertRowid)
    json(res, 201, build)
  })

  bb.on('error', () => json(res, 500, { error: 'Upload failed' }))
  req.pipe(bb)
}
