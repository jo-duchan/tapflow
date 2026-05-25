import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { requireAuth, verifyPat } from '../middleware/auth.js'
import { json, readJson } from '../router.js'

// ── zip / plist helpers ────────────────────────────────────────────────────

function parseXmlPlist(xml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) result[m[1]] = m[2]
  return result
}

/** zip 내 루트 수준 *.app 디렉토리 이름을 찾는다. 없으면 null. */
function findAppDirInZip(zipPath: string): string | null {
  const list = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
  if (list.status !== 0) return null
  // "  12345  2024-01-01 00:00:00  MyApp.app/"  형태를 매칭
  const re = /\s(\S+\.app)\/\s*$/m
  const m = re.exec(list.stdout as string)
  if (!m) return null
  // 루트 레벨만 (슬래시 미포함)
  const candidate = m[1]
  return candidate.includes('/') ? null : candidate
}

/** .app.zip에서 앱 메타데이터를 추출한다. 구조 오류 시 null. */
export function extractAppZipInfo(zipPath: string): {
  bundleId: string | null
  versionName: string | null
  buildNumber: string | null
  appName: string | null
} | null {
  const appDir = findAppDirInZip(zipPath)
  if (!appDir) return null

  const extract = spawnSync('unzip', ['-p', zipPath, `${appDir}/Info.plist`])
  if (extract.status !== 0 || !extract.stdout) return null

  const plistBuf = extract.stdout as Buffer
  let parsed: Record<string, string>

  if (plistBuf.subarray(0, 6).toString() === 'bplist') {
    // binary plist — plutil 시도 (macOS only; 없으면 빈 결과)
    const plutil = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      input: plistBuf,
      encoding: 'utf8',
    })
    if (plutil.status !== 0) return { bundleId: null, versionName: null, buildNumber: null, appName: null }
    parsed = parseXmlPlist(plutil.stdout as string)
  } else {
    parsed = parseXmlPlist(plistBuf.toString('utf8'))
  }

  return {
    bundleId: parsed['CFBundleIdentifier'] ?? null,
    versionName: parsed['CFBundleShortVersionString'] ?? null,
    buildNumber: parsed['CFBundleVersion'] ?? null,
    appName: parsed['CFBundleDisplayName'] ?? parsed['CFBundleName'] ?? null,
  }
}

/** ANDROID_HOME/build-tools 아래에서 최신 aapt 경로를 찾는다. macOS 기본 경로 + PATH fallback 포함. */
function findAapt(): string | null {
  const candidates = [
    process.env['ANDROID_HOME'],
    `${process.env['HOME']}/Library/Android/sdk`,
  ].filter(Boolean) as string[]

  for (const androidHome of candidates) {
    const buildToolsDir = path.join(androidHome, 'build-tools')
    if (!fs.existsSync(buildToolsDir)) continue
    const versions = fs.readdirSync(buildToolsDir)
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const p = (s: string) => s.split('.').map(Number)
        const [am, ai, ap] = p(a); const [bm, bi, bp] = p(b)
        return bm - am || bi - ai || bp - ap
      })
    for (const v of versions) {
      const aapt = path.join(buildToolsDir, v, 'aapt')
      if (fs.existsSync(aapt)) return aapt
    }
  }

  // PATH fallback — relay 프로세스가 ANDROID_HOME을 상속받지 못한 경우
  const which = spawnSync('which', ['aapt'], { encoding: 'utf8' })
  if (which.status === 0) return (which.stdout as string).trim()

  return null
}

/** aapt dump badging으로 APK 메타데이터를 추출한다. aapt 미설치 시 null 필드. */
function extractApkInfo(apkPath: string): {
  bundleId: string | null; versionName: string | null
  buildNumber: string | null; appName: string | null
} {
  const empty = { bundleId: null, versionName: null, buildNumber: null, appName: null }
  const aapt = findAapt()
  if (!aapt) return empty
  const r = spawnSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' })
  if (r.status !== 0) return empty
  const out = r.stdout as string
  return {
    bundleId:    out.match(/package: name='([^']+)'/)?.[1] ?? null,
    versionName: out.match(/versionName='([^']+)'/)?.[1] ?? null,
    buildNumber: out.match(/versionCode='([^']+)'/)?.[1] ?? null,
    appName:     out.match(/application-label(?:-\w+)?:'([^']+)'/)?.[1] ?? null,
  }
}

