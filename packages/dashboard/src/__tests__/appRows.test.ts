import { describe, it, expect } from 'vitest'
import type { App } from '@/lib/types'
import { canDrop, canSplit, rowsOf, whyFixed } from '@/lib/appRows'

const app = (id: number, ios: string | null, android: string | null, builds: Array<'ios' | 'android'> = []): App => ({
  id, name: `App ${id}`, bundle_id_key: ios ?? android, bundle_ids: { ios, android }, build_platforms: builds,
  platform: 'ios', latest_build_id: null, version_name: null, build_number: null, status_label: null, latest_uploaded_at: null,
})

describe('merge mode rows (#1086)', () => {
  it('has a row per platform with an ID or builds, and none for an empty one', () => {
    expect(rowsOf(app(1, 'org.a', null))).toEqual([{ appId: 1, platform: 'ios', id: 'org.a' }])
    // Builds no ID could be read for still make a row, so a merge can move them.
    expect(rowsOf(app(2, null, 'com.b', ['ios', 'android']))).toEqual([
      { appId: 2, platform: 'ios', id: null }, { appId: 2, platform: 'android', id: 'com.b' },
    ])
  })

  it('fixes the rows of the unreadable-builds app, and of an app using one ID on both platforms', () => {
    expect(whyFixed(app(1, '__unknown__', null))).toMatch(/readable/)
    expect(whyFixed(app(2, 'com.same', 'com.same'))).toMatch(/both platforms/)
    expect(whyFixed(app(3, 'org.a', 'com.a'))).toBeNull()
  })

  it('drops a row only on another app that has no ID on its platform, unless the row has no ID', () => {
    const row = rowsOf(app(1, null, 'com.a'))[0]!
    expect(canDrop(row, app(1, null, 'com.a'))).toBe(false)
    expect(canDrop(row, app(2, 'org.b', null))).toBe(true)
    expect(canDrop(row, app(3, null, 'com.c'))).toBe(false)
    expect(canDrop(row, app(4, '__unknown__', null))).toBe(false)
    const noId = { appId: 1, platform: 'android' as const, id: null }
    expect(canDrop(noId, app(3, null, 'com.c'))).toBe(true)
  })
})

describe('canSplit', () => {
  it('lets a row leave an app that keeps its other platform, and nothing else', () => {
    expect(canSplit({ appId: 1, platform: 'android', id: 'com.two' }, app(1, 'org.two', 'com.two'))).toBe(true)
    // Builds without an ID still make a platform that stays behind.
    expect(canSplit({ appId: 1, platform: 'android', id: 'com.two' }, app(1, null, 'com.two', ['ios']))).toBe(true)
    expect(canSplit({ appId: 1, platform: 'ios', id: 'org.one' }, app(1, 'org.one', null))).toBe(false)
    expect(canSplit({ appId: 1, platform: 'android', id: 'com.same' }, app(1, 'com.same', 'com.same'))).toBe(false)
    expect(canSplit({ appId: 9, platform: 'android', id: 'com.two' }, app(1, 'org.two', 'com.two'))).toBe(false)
  })
})
