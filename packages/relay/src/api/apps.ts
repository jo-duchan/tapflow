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
