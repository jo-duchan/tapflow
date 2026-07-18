import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { initDb, getDb, closeDb } from '../db'

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

// ── upsertApp unit tests ──────────────────────────────────────────────────

describe('upsertApp: bundle_id grouping', () => {
  let tmpDir: string
  let upsertApp: typeof import('../api/builds').upsertApp

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-upsert-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    const mod = await import('../api/builds')
    upsertApp = mod.upsertApp
  })

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true }) })

  it('iOS then Android with same bundle_id → single app, platform=both', () => {
    const db = getDb()
    const id1 = upsertApp('MyApp', 'com.example.myapp', 'ios')
    const id2 = upsertApp('MyApp', 'com.example.myapp', 'android')
    expect(id1).toBe(id2)
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(id1) as { platform: string }
    expect(app.platform).toBe('both')
  })

  it('iOS uploaded twice with same bundle_id → same app, platform stays ios', () => {
    const db = getDb()
    const id1 = upsertApp('AppA', 'com.example.appa', 'ios')
    const id2 = upsertApp('AppA', 'com.example.appa', 'ios')
    expect(id1).toBe(id2)
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(id1) as { platform: string }
    expect(app.platform).toBe('ios')
  })

  it('different bundle_ids → separate apps', () => {
    const idA = upsertApp('AppB', 'com.example.appb', 'ios')
    const idC = upsertApp('AppC', 'com.example.appc', 'android')
    expect(idA).not.toBe(idC)
  })

  it('platform=both is not downgraded on subsequent uploads', () => {
    const db = getDb()
    const id1 = upsertApp('AppD', 'com.example.appd', 'ios')
    upsertApp('AppD', 'com.example.appd', 'android') // upgrades to both
    const id2 = upsertApp('AppD', 'com.example.appd', 'ios') // should stay both
    expect(id1).toBe(id2)
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(id1) as { platform: string }
    expect(app.platform).toBe('both')
  })
})

// ── app_id + mismatched bundle_id routing ─────────────────────────────────

describe('upload: app_id provided but bundle_id differs → new app', () => {
  let tmpDir: string
  let upsertApp: typeof import('../api/builds').upsertApp

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-mismatch-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    const mod = await import('../api/builds')
    upsertApp = mod.upsertApp
  })

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true }) })

  it('bundle_id가 다른 앱을 app_id 지정 업로드 시 새 앱에 라우팅된다', () => {
    const db = getDb()
    const bankioId = upsertApp('Bankio', 'com.bankio.mobile', 'ios')
    const bankio = db.prepare('SELECT id, bundle_id_key FROM apps WHERE id = ?')
      .get(bankioId) as { id: number; bundle_id_key: string }

    // 핸들러 분기 시뮬레이션: bundleId !== app.bundle_id_key → upsertApp으로 라우팅
    const uploadedBundleId = 'com.theapp.bundle'
    const appId =
      uploadedBundleId && bankio.bundle_id_key && bankio.bundle_id_key !== uploadedBundleId
        ? upsertApp('TheApp', uploadedBundleId, 'ios')
        : bankioId

    expect(appId).not.toBe(bankioId)
    const newApp = db.prepare('SELECT name, bundle_id_key FROM apps WHERE id = ?')
      .get(appId) as { name: string; bundle_id_key: string }
    expect(newApp.bundle_id_key).toBe('com.theapp.bundle')
  })

  it('bundle_id가 같으면 기존 app_id를 그대로 사용한다', () => {
    const db = getDb()
    const bankioId = upsertApp('Bankio2', 'com.bankio2.mobile', 'ios')
    const bankio = db.prepare('SELECT id, bundle_id_key FROM apps WHERE id = ?')
      .get(bankioId) as { id: number; bundle_id_key: string }

    const uploadedBundleId = 'com.bankio2.mobile'
    const appId =
      uploadedBundleId && bankio.bundle_id_key && bankio.bundle_id_key !== uploadedBundleId
        ? upsertApp('Bankio2', uploadedBundleId, 'ios')
        : bankioId

    expect(appId).toBe(bankioId)
  })
})

// ── routeUploadToApp: null-bundle guard (H-A/H-B) ─────────────────────────

