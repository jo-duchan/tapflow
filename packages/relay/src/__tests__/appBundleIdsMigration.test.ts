import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * **Migration 020 moves each app's bundle ID into `app_bundle_ids` without stopping the relay from booting** (#1086).
 *
 * The data it meets is not clean: before 2026-10-19 `POST /apps` checked only (key, platform), and 004 grouped legacy
 * rows by (key, platform), so one key can sit on several rows. Inserting each row's key as-is would break
 * UNIQUE(bundle_id, platform), roll the migration back, and leave a relay that cannot start.
 */
const dir = path.join(import.meta.dirname, '..', 'migrations')
const before = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f < '020').sort()
const migration020 = fs.readFileSync(path.join(dir, '020_app_bundle_ids.sql'), 'utf-8')

describe('migration 020: app bundle IDs', () => {
  let tmp: string
  let db: Database.Database

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-m020-'))
    db = new Database(path.join(tmp, 'test.db'))
    db.pragma('foreign_keys = ON')
    for (const f of before) db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const app = (name: string, key: string | null, platform: string) =>
    Number(db.prepare('INSERT INTO apps (name, bundle_id_key, platform) VALUES (?, ?, ?)').run(name, key, platform).lastInsertRowid)
  const build = (appId: number, file: string, platform: string | null) =>
    db.prepare("INSERT INTO builds (app_id, file_path, platform) VALUES (?, ?, ?)").run(appId, file, platform)
  // As db.ts runs it: in a transaction, with foreign keys on.
  const migrate = () => db.transaction(() => db.exec(migration020))()
  const ids = (appId: number) =>
    db.prepare('SELECT platform, bundle_id FROM app_bundle_ids WHERE app_id = ? ORDER BY platform').all(appId)
  const platformOf = (appId: number) => (db.prepare('SELECT platform FROM apps WHERE id = ?').get(appId) as { platform: string }).platform

  it('gives a single-platform app its ID on that platform, and a `both` app on both', () => {
    const ios = app('Coffee', 'com.coffee', 'ios')
    const both = app('Tea', 'com.tea', 'both')
    const none = app('Empty', null, 'android')
    migrate()

    expect(ids(ios)).toEqual([{ platform: 'ios', bundle_id: 'com.coffee' }])
    expect(ids(both)).toEqual([{ platform: 'android', bundle_id: 'com.tea' }, { platform: 'ios', bundle_id: 'com.tea' }])
    expect(ids(none)).toEqual([])
    expect((db.prepare('PRAGMA table_info(apps)').all() as { name: string }[]).map((c) => c.name)).not.toContain('bundle_id_key')
  })

  // The oldest row is the one upsertApp's `LIMIT 1` was already sending uploads to.
  it('hands a key on several rows to the oldest, on every platform they covered, without failing', () => {
    const first = app('Shop', 'com.shop', 'ios')
    const second = app('Shop (Android)', 'com.shop', 'android')
    const twice = app('Shop again', 'com.shop', 'ios')
    build(second, '/b/shop.apk', 'android')
    migrate()

    expect(ids(first)).toEqual([{ platform: 'android', bundle_id: 'com.shop' }, { platform: 'ios', bundle_id: 'com.shop' }])
    expect(platformOf(first)).toBe('both')
    expect(ids(second)).toEqual([])
    expect(ids(twice)).toEqual([])
    // The others keep what they had.
    expect((db.prepare('SELECT COUNT(*) AS n FROM builds WHERE app_id = ?').get(second) as { n: number }).n).toBe(1)
  })

  it('keeps builds no ID could be read for apart, under one app, on both platforms', () => {
    const iosUnknown = app('Unknown App', '__unknown__', 'ios')
    app('Unknown App', '__unknown__', 'android')
    migrate()
    expect(ids(iosUnknown)).toEqual([{ platform: 'android', bundle_id: '__unknown__' }, { platform: 'ios', bundle_id: '__unknown__' }])
  })

  // A caller's `platform` field, 004's 'ios' default and 007's copy-down could each leave an APK on record as iOS.
  it('sets each build\'s platform from its file', () => {
    const a = app('Mixed', 'com.mixed', 'ios')
    build(a, '/b/123_app.APK', 'ios')
    build(a, '/b/123_app.app.zip', null)
    build(a, '/b/123_app.tar.gz', 'android')
    migrate()
    expect(db.prepare('SELECT platform FROM builds ORDER BY id').all()).toEqual([{ platform: 'android' }, { platform: 'ios' }, { platform: 'ios' }])
  })

  it('runs on a database with builds and foreign keys on, which a table rebuild would not', () => {
    const a = app('Coffee', 'com.coffee', 'ios')
    build(a, '/b/c.app.zip', 'ios')
    expect(migrate).not.toThrow()
  })
})
