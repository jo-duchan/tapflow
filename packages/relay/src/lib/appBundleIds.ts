import type { getDb } from '../db.js'

type Db = ReturnType<typeof getDb>
export type Platform = 'ios' | 'android'

/**
 * An app's bundle IDs, one per platform at most (#1086). The table (`app_bundle_ids`) holds only
 * UNIQUE(bundle_id, platform); the two rules that decide where a build goes are kept here:
 *
 * - **An ID belongs to one app, whatever the platform.** Two apps holding the same ID on different platforms would
 *   split a product the way #1086 reported, so every ownership lookup ignores the platform.
 * - **An app has at most one ID per platform.** A different ID arriving for a platform the app already has goes to
 *   that ID's own app rather than being added — a build flavor (`com.app.staging`) stays its own app.
 */

/** Builds whose bundle ID could not be read, uploaded without `app_id`. Never an ID people can set or merge. */
export const UNKNOWN_BUNDLE_ID = '__unknown__'

export function holdsUnknown(db: Db, appId: number): boolean {
  return db.prepare('SELECT 1 FROM app_bundle_ids WHERE app_id = ? AND bundle_id = ?').get(appId, UNKNOWN_BUNDLE_ID) !== undefined
}

export function ownerOf(db: Db, bundleId: string): number | null {
  const row = db.prepare('SELECT app_id FROM app_bundle_ids WHERE bundle_id = ? LIMIT 1').get(bundleId) as { app_id: number } | undefined
  return row?.app_id ?? null
}

export function idOn(db: Db, appId: number, platform: Platform): string | null {
  const row = db.prepare('SELECT bundle_id FROM app_bundle_ids WHERE app_id = ? AND platform = ?').get(appId, platform) as { bundle_id: string } | undefined
  return row?.bundle_id ?? null
}

export function bundleIdsOf(db: Db, appId: number): { ios: string | null; android: string | null } {
  return { ios: idOn(db, appId, 'ios'), android: idOn(db, appId, 'android') }
}

/** Gives `appId` the ID on `platform` when it has none there yet. The caller has checked that nobody else owns it. */
export function attachIfFree(db: Db, appId: number, platform: Platform, bundleId: string): void {
  if (idOn(db, appId, platform) !== null) return
  db.prepare('INSERT INTO app_bundle_ids (app_id, platform, bundle_id) VALUES (?, ?, ?)').run(appId, platform, bundleId)
}

/** A build of `platform` arrived: the app covers it from now on. Never narrows, as before #1086. */
export function promote(db: Db, appId: number, platform: Platform): void {
  db.prepare("UPDATE apps SET platform = 'both' WHERE id = ? AND platform NOT IN ('both', ?)").run(appId, platform)
}

/**
 * The platforms an app has something on: an ID, or a build. What the merge moves is one of these, and an app left
 * with none is gone. A build with no ID (an iOS bundle that could not be read) still makes a platform, so moving an
 * app's last ID never strands builds under an app about to be deleted.
 */
export function platformsOf(db: Db, appId: number): Platform[] {
  const rows = db.prepare(`
    SELECT platform FROM app_bundle_ids WHERE app_id = ?
    UNION
    SELECT platform FROM builds WHERE app_id = ? AND platform IS NOT NULL
  `).all(appId, appId) as { platform: Platform }[]
  return rows.map((r) => r.platform).sort()
}

/** `apps.platform` from what the app has. Keeps the current value for an app with nothing, which only a new one is. */
export function recomputePlatform(db: Db, appId: number): void {
  const has = platformsOf(db, appId)
  if (has.length === 0) return
  db.prepare('UPDATE apps SET platform = ? WHERE id = ?').run(has.length === 2 ? 'both' : has[0], appId)
}
