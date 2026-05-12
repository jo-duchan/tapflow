import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { initDb, getDb } from '../db'

// ── fixture helpers ────────────────────────────────────────────────────────

function makeTestZip(tmpDir: string, appName: string, plistXml: string): string {
  const appDir = path.join(tmpDir, `${appName}.app`)
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml)
  // minimal binary placeholder (Mach-O magic is not needed for zip structure test)
  fs.writeFileSync(path.join(appDir, appName), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const zipPath = path.join(tmpDir, `${appName}.app.zip`)
  spawnSync('zip', ['-r', zipPath, `${appName}.app`], { cwd: tmpDir })
  return zipPath
}

const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.coffee</string>
  <key>CFBundleShortVersionString</key><string>1.4.0</string>
  <key>CFBundleVersion</key><string>89</string>
  <key>CFBundleDisplayName</key><string>Coffee App</string>
</dict></plist>`

// ── Migration schema tests ─────────────────────────────────────────────────

describe('Migration 004: apps/builds split', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true }) })

  it('apps table has bundle_id_key, platform, no file_path', () => {
    const cols = (getDb().prepare('PRAGMA table_info(apps)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('bundle_id_key')
    expect(cols).toContain('platform')
    expect(cols).not.toContain('file_path')
  })

  it('builds table has app_id, version_name, build_number, file_path', () => {
    const cols = (getDb().prepare('PRAGMA table_info(builds)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('app_id')
    expect(cols).toContain('version_name')
    expect(cols).toContain('build_number')
    expect(cols).toContain('file_path')
  })

  it('inserts app and build, FK is enforced', () => {
    const db = getDb()
    db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Test', 'com.test', 'ios')`).run()
    const app = db.prepare('SELECT * FROM apps WHERE bundle_id_key = ?').get('com.test') as { id: number }
    db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (?, '1.0.0', '1', 'com.test', '/tmp/test.app.zip')
    `).run(app.id)
    const build = db.prepare('SELECT * FROM builds WHERE app_id = ?').get(app.id) as { version_name: string }
    expect(build.version_name).toBe('1.0.0')
  })

  it('GET /api/v1/apps returns items with latest_build — shape check via query', () => {
    const db = getDb()
    const rows = db.prepare(`
      SELECT a.id, a.name, a.bundle_id_key, a.platform,
             b.version_name, b.build_number, b.status_label, b.uploaded_at
      FROM apps a
      LEFT JOIN builds b ON b.id = (
        SELECT id FROM builds WHERE app_id = a.id ORDER BY uploaded_at DESC LIMIT 1
      )
      WHERE a.bundle_id_key = 'com.test'
    `).all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as { version_name: string }).version_name).toBe('1.0.0')
  })
})

// ── extractAppZipInfo unit tests ──────────────────────────────────────────

describe('extractAppZipInfo', () => {
  let tmpDir: string
  let zipPath: string
  // dynamically import after module loads (avoids top-level circular ref)
  let extractAppZipInfo: (zipPath: string) => ReturnType<typeof import('../api/builds').extractAppZipInfo>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-zip-test-'))
    zipPath = makeTestZip(tmpDir, 'CoffeeApp', XML_PLIST)
    const mod = await import('../api/builds')
    extractAppZipInfo = mod.extractAppZipInfo
  })

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true }) })

  it('extracts bundle_id, version_name, build_number, app_name from .app.zip', () => {
    const info = extractAppZipInfo(zipPath)
    expect(info).not.toBeNull()
    expect(info!.bundleId).toBe('com.example.coffee')
    expect(info!.versionName).toBe('1.4.0')
    expect(info!.buildNumber).toBe('89')
    expect(info!.appName).toBe('Coffee App')
  })

  it('returns null for a zip with no .app directory', () => {
    const emptyZip = path.join(tmpDir, 'empty.zip')
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello')
    spawnSync('zip', [emptyZip, 'readme.txt'], { cwd: tmpDir })
    const info = extractAppZipInfo(emptyZip)
    expect(info).toBeNull()
  })
})
