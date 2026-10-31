import type { App } from '@/lib/types'

// Arrange mode's rules (#1086), mirroring the relay's in `relay/src/lib/appBundleIds.ts`.

export type Platform = 'ios' | 'android'
/** One platform of an app: its bundle ID, or none when the app has builds there without one. */
export interface AppRow { appId: number; platform: Platform; id: string | null }

/** The relay's app for builds whose bundle ID could not be read. */
export const UNKNOWN_BUNDLE_ID = '__unknown__'
const PLATFORMS: Platform[] = ['ios', 'android']

export function rowsOf(app: App): AppRow[] {
  return PLATFORMS
    .filter((p) => app.bundle_ids[p] !== null || app.build_platforms.includes(p))
    .map((p) => ({ appId: app.id, platform: p, id: app.bundle_ids[p] }))
}

const holdsUnknown = (app: App) => app.bundle_ids.ios === UNKNOWN_BUNDLE_ID || app.bundle_ids.android === UNKNOWN_BUNDLE_ID

/** Why a row cannot be moved, or null. The relay refuses the same, and a few more it alone can see. */
export function whyFixed(app: App): string | null {
  if (holdsUnknown(app)) return 'Builds without a readable bundle ID stay apart'
  if (app.bundle_ids.ios !== null && app.bundle_ids.ios === app.bundle_ids.android) {
    return 'This app uses one bundle ID on both platforms, so it moves as a whole or not at all'
  }
  return null
}

/** Whether `row` can be dropped on `target`. */
export function canDrop(row: AppRow, target: App): boolean {
  if (target.id === row.appId || holdsUnknown(target)) return false
  return row.id === null || target.bundle_ids[row.platform] === null
}

/** Whether `row` can become an app of its own: its app keeps its other platform, as the relay requires. */
export function canSplit(row: AppRow, app: App): boolean {
  return row.appId === app.id && whyFixed(app) === null && rowsOf(app).length === 2
}
