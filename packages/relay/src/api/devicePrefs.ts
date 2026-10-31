import http from 'http'
import type { SessionInfo } from '@tapflowio/protocol'
import { getDb } from '../db.js'
import { requireRole, requireViewAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'

// How people organise the device list (#1085). None of it reaches the Mac, and none of it changes what automation
// sees beyond a field it may read: a hidden device is still listed and still leased, and a renamed one keeps its
// `name`, which is what a flow or an MCP client picks a device by.

/** Same bound as nothing else in particular: long enough for any name a person types, short enough for a card. */
const MAX_DISPLAY_NAME = 100

type DeviceRef = { agent: string; deviceId: string }

/** Longer than any machine id, hostname, UDID or `avd:<name>`. Every row is read on every listing, so the keys are
 *  bounded like the name is. */
const MAX_KEY = 200

function deviceRef(body: { agent?: unknown; deviceId?: unknown } | null): DeviceRef | null {
  if (!body || typeof body !== 'object') return null
  const agent = typeof body.agent === 'string' ? body.agent : ''
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
  return agent && deviceId && agent.length <= MAX_KEY && deviceId.length <= MAX_KEY ? { agent, deviceId } : null
}

/** `PUT /api/v1/device-prefs` — Admin only. Fields left out keep their value; a name of `''` or `null` goes back to
 *  the device's own. A row left at every default is deleted rather than kept. */
export async function handlePutDevicePrefs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireRole(req, res, ['Admin'])) return
  const body = await readJson<{ agent?: unknown; deviceId?: unknown; hidden?: unknown; displayName?: unknown }>(req)
  const ref = deviceRef(body)
  if (!ref) return json(res, 400, { error: `agent and deviceId are required, at most ${MAX_KEY} characters each` })
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') return json(res, 400, { error: 'hidden must be a boolean' })
  if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
    return json(res, 400, { error: 'displayName must be a string or null' })
  }
  const name = typeof body.displayName === 'string' ? body.displayName.trim() : body.displayName
  if (typeof name === 'string' && name.length > MAX_DISPLAY_NAME) {
    return json(res, 400, { error: `displayName must be at most ${MAX_DISPLAY_NAME} characters` })
  }

  const db = getDb()
  const current = db.prepare('SELECT hidden, display_name FROM device_prefs WHERE agent_key = ? AND device_id = ?')
    .get(ref.agent, ref.deviceId) as { hidden: number; display_name: string | null } | undefined
  const hidden = typeof body.hidden === 'boolean' ? body.hidden : current?.hidden === 1
  const displayName = name === undefined ? (current?.display_name ?? null) : (name || null)

  if (!hidden && displayName === null) {
    db.prepare('DELETE FROM device_prefs WHERE agent_key = ? AND device_id = ?').run(ref.agent, ref.deviceId)
  } else {
    db.prepare(`
      INSERT INTO device_prefs (agent_key, device_id, hidden, display_name) VALUES (?, ?, ?, ?)
      ON CONFLICT (agent_key, device_id) DO UPDATE SET
        hidden = excluded.hidden, display_name = excluded.display_name, updated_at = datetime('now')
    `).run(ref.agent, ref.deviceId, hidden ? 1 : 0, displayName)
  }
  json(res, 200, { ok: true, hidden, displayName })
}

/** `PUT` / `DELETE /api/v1/device-favourites` — anyone who can see the device list, for their own stars only. Both
 *  are idempotent. */
export async function handleDeviceFavourite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = requireViewAuth(req, res)
  if (!auth) return
  const ref = deviceRef(await readJson<{ agent?: unknown; deviceId?: unknown } | null>(req))
  if (!ref) return json(res, 400, { error: `agent and deviceId are required, at most ${MAX_KEY} characters each` })
  const db = getDb()
  if (req.method === 'DELETE') {
    db.prepare('DELETE FROM device_favourites WHERE user_id = ? AND agent_key = ? AND device_id = ?')
      .run(auth.userId, ref.agent, ref.deviceId)
  } else {
    db.prepare('INSERT OR IGNORE INTO device_favourites (user_id, agent_key, device_id) VALUES (?, ?, ?)')
      .run(auth.userId, ref.agent, ref.deviceId)
  }
  json(res, 200, { ok: true })
}

/**
 * Lays the stored settings over a listing. `user` is the asker as the listing knows them: a numeric user id, or
 * something else for a socket with no account behind it, which has no favourites.
 */
export function withDevicePrefs(sessions: SessionInfo[], user: string | undefined): SessionInfo[] {
  if (sessions.length === 0) return sessions
  const db = getDb()
  const key = (agent: string, deviceId: string) => `${agent}\u0000${deviceId}`
  const prefs = new Map(
    (db.prepare('SELECT agent_key, device_id, hidden, display_name FROM device_prefs').all() as
      Array<{ agent_key: string; device_id: string; hidden: number; display_name: string | null }>)
      .map((r) => [key(r.agent_key, r.device_id), r]),
  )
  const userId = user !== undefined && /^\d+$/.test(user) ? Number(user) : null
  const favourites = new Set(userId === null ? [] :
    (db.prepare('SELECT agent_key, device_id FROM device_favourites WHERE user_id = ?').all(userId) as
      Array<{ agent_key: string; device_id: string }>).map((r) => key(r.agent_key, r.device_id)))
  if (prefs.size === 0 && favourites.size === 0) return sessions

  return sessions.map((info) => {
    const agent = info.agentKey
    if (agent === undefined) return info
    return {
      ...info,
      devices: info.devices.map((d) => {
        const p = prefs.get(key(agent, d.id))
        return {
          ...d,
          ...(p?.display_name ? { displayName: p.display_name } : {}),
          ...(p?.hidden === 1 ? { hidden: true as const } : {}),
          ...(favourites.has(key(agent, d.id)) ? { favourite: true as const } : {}),
        }
      }),
    }
  })
}