/**
 * lipo로 시뮬레이터 슬라이스 존재를 확인한다.
 * lipo 미설치(Linux relay) 시 null 반환 → 검증 skip.
 */
function hasSimulatorSlice(zipPath: string, appDir: string): boolean | null {
  const binaryName = path.basename(appDir, '.app')
  const extract = spawnSync('unzip', ['-p', zipPath, `${appDir}/${binaryName}`])
  if (extract.status !== 0 || !extract.stdout?.length) return null

  const tmpBin = path.join(tmpdir(), `tapflow-lipo-${randomUUID()}`)
  fs.writeFileSync(tmpBin, extract.stdout as Buffer)
  try {
    const lipo = spawnSync('lipo', ['-info', tmpBin], { encoding: 'utf8' })
    if (lipo.status !== 0) return null // lipo 없음 → skip
    const out = (lipo.stdout as string).toLowerCase()
    // x86_64 = Intel 시뮬레이터, arm64 = Apple Silicon 시뮬레이터 또는 device
    // arm64만 있는 경우는 구분 불가 → 통과 허용 (install 단계에서 실패 시 명확한 에러)
    return out.includes('x86_64') || out.includes('arm64')
  } finally {
    try { fs.unlinkSync(tmpBin) } catch { /* ignore */ }
  }
}

// ── app 자동 생성 / 조회 ──────────────────────────────────────────────────

export function upsertApp(name: string, bundleIdKey: string, platform: string): number {
  const db = getDb()
  const existing = db.prepare(
    'SELECT id, platform FROM apps WHERE bundle_id_key = ? LIMIT 1'
  ).get(bundleIdKey) as { id: number; platform: string } | undefined

  if (existing) {
    // 다른 플랫폼 빌드가 올라오면 both로 업그레이드
    if (existing.platform !== 'both' && existing.platform !== platform) {
      db.prepare('UPDATE apps SET platform = ? WHERE id = ?').run('both', existing.id)
    }
    return existing.id
  }

  const result = db.prepare(
    'INSERT INTO apps (name, bundle_id_key, platform) VALUES (?, ?, ?)'
  ).run(name, bundleIdKey, platform)
  return result.lastInsertRowid as number
}

// ── handlers ──────────────────────────────────────────────────────────────