describe('routeUploadToApp: unidentifiable builds never corrupt a named app', () => {
  let tmpDir: string
  let mod: typeof import('../api/builds')

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-route-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    mod = await import('../api/builds')
  })

  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })

  it('app_id + null bundleId → reject (no absorb into the named app)', () => {
    const db = getDb()
    const iosId = mod.upsertApp('Foods', 'com.example.foods', 'ios')
    const before = db.prepare('SELECT platform FROM apps WHERE id = ?').get(iosId) as { platform: string }

    const route = mod.routeUploadToApp(db, { appId: iosId, bundleId: null, appName: 'whatever', platform: 'android', isAndroidArtifact: true })
    expect(route.kind).toBe('reject-null-bundle')

    // platform must not be false-promoted to 'both'.
    const after = db.prepare('SELECT platform FROM apps WHERE id = ?').get(iosId) as { platform: string }
    expect(after.platform).toBe(before.platform)
    expect(after.platform).toBe('ios')
  })

  it('no app_id + null bundleId → isolated under __unknown__, not merged into a real app', () => {
    const db = getDb()
    const realId = mod.upsertApp('Real', 'com.example.real', 'android')
    const route = mod.routeUploadToApp(db, { appId: null, bundleId: null, appName: 'Ghost', platform: 'android', isAndroidArtifact: true })
    expect(route.kind).toBe('ok')
    if (route.kind !== 'ok') return
    expect(route.appId).not.toBe(realId)
    const app = db.prepare('SELECT bundle_id_key FROM apps WHERE id = ?').get(route.appId) as { bundle_id_key: string }
    expect(app.bundle_id_key).toBe('__unknown__')
  })

  it('app_id + matching bundleId → same app, no new row', () => {
    const db = getDb()
    const id = mod.upsertApp('Match', 'com.example.match', 'ios')
    const route = mod.routeUploadToApp(db, { appId: id, bundleId: 'com.example.match', appName: 'Match', platform: 'ios', isAndroidArtifact: false })
    expect(route).toEqual({ kind: 'ok', appId: id })
  })

  it('app_id + mismatched bundleId → routes to a separate app (existing behavior preserved)', () => {
    const db = getDb()
    const bankId = mod.upsertApp('Bank', 'com.bank.mobile', 'ios')
    const route = mod.routeUploadToApp(db, { appId: bankId, bundleId: 'com.other.app', appName: 'Other', platform: 'ios', isAndroidArtifact: false })
    expect(route.kind).toBe('ok')
    if (route.kind !== 'ok') return
    expect(route.appId).not.toBe(bankId)
    const app = db.prepare('SELECT bundle_id_key FROM apps WHERE id = ?').get(route.appId) as { bundle_id_key: string }
    expect(app.bundle_id_key).toBe('com.other.app')
  })

  it('unknown app_id → app-not-found', () => {
    const route = mod.routeUploadToApp(getDb(), { appId: 999999, bundleId: 'com.x.y', appName: 'X', platform: 'ios', isAndroidArtifact: false })
    expect(route.kind).toBe('app-not-found')
  })

  // The reject guard keys off the artifact (isAndroidArtifact), not `platform`: iOS degrades gracefully.
  it('app_id + iOS null bundleId → accepted, not rejected', () => {
    const db = getDb()
    const id = mod.upsertApp('IosApp', 'com.example.iosnull', 'ios')
    const route = mod.routeUploadToApp(db, { appId: id, bundleId: null, appName: 'IosApp', platform: 'ios', isAndroidArtifact: false })
    expect(route).toEqual({ kind: 'ok', appId: id })
  })

  it('app_id + iOS null bundleId on an android app → absorbed and promoted to both (legacy behavior preserved)', () => {
    const db = getDb()
    const id = mod.upsertApp('CrossApp', 'com.example.cross', 'android')
    const route = mod.routeUploadToApp(db, { appId: id, bundleId: null, appName: 'CrossApp', platform: 'ios', isAndroidArtifact: false })
    expect(route).toEqual({ kind: 'ok', appId: id })
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(id) as { platform: string }
    expect(app.platform).toBe('both')
  })

  // Guard must not be bypassable by spoofing the platform field on an APK upload.
  it('android artifact + spoofed platform=ios + null bundleId → still rejected', () => {
    const db = getDb()
    const id = mod.upsertApp('SpoofTarget', 'com.example.spoof', 'ios')
    const route = mod.routeUploadToApp(db, { appId: id, bundleId: null, appName: 'x', platform: 'ios', isAndroidArtifact: true })
    expect(route.kind).toBe('reject-null-bundle')
    const app = db.prepare('SELECT platform FROM apps WHERE id = ?').get(id) as { platform: string }
    expect(app.platform).toBe('ios') // not promoted to 'both'
  })
})

