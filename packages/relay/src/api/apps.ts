import http from 'http'
import { getDb } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'

export function handleListApps(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const items = getDb().prepare(`
    SELECT
      a.id, a.name, a.bundle_id_key, a.platform, a.created_at,
      b.id         AS latest_build_id,
      b.version_name,
      b.build_number,
      b.status_label,
      b.uploaded_at AS latest_uploaded_at
    FROM apps a
    LEFT JOIN builds b ON b.id = (
      SELECT id FROM builds WHERE app_id = a.id ORDER BY uploaded_at DESC LIMIT 1
    )
    ORDER BY a.created_at DESC
  `).all()

  json(res, 200, { items })
}

export async function handleCreateApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  if (!['Admin', 'Developer'].includes(auth.role)) {
    return json(res, 403, { error: 'Forbidden' })
  }

  const body = await readJson<{ name?: string; bundle_id_key?: string; platform?: string }>(req)
  if (!body.name?.trim()) return json(res, 400, { error: 'name is required' })
  if (!body.bundle_id_key?.trim()) return json(res, 400, { error: 'bundle_id_key is required' })
  if (!['ios', 'android', 'both'].includes(body.platform ?? '')) {
    return json(res, 400, { error: 'platform must be ios, android, or both' })
  }

  const result = getDb()
    .prepare('INSERT INTO apps (name, bundle_id_key, platform) VALUES (?, ?, ?)')
    .run(body.name.trim(), body.bundle_id_key.trim(), body.platform)
  json(res, 201, { id: result.lastInsertRowid, ok: true })
}

export function handleDeleteApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  if (!['Admin', 'Developer'].includes(auth.role)) {
    return json(res, 403, { error: 'Forbidden' })
  }

  const db = getDb()
  // builds → comments는 ON DELETE CASCADE로 처리됨
  db.prepare('DELETE FROM builds WHERE app_id = ?').run(params.id)
  const result = db.prepare('DELETE FROM apps WHERE id = ?').run(params.id)

  if (result.changes === 0) return json(res, 404, { error: 'App not found' })
  json(res, 200, { ok: true })
}

export async function handleUpdateApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  if (!['Admin', 'Developer'].includes(auth.role)) {
    return json(res, 403, { error: 'Forbidden' })
  }

  const body = await readJson<{ name?: string }>(req)
  if (!body.name?.trim()) return json(res, 400, { error: 'name is required' })

  const result = getDb()
    .prepare('UPDATE apps SET name = ? WHERE id = ?')
    .run(body.name.trim(), params.id)

  if (result.changes === 0) return json(res, 404, { error: 'App not found' })
  json(res, 200, { ok: true })
}
