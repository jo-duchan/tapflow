import type http from 'http'
import { getDb } from '../db.js'
import { requireBuildAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { validateWebhookUrl } from '../lib/webhooks.js'

interface WebhookRow {
  id: number
  url: string
  secret: string | null
  enabled: number
  created_at: string
}

// secret is write-only: never returned, only whether one is set.
function publicView(r: WebhookRow) {
  return { id: r.id, url: r.url, enabled: !!r.enabled, has_secret: !!r.secret, created_at: r.created_at }
}

export function handleListWebhooks(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!requireBuildAuth(req, res)) return
  const rows = getDb().prepare('SELECT * FROM webhook_endpoints ORDER BY id').all() as WebhookRow[]
  json(res, 200, { webhooks: rows.map(publicView) })
}

export async function handleCreateWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireBuildAuth(req, res)) return
  const body = await readJson<{ url?: string; secret?: string | null; enabled?: boolean }>(req)
  if (!body.url || typeof body.url !== 'string') return json(res, 400, { error: 'url is required' })
  const err = validateWebhookUrl(body.url)
  if (err) return json(res, 400, { error: err })
  const db = getDb()
  const r = db
    .prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, ?)')
    .run(body.url, body.secret ?? null, body.enabled === false ? 0 : 1)
  const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(Number(r.lastInsertRowid)) as WebhookRow
  json(res, 201, publicView(row))
}

export async function handleUpdateWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  if (!requireBuildAuth(req, res)) return
  const db = getDb()
  const existing = db.prepare('SELECT id FROM webhook_endpoints WHERE id = ?').get(params.id)
  if (!existing) return json(res, 404, { error: 'Webhook not found' })

  const body = await readJson<{ url?: string; secret?: string | null; enabled?: boolean }>(req)
  const updates: string[] = []
  const values: unknown[] = []
  if ('url' in body) {
    if (!body.url || typeof body.url !== 'string') return json(res, 400, { error: 'url is required' })
    const err = validateWebhookUrl(body.url)
    if (err) return json(res, 400, { error: err })
    updates.push('url = ?')
    values.push(body.url)
  }
  if ('secret' in body) {
    updates.push('secret = ?')
    values.push(body.secret ?? null)
  }
  if ('enabled' in body) {
    updates.push('enabled = ?')
    values.push(body.enabled ? 1 : 0)
  }
  if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

  db.prepare(`UPDATE webhook_endpoints SET ${updates.join(', ')} WHERE id = ?`).run(...values, params.id)
  const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(params.id) as WebhookRow
  json(res, 200, publicView(row))
}

export function handleDeleteWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  if (!requireBuildAuth(req, res)) return
  const r = getDb().prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(params.id)
  if (r.changes === 0) return json(res, 404, { error: 'Webhook not found' })
  json(res, 200, { ok: true })
}