export function handleListBuilds(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const u = new URL(req.url ?? '/', 'http://x')
  const page    = Math.max(0, Number(u.searchParams.get('page') ?? 0))
  const limit   = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 20)))
  const q       = u.searchParams.get('q') ?? ''
  const platform = u.searchParams.get('platform') ?? ''
  const status  = u.searchParams.get('status') ?? ''
  const appId   = u.searchParams.get('app_id') ?? ''
  const sortKey = ['uploaded_at', 'version_name', 'status_label'].includes(u.searchParams.get('sort') ?? '')
    ? u.searchParams.get('sort')! : 'uploaded_at'
  const sortDir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC'

  const db = getDb()
  const conds: string[] = []
  const params: unknown[] = []

  if (q)        { conds.push('b.version_name LIKE ?'); params.push(`%${q}%`) }
  if (platform) { conds.push('ap.platform = ?'); params.push(platform) }
  if (status)   { conds.push('b.status_label = ?'); params.push(status) }
  if (appId)    { conds.push('b.app_id = ?'); params.push(Number(appId)) }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const baseFrom = `
    FROM builds b
    LEFT JOIN apps ap ON ap.id = b.app_id
    LEFT JOIN users u  ON u.id  = b.uploader_id
  `

  const total = (db.prepare(
    `SELECT COUNT(*) as n ${baseFrom} ${where}`
  ).get(...params) as { n: number }).n

  const items = db.prepare(`
    SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
           b.version_label, b.status_label, b.platform,
           b.bundle_id, b.uploaded_at, b.completed_at,
           COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1)) as uploader
    ${baseFrom}
    ${where}
    ORDER BY b.${sortKey} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, page * limit)

  json(res, 200, { items, total })
}

export function handleGetBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth) return

  const build = getDb().prepare(`
    SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
           b.version_label, b.status_label, b.platform, b.bundle_id, b.uploaded_at, b.completed_at
    FROM builds b
    LEFT JOIN apps ap ON ap.id = b.app_id
    WHERE b.id = ?
  `).get(params.id)

  if (!build) return json(res, 404, { error: 'Build not found' })
  json(res, 200, build)
}

export async function handleUpdateBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return

  const db = getDb()
  const existing = db.prepare('SELECT status_label FROM builds WHERE id = ?').get(params.id) as
    | { status_label: string | null }
    | undefined
  if (!existing) return json(res, 404, { error: 'Build not found' })

  const body = await readJson<{ status_label?: string | null; version_label?: string | null }>(req)
  const VALID_STATUS = ['Backlog', 'In Progress', 'Done', 'Rejected']
  const updates: string[] = []
  const values: unknown[] = []

  if ('status_label' in body) {
    if (body.status_label !== null && !VALID_STATUS.includes(body.status_label ?? '')) {
      return json(res, 400, { error: 'Invalid status_label' })
    }
    updates.push('status_label = ?')
    values.push(body.status_label ?? null)
    if (body.status_label === 'Done') {
      updates.push("completed_at = datetime('now')")
    } else if (existing.status_label === 'Done') {
      updates.push('completed_at = NULL')
    }
  }
  if ('version_label' in body) {
    updates.push('version_label = ?')
    values.push(body.version_label ?? null)
  }

  if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

  const result = db.prepare(`UPDATE builds SET ${updates.join(', ')} WHERE id = ?`).run(...values, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  json(res, 200, { ok: true })
}

export function handleUploadBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const pat  = verifyPat(req)
  const auth = pat ? { userId: pat.userId } : requireAuth(req, res)
  if (!auth) return

  if (pat && !pat.scope.includes('builds:write')) {
    return json(res, 403, { error: 'Insufficient scope' })
  }

  const bb = busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } })
  const fields: Record<string, string> = {}
  let savedPath = ''
  let originalName = ''
  let fileError = ''
  let writePromise: Promise<void> = Promise.resolve()

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    originalName = info.filename
    const ext = path.extname(originalName).toLowerCase()

    if (ext === '.ipa') {
      fileError = 'iOS 시뮬레이터용 빌드는 .app.zip 형식이어야 합니다. xcodebuild -sdk iphonesimulator 로 빌드한 .app 디렉토리를 zip 압축해 업로드하세요.'
      stream.resume()
      return
    }
    if (!['.zip', '.apk'].includes(ext)) {
      fileError = 'Only .app.zip (iOS) or .apk (Android) files allowed'
      stream.resume()
      return
    }

    const fileName = `${Date.now()}_${path.basename(originalName)}`
    savedPath = path.join(uploadsDir, 'builds', fileName)
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    const ws = fs.createWriteStream(savedPath)
    writePromise = new Promise((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
    stream.pipe(ws)
  })

  bb.on('finish', async () => {
    if (fileError) return json(res, 400, { error: fileError })
    if (!savedPath) return json(res, 400, { error: 'File required' })

    await writePromise

    const ext = path.extname(originalName).toLowerCase()
    const isIos = ext === '.zip'
    const platform = fields.platform ?? (isIos ? 'ios' : 'android')
    const status = ['Backlog', 'In Progress', 'Done', 'Rejected'].includes(fields.status)
      ? fields.status : null

    let bundleId: string | null = null
    let versionName: string | null = null
    let buildNumber: string | null = null
    let resolvedAppName: string | null = null

    if (isIos) {
      const info = extractAppZipInfo(savedPath)
      if (info === null) {
        fs.unlinkSync(savedPath)
        return json(res, 400, { error: 'zip 안에서 .app 디렉토리를 찾을 수 없습니다. .app 디렉토리를 포함한 zip 파일을 업로드하세요.' })
      }

      // lipo 슬라이스 검증 (macOS only; Linux에서는 null → skip)
      const appDir = findAppDirInZip(savedPath)
      if (appDir) {
        const sliceOk = hasSimulatorSlice(savedPath, appDir)
        if (sliceOk === false) {
          fs.unlinkSync(savedPath)
          return json(res, 400, { error: '디바이스용 슬라이스만 포함된 빌드입니다. xcodebuild -sdk iphonesimulator 로 빌드해 시뮬레이터 슬라이스를 포함하세요.' })
        }
      }

      bundleId     = info.bundleId
      versionName  = info.versionName
      buildNumber  = info.buildNumber
      resolvedAppName = info.appName
    } else {
      const info = extractApkInfo(savedPath)
      bundleId        = info.bundleId
      versionName     = info.versionName
      buildNumber     = info.buildNumber
      resolvedAppName = info.appName
    }

    const bundleIdKey = bundleId ?? '__unknown__'
    const appName     = resolvedAppName ?? fields.label ?? path.basename(originalName, ext)

    const db = getDb()
    let appId: number

    if (fields.app_id) {
      appId = Number(fields.app_id)
      const app = db.prepare('SELECT id, bundle_id_key, platform FROM apps WHERE id = ?')
        .get(appId) as { id: number; bundle_id_key: string | null; platform: string } | undefined
      if (!app) {
        fs.unlinkSync(savedPath)
        return json(res, 404, { error: 'App not found' })
      }
      // 추출된 bundle_id가 지정한 앱과 다르면 bundle_id 기준으로 앱을 찾거나 생성
      if (bundleId && app.bundle_id_key && app.bundle_id_key !== bundleId) {
        appId = upsertApp(appName, bundleIdKey, platform)
      } else {
        if (app.platform !== 'both' && app.platform !== platform) {
          db.prepare('UPDATE apps SET platform = ? WHERE id = ?').run('both', appId)
        }
        if (!app.bundle_id_key && bundleId) {
          db.prepare('UPDATE apps SET bundle_id_key = ? WHERE id = ?').run(bundleId, appId)
        }
      }
    } else {
      appId = upsertApp(appName, bundleIdKey, platform)
    }

    const result = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, status_label, file_path, label, version_label, uploader_id, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(appId, versionName, buildNumber, bundleId, status, savedPath, fields.label ?? null, fields.label ?? null, auth.userId, platform)

    const build = db.prepare(`
      SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
             b.bundle_id, b.status_label, b.platform, b.uploaded_at
      FROM builds b LEFT JOIN apps ap ON ap.id = b.app_id
      WHERE b.id = ?
    `).get(result.lastInsertRowid)

    json(res, 201, build)
  })

  bb.on('error', () => json(res, 500, { error: 'Upload failed' }))
  req.pipe(bb)
}

const BUILD_TTL_DAYS = Number(process.env['TAPFLOW_BUILD_TTL_DAYS'] ?? 7)

export function purgeExpiredBuilds(): void {
  const db = getDb()
  const expired = db.prepare(
    `SELECT id, file_path FROM builds WHERE completed_at < datetime('now', '-' || ? || ' days')`
  ).all(BUILD_TTL_DAYS) as { id: number; file_path: string }[]

  if (expired.length === 0) return

  for (const { file_path } of expired) {
    try { fs.unlinkSync(file_path) } catch { /* 이미 없는 파일은 무시 */ }
  }

  const placeholders = expired.map(() => '?').join(',')
  db.prepare(`DELETE FROM builds WHERE id IN (${placeholders})`).run(...expired.map((r) => r.id))
}
