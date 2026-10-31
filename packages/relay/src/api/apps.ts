import http from 'http'
import { getDb } from '../db.js'
import { requireRole, requireViewAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { deleteBuildsWithDependents, type BuildFileDirs } from '../lib/buildDeletion.js'
import { attachIfFree, holdsUnknown, idOn, ownerOf, platformsOf, recomputePlatform, UNKNOWN_BUNDLE_ID, type Platform } from '../lib/appBundleIds.js'

// Viewer is the one read-only role; QA manages apps like Developer does.
const APP_MANAGERS = ['Admin', 'Developer', 'QA']

export function handleListApps(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireViewAuth(req, res)
  if (!auth) return

  const rows = getDb().prepare(`
    SELECT
      a.id, a.name, a.platform, a.created_at,
      (SELECT bundle_id FROM app_bundle_ids WHERE app_id = a.id AND platform = 'ios')     AS ios_bundle_id,
      (SELECT bundle_id FROM app_bundle_ids WHERE app_id = a.id AND platform = 'android') AS android_bundle_id,
      (SELECT group_concat(DISTINCT platform) FROM builds WHERE app_id = a.id)            AS build_platforms,
      b.id         AS latest_build_id,
      b.version_name,
      b.build_number,
      b.status_label,
      b.uploaded_at AS latest_uploaded_at
    FROM apps a
    LEFT JOIN builds_effective b ON b.id = (
      SELECT id FROM builds WHERE app_id = a.id ORDER BY uploaded_at DESC LIMIT 1
    )
    ORDER BY a.created_at DESC, a.id DESC
  `).all() as Array<Record<string, unknown> & { ios_bundle_id: string | null; android_bundle_id: string | null; build_platforms: string | null }>

  const items = rows.map(({ ios_bundle_id, android_bundle_id, build_platforms, ...app }) => ({
    ...app,
    // Kept for clients from before #1086, which read one ID per app: the iOS one when the two differ.
    bundle_id_key: ios_bundle_id ?? android_bundle_id,
    bundle_ids: { ios: ios_bundle_id, android: android_bundle_id },
    build_platforms: build_platforms ? build_platforms.split(',').sort() : [],
  }))
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
  if (platform !== 'ios' && platform !== 'android' && platform !== 'both') {
    return json(res, 400, { error: 'platform must be ios, android or both' })
  }
  const bundleId = body.bundle_id_key.trim()
  if (bundleId === UNKNOWN_BUNDLE_ID) return json(res, 400, { error: 'That bundle ID is reserved' })

  // One app per bundle ID, whatever the platform (`lib/appBundleIds.ts`). better-sqlite3 is synchronous, so no request
  // can take the ID between this check and the insert.
  const db = getDb()
  if (ownerOf(db, bundleId) !== null) {
    return json(res, 409, { error: 'App with this bundle ID already exists' })
  }
  const name = body.name.trim()
  const covers: Platform[] = platform === 'both' ? ['ios', 'android'] : [platform]
  const id = db.transaction(() => {
    const appId = db.prepare('INSERT INTO apps (name, platform) VALUES (?, ?)').run(name, platform).lastInsertRowid as number
    for (const p of covers) attachIfFree(db, appId, p, bundleId)
    return appId
  })()
  json(res, 201, { id, ok: true })
}

export function handleDeleteApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  dirs: BuildFileDirs,
): void {
  if (!requireRole(req, res, APP_MANAGERS)) return

  const db = getDb()
  if (!db.prepare('SELECT 1 FROM apps WHERE id = ?').get(params.id)) return json(res, 404, { error: 'App not found' })
  const buildIds = (db.prepare('SELECT id FROM builds WHERE app_id = ?').all(params.id) as { id: number }[]).map((b) => b.id)
  deleteBuildsWithDependents(buildIds, dirs, () => {
    db.prepare('DELETE FROM apps WHERE id = ?').run(params.id)
  })
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

type Db = ReturnType<typeof getDb>

/**
 * Why one platform of `source` cannot leave it, or null. Shared by merge and split, which move the same thing and differ
 * only in where it goes, so a rule added for one holds for the other.
 */
function cannotLeave(db: Db, source: number, platform: Platform): { status: number; error: string } | null {
  if (!platformsOf(db, source).includes(platform)) return { status: 400, error: `That app has nothing on ${platform}` }
  // The app holding builds no ID could be read for stays apart, or every such upload from then on joins a real app.
  if (holdsUnknown(db, source)) return { status: 400, error: 'Builds without a readable bundle ID stay apart' }
  const movingId = idOn(db, source, platform)
  // One platform of an app that uses the same ID on both: moving it would leave that ID on two apps, and uploads of it
  // would then go to whichever row a lookup finds first.
  const other: Platform = platform === 'ios' ? 'android' : 'ios'
  if (movingId !== null && idOn(db, source, other) === movingId) {
    return { status: 409, error: `That app uses ${movingId} on both platforms, so one platform cannot be moved on its own` }
  }
  // Routing finds an app by its ID on any platform, so a build can carry the ID of its app's other platform. Moving one
  // side of such an app would part builds from the ID their next uploads follow, in either direction: builds staying
  // behind with the ID that moves, or builds moving with the ID that stays.
  const retainedId = idOn(db, source, other)
  const carries = (onPlatform: Platform, id: string | null) => id !== null &&
    db.prepare('SELECT 1 FROM builds WHERE app_id = ? AND platform = ? AND bundle_id = ?').get(source, onPlatform, id) !== undefined
  if (carries(other, movingId) || carries(platform, retainedId)) {
    return { status: 409, error: `That app has builds carrying the bundle ID of its other platform, so its ${platform} side cannot be moved on its own` }
  }
  return null
}

/**
 * Moves one platform of an app into another (#1086): that platform's bundle ID and its builds. Everything else a build
 * has — comments, recordings, run records — hangs off the build and goes with it. The app left with nothing is
 * deleted; only its row, since its builds have all moved. The target keeps its name. People decide that two apps are
 * one product; this only refuses what would break a rule in `lib/appBundleIds.ts`.
 */
export async function handleMergeApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  if (!requireRole(req, res, APP_MANAGERS)) return

  const body = await readJson<{ fromAppId?: unknown; platform?: unknown }>(req)
  const target = Number(params.id)
  const source = Number(body.fromAppId)
  const platform = body.platform
  if (!Number.isInteger(source)) return json(res, 400, { error: 'fromAppId is required' })
  if (platform !== 'ios' && platform !== 'android') return json(res, 400, { error: 'platform must be ios or android' })
  if (source === target) return json(res, 400, { error: 'An app cannot be merged into itself' })

  const db = getDb()
  const exists = db.prepare('SELECT id FROM apps WHERE id IN (?, ?)').all(source, target) as { id: number }[]
  if (exists.length !== 2) return json(res, 404, { error: 'App not found' })
  // The source's rules first, then the target's: when both sides break one, the source's answer is the one given, status
  // code included (a source using one ID on both platforms is 409 even if the target is the unreadable-builds app).
  const problem = cannotLeave(db, source, platform)
  if (problem) return json(res, problem.status, { error: problem.error })
  if (holdsUnknown(db, target)) return json(res, 400, { error: 'Builds without a readable bundle ID stay apart' })
  if (idOn(db, source, platform) !== null && idOn(db, target, platform) !== null) {
    return json(res, 409, { error: `The target app already has a ${platform} bundle ID` })
  }

  const removed = db.transaction(() => {
    db.prepare('UPDATE app_bundle_ids SET app_id = ? WHERE app_id = ? AND platform = ?').run(target, source, platform)
    db.prepare('UPDATE builds SET app_id = ? WHERE app_id = ? AND platform = ?').run(target, source, platform)
    recomputePlatform(db, target)
    if (platformsOf(db, source).length === 0) {
      db.prepare('DELETE FROM apps WHERE id = ?').run(source)
      return true
    }
    recomputePlatform(db, source)
    return false
  })()
  json(res, 200, { ok: true, appId: target, ...(removed ? { removedAppId: source } : {}) })
}