// ── findAapt: resolver parity with doctor ─────────────────────────────────

describe('findAapt: resolves via ANDROID_SDK_ROOT and Linux path (parity with doctor)', () => {
  let mod: typeof import('../api/builds')
  let saved: Record<string, string | undefined>

  beforeAll(async () => { mod = await import('../api/builds') })
  beforeEach(() => {
    saved = { ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT, HOME: process.env.HOME }
  })
  afterEach(() => {
    for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'HOME'] as const) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('resolves aapt via ANDROID_SDK_ROOT (relay previously ignored it while doctor honored it)', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-sdkroot-'))
    const btDir = path.join(sdk, 'build-tools', '99.0.0')
    fs.mkdirSync(btDir, { recursive: true })
    const aaptPath = path.join(btDir, 'aapt')
    fs.writeFileSync(aaptPath, '')
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-emptyhome-')) // neutralize the real-SDK home candidate
    delete process.env.ANDROID_HOME
    process.env.ANDROID_SDK_ROOT = sdk
    process.env.HOME = emptyHome
    try {
      expect(mod.findAapt()).toBe(aaptPath)
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true })
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
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

  it('extracts metadata when .app name contains spaces', () => {
    const spacedZip = makeTestZip(tmpDir, 'Food Truck', XML_PLIST)
    const info = extractAppZipInfo(spacedZip)
    expect(info).not.toBeNull()
    expect(info!.bundleId).toBe('com.example.coffee')
  })

  it('returns null for a zip with no .app directory', () => {
    const emptyZip = path.join(tmpDir, 'empty.zip')
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello')
    spawnSync('zip', [emptyZip, 'readme.txt'], { cwd: tmpDir })
    const info = extractAppZipInfo(emptyZip)
    expect(info).toBeNull()
  })
})

// ── extractAppTarInfo unit tests (EAS .tar.gz) ─────────────────────────────

describe('extractAppTarInfo', () => {
  let tmpDir: string
  let mod: typeof import('../api/builds')
  let makeAppTarGz: typeof import('./helpers/tarFixture').makeAppTarGz
  let writeRawTarGz: typeof import('./helpers/tarFixture').writeRawTarGz

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-tar-test-'))
    mod = await import('../api/builds')
    const fx = await import('./helpers/tarFixture')
    makeAppTarGz = fx.makeAppTarGz
    writeRawTarGz = fx.writeRawTarGz
  })

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('extracts metadata from the top-level *.app/Info.plist (not nested framework plist)', () => {
    const tarPath = makeAppTarGz(tmpDir, 'CoffeeApp', XML_PLIST)
    const info = mod.extractAppTarInfo(tarPath)
    expect(info).not.toBeNull()
    expect(info!.bundleId).toBe('com.example.coffee')
    expect(info!.versionName).toBe('1.4.0')
    expect(info!.buildNumber).toBe('89')
    expect(info!.appName).toBe('Coffee App')
  })

  it('supports the .tgz extension', () => {
    const tarPath = makeAppTarGz(tmpDir, 'TgzApp', XML_PLIST, '.tgz')
    const info = mod.extractAppTarInfo(tarPath)
    expect(info).not.toBeNull()
    expect(info!.bundleId).toBe('com.example.coffee')
  })

  it('extractAppInfo dispatches to the tar path by extension', () => {
    const tarPath = makeAppTarGz(tmpDir, 'DispatchApp', XML_PLIST)
    const info = mod.extractAppInfo(tarPath)
    expect(info?.bundleId).toBe('com.example.coffee')
  })

  it('returns null for a tar.gz with no .app directory', () => {
    const noApp = path.join(tmpDir, 'noapp.tar.gz')
    fs.writeFileSync(noApp, writeRawTarGz([{ name: 'readme.txt', data: Buffer.from('hi') }]))
    expect(mod.extractAppTarInfo(noApp)).toBeNull()
  })
})
