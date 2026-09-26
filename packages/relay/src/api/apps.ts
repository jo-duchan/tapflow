import http from 'http'
import { getDb } from '../db.js'
import { requireRole, requireViewAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'

// Viewer is the one read-only role; QA manages apps like Developer does.
const APP_MANAGERS = ['Admin', 'Developer', 'QA']

export function handleListApps(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireViewAuth(req, res)
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
  if (!requireRole(req, res, APP_MANAGERS)) return

  const body = await readJson<{ name?: string; bundle_id_key?: string; platform?: string }>(req)
  if (!body.name?.trim()) return json(res, 400, { error: 'name is required' })
  if (!body.bundle_id_key?.trim()) return json(res, 400, { error: 'bundle_id_key is required' })
  const platform = body.platform?.trim()
  if (!platform) {
    return json(res, 400, { error: 'platform is required' })
  }

  const result = getDb()
    .prepare('INSERT INTO apps (name, bundle_id_key, platform) VALUES (?, ?, ?)')
    .run(body.name.trim(), body.bundle_id_key.trim(), platform)
  json(res, 201, { id: result.lastInsertRowid, ok: true })
}

export function handleDeleteApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  if (!requireRole(req, res, APP_MANAGERS)) return

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
  if (!requireRole(req, res, APP_MANAGERS)) return

  const body = await readJson<{ name?: string }>(req)
  if (!body.name?.trim()) return json(res, 400, { error: 'name is required' })

  const result = getDb()
    .prepare('UPDATE apps SET name = ? WHERE id = ?')
    .run(body.name.trim(), params.id)

  if (result.changes === 0) return json(res, 404, { error: 'App not found' })
  json(res, 200, { ok: true })
}