/**
 * The other way round from a merge (#1086): one platform of an app — its bundle ID and builds — becomes an app of its
 * own, named by the caller. It is how a wrong merge, or an ID attached to the wrong app, is undone. The source must
 * keep its other platform: splitting off all it has would only rename it and change its id under CI's `app_id`.
 */
export async function handleSplitApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  if (!requireRole(req, res, APP_MANAGERS)) return

  const body = await readJson<{ platform?: unknown; name?: unknown }>(req)
  const source = Number(params.id)
  const platform = body.platform
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (platform !== 'ios' && platform !== 'android') return json(res, 400, { error: 'platform must be ios or android' })
  if (!name) return json(res, 400, { error: 'name is required' })

  const db = getDb()
  if (!db.prepare('SELECT 1 FROM apps WHERE id = ?').get(source)) return json(res, 404, { error: 'App not found' })
  const problem = cannotLeave(db, source, platform)
  if (problem) return json(res, problem.status, { error: problem.error })
  if (platformsOf(db, source).length < 2) return json(res, 400, { error: 'Nothing would stay behind' })

  const appId = db.transaction(() => {
    const created = Number(db.prepare('INSERT INTO apps (name, platform) VALUES (?, ?)').run(name, platform).lastInsertRowid)
    db.prepare('UPDATE app_bundle_ids SET app_id = ? WHERE app_id = ? AND platform = ?').run(created, source, platform)
    db.prepare('UPDATE builds SET app_id = ? WHERE app_id = ? AND platform = ?').run(created, source, platform)
    recomputePlatform(db, source)
    return created
  })()
  json(res, 200, { ok: true, appId })
}
