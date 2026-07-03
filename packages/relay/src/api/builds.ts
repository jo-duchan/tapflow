import http from 'http'
import fs from 'fs'
import zlib from 'zlib'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { requireAuth, requireBuildAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { unlinkSafe } from '../lib/uploads.js'

// ── archive kind ───────────────────────────────────────────────────────────

// path.extname('app.tar.gz') === '.gz', so compound extensions can't be detected
// with extname alone. Match the full suffix, longest first.
export type BuildFileKind = 'ios-zip' | 'ios-tar' | 'android' | 'ipa' | 'aab' | 'unknown'

export function buildFileKind(filename: string): BuildFileKind {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'ios-tar'
  if (lower.endsWith('.zip')) return 'ios-zip'
  if (lower.endsWith('.apk')) return 'android'
  if (lower.endsWith('.ipa')) return 'ipa'
  if (lower.endsWith('.aab')) return 'aab'
  return 'unknown'
}

/** 알려진 아카이브 확장자를 벗긴 베이스 이름(메타 부재 시 앱 이름 폴백용). */
function stripArchiveExt(filename: string): string {
  const base = path.basename(filename)
  const lower = base.toLowerCase()
  for (const ext of ['.tar.gz', '.tgz', '.app.zip', '.zip', '.apk', '.ipa', '.aab']) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length)
  }
  return base.replace(/\.[^.]+$/, '')
}

// ── zip / plist helpers ────────────────────────────────────────────────────

function parseXmlPlist(xml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) result[m[1]] = m[2]
  return result
}

type AppInfo = {
  bundleId: string | null
  versionName: string | null
  buildNumber: string | null
  appName: string | null
}

/** Info.plist Buffer(xml 또는 bplist)에서 CFBundle* 를 파싱한다. 아카이브 종류와 무관. */
function parseInfoPlist(plistBuf: Buffer): AppInfo {
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

// 아카이브 리스트/엔트리 읽기의 stdout 상한. 기본 maxBuffer(1MB)는 파일 많은 큰 .app
// 리스트나 큰 실행 바이너리에서 넘쳐(ENOBUFS, status=null) 검증을 스킵/오탐시킬 수 있어
// 넉넉히 잡는다. 초과 시엔 각 호출부가 fail-closed(거절)로 처리한다.
const ARCHIVE_READ_MAXBUFFER = 256 * 1024 * 1024 // 256 MB

/** zip 내 루트 수준 *.app 디렉토리 이름을 찾는다. 없으면 null. */
function findAppDirInZip(zipPath: string): string | null {
  const list = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.status !== 0) return null
  // "  12345  2024-01-01 00:00:00  MyApp.app/"  형태를 매칭 (앱 이름에 공백 포함 가능)
  // HH:MM 시간 컬럼을 기준점으로 삼아 filename 컬럼만 캡처
  const re = /\d{2}:\d{2}\s+(\S[^/\n]*\.app)\/\s*$/m
  const m = re.exec(list.stdout as string)
  if (!m) return null
  // 루트 레벨만 (슬래시 미포함)
  const candidate = m[1]
  return candidate.includes('/') ? null : candidate
}

/** .app.zip에서 앱 메타데이터를 추출한다. 구조 오류 시 null. */
export function extractAppZipInfo(zipPath: string): AppInfo | null {
  const appDir = findAppDirInZip(zipPath)
  if (!appDir) return null

  const extract = spawnSync('unzip', ['-p', zipPath, `${appDir}/Info.plist`], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (extract.status !== 0 || !extract.stdout) return null

  return parseInfoPlist(extract.stdout as Buffer)
}

// ── tar.gz helpers (EAS 시뮬레이터 산출물) ──────────────────────────────────
// tar 는 순차 스캔이라 zip 처럼 랜덤액세스가 어렵다. tar 바이너리가 이름을 해석하게
// 두어(-tzf/-xzOf) PAX/GNU long-name 도 안전하게 처리한다 (손으로 파싱하지 않음).

/** tar.gz 내 루트 수준 *.app 디렉토리 이름을 찾는다. 없으면 null. */
function findAppDirInTar(tarPath: string): string | null {
  const list = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.status !== 0) return null
  // 최상위 "Foo.app/..." 만 — 프레임워크 내부 중첩 .app/Info.plist 오탐 방지.
  const re = /^(?:\.\/)?([^/]+\.app)\//m
  const m = re.exec(list.stdout as string)
  return m ? m[1] : null
}

/** tar.gz 안 특정 엔트리를 stdout Buffer 로 읽는다. 실패 시 null. */
function readTarEntry(tarPath: string, entry: string): Buffer | null {
  // 아카이브가 "./Foo.app/..." 형태일 수 있어 두 후보를 시도한다.
  for (const name of [entry, `./${entry}`]) {
    const r = spawnSync('tar', ['-xzOf', tarPath, name], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
    if (r.status === 0 && r.stdout && (r.stdout as Buffer).length) return r.stdout as Buffer
  }
  return null
}

/** .tar.gz 안 *.app/Info.plist 에서 앱 메타데이터를 추출한다. 구조 오류 시 null. */
export function extractAppTarInfo(tarPath: string): AppInfo | null {
  const appDir = findAppDirInTar(tarPath)
  if (!appDir) return null

  const buf = readTarEntry(tarPath, `${appDir}/Info.plist`)
  if (!buf) return null

  return parseInfoPlist(buf)
}

// ── archive-agnostic dispatch ───────────────────────────────────────────────

function findAppDir(filePath: string): string | null {
  return buildFileKind(filePath) === 'ios-tar' ? findAppDirInTar(filePath) : findAppDirInZip(filePath)
}

export function extractAppInfo(filePath: string): AppInfo | null {
  return buildFileKind(filePath) === 'ios-tar' ? extractAppTarInfo(filePath) : extractAppZipInfo(filePath)
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
 * Mach-O 바이너리 Buffer에 lipo -info 를 돌려 시뮬레이터 슬라이스 존재를 확인한다.
 * lipo 미설치(Linux relay) 시 null 반환 → 검증 skip.
 */
function lipoHasSimSlice(binaryBuf: Buffer): boolean | null {
  const tmpBin = path.join(tmpdir(), `tapflow-lipo-${randomUUID()}`)
  fs.writeFileSync(tmpBin, binaryBuf)
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

/** .app.zip / .tar.gz 의 .app 실행 바이너리에 시뮬레이터 슬라이스가 있는지 확인. */
function hasSimulatorSlice(filePath: string, appDir: string): boolean | null {
  const binaryName = path.basename(appDir, '.app')
  let binaryBuf: Buffer | null = null

  if (buildFileKind(filePath) === 'ios-tar') {
    binaryBuf = readTarEntry(filePath, `${appDir}/${binaryName}`)
  } else {
    const extract = spawnSync('unzip', ['-p', filePath, `${appDir}/${binaryName}`], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
    if (extract.status === 0 && extract.stdout?.length) binaryBuf = extract.stdout as Buffer
  }

  if (!binaryBuf?.length) return null
  return lipoHasSimSlice(binaryBuf)
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
  const auth = requireBuildAuth(req, res)
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
           b.bundle_id, b.uploaded_at, b.completed_at, b.delete_after,
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
  if (!requireBuildAuth(req, res)) return

  const build = getDb().prepare(`
    SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
           b.version_label, b.status_label, b.platform, b.bundle_id, b.uploaded_at, b.completed_at, b.delete_after
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
    if (body.status_label === 'Done' && existing.status_label !== 'Done') {
      updates.push("completed_at = datetime('now')")
    } else if (body.status_label !== 'Done' && existing.status_label === 'Done') {
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

// Schedule deletion: an explicit, manual action that puts the build on the purge
// clock (delete_after = now + TTL). Orthogonal to status_label (issue #258).
export function handleScheduleBuildDeletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  if (!requireAuth(req, res)) return
  const db = getDb()
  const result = db
    .prepare(`UPDATE builds SET delete_after = datetime('now', '+' || ? || ' days') WHERE id = ?`)
    .run(BUILD_TTL_DAYS, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  // Return the authoritative timestamp so the client doesn't re-derive the TTL.
  const row = db.prepare('SELECT delete_after FROM builds WHERE id = ?').get(params.id) as { delete_after: string }
  json(res, 200, { ok: true, delete_after: row.delete_after })
}

// Cancel a scheduled deletion: take the build back off the purge clock.
export function handleCancelBuildDeletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  if (!requireAuth(req, res)) return
  const result = getDb().prepare('UPDATE builds SET delete_after = NULL WHERE id = ?').run(params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  json(res, 200, { ok: true })
}

// 업로드 크기 상한(바이트). 기본 500 MB, TAPFLOW_MAX_BUILD_BYTES로 조정 가능.
function maxBuildUploadBytes(): number {
  const v = Number(process.env.TAPFLOW_MAX_BUILD_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 500 * 1024 * 1024
}

// 해제 후 크기 상한(gzip bomb 방어). 압축 전 상한과 별개. 기본 업로드 상한×4.
function maxUnpackedBytes(): number {
  const v = Number(process.env.TAPFLOW_MAX_UNPACKED_BYTES)
  return Number.isFinite(v) && v > 0 ? v : maxBuildUploadBytes() * 4
}

/**
 * 업로드된 .tar.gz 를 설치 전에 검증한다 (R7). tar 바이너리가 이름을 해석하므로
 * PAX/GNU long-name 우회가 없다. 문제 시 에러 문구, 정상 시 null.
 * - 손상/비-gzip: tar -tzf 실패
 * - path traversal: 절대경로 또는 `..` 세그먼트
 * - symlink/hardlink 탈출: -tzvf 의 타입 문자(l/h)
 * - gzip bomb: 해제 스트림 바이트가 상한 초과 (전체 버퍼링 없이 조기 중단)
 */
export async function validateTarGz(tarPath: string): Promise<string | null> {
  // fail-closed: 버퍼 초과(ENOBUFS, status=null)나 tar 부재(ENOENT)면 stdout이 잘려
  // 검증이 우회될 수 있으므로 거절한다. maxBuffer 를 넉넉히 잡아 정상 아카이브는 통과.
  const list = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.error || list.status !== 0) return 'Corrupt or invalid .tar.gz archive.'

  const names = (list.stdout as string).split('\n').filter(Boolean)
  for (const raw of names) {
    const name = raw.replace(/^\.\//, '')
    if (name.startsWith('/') || name.split('/').some((seg) => seg === '..')) {
      return 'Archive contains an unsafe path (absolute or ".." escape) and was rejected.'
    }
  }

  // 엔트리 타입 검사: ls -l 스타일 첫 문자 l(symlink)/h(hardlink) 거부.
  // 목록을 못 얻으면(에러/잘림) symlink 검사를 건너뛰지 말고 fail-closed 로 거절한다.
  const verbose = spawnSync('tar', ['-tzvf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (verbose.error || verbose.status !== 0) return 'Corrupt or invalid .tar.gz archive.'
  for (const line of (verbose.stdout as string).split('\n')) {
    const c = line[0]
    if (c === 'l' || c === 'h') {
      return 'Archive contains a symbolic or hard link and was rejected.'
    }
  }

  // gzip bomb: 스트리밍 해제 바이트를 세며 상한 초과 시 즉시 중단 (t3.small 메모리 보호).
  const cap = maxUnpackedBytes()
  return await new Promise<string | null>((resolve) => {
    let total = 0
    let done = false
    const input = fs.createReadStream(tarPath)
    const gunzip = zlib.createGunzip()
    const finish = (r: string | null) => {
      if (done) return
      done = true
      input.destroy()
      gunzip.destroy()
      resolve(r)
    }
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap) finish('Archive exceeds the maximum unpacked size limit.')
    })
    gunzip.on('end', () => finish(null))
    gunzip.on('error', () => finish('Corrupt or invalid .tar.gz archive.'))
    input.on('error', () => finish('Corrupt or invalid .tar.gz archive.'))
    input.pipe(gunzip)
  })
}

export function handleUploadBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireBuildAuth(req, res)
  if (!auth) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: maxBuildUploadBytes() } })
  const fields: Record<string, string> = {}
  let savedPath = ''
  let originalName = ''
  let fileError = ''
  let writePromise: Promise<void> = Promise.resolve()

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    originalName = info.filename
    const kind = buildFileKind(originalName)

    if (kind === 'ipa') {
      fileError = 'iOS simulator builds must be in .app.zip or .tar.gz format. Zip (or tar.gz, e.g. an EAS simulator build) the .app directory built for iphonesimulator and upload it.'
      stream.resume()
      return
    }
    if (kind === 'aab') {
      fileError = 'Android emulator installs require an .apk. Build an .apk (not .aab) and upload it.'
      stream.resume()
      return
    }
    if (kind === 'unknown') {
      fileError = 'Only .app.zip / .tar.gz (iOS) or .apk (Android) files allowed'
      stream.resume()
      return
    }

    // 충돌 방지: 같은 ms + 같은 파일명 동시 업로드(특히 CI 자동화) 시 file_path 공유를 막는다.
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}_${path.basename(originalName)}`
    savedPath = path.join(uploadsDir, 'builds', fileName)
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    const ws = fs.createWriteStream(savedPath)
    writePromise = new Promise((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
    // 크기 상한 초과 시 busboy가 스트림을 잘라('limit') 보내므로, 잘린 파일을 유효 빌드로 저장하면 안 된다.
    stream.on('limit', () => { fileError = 'File exceeds the upload size limit' })
    stream.pipe(ws)
  })

  bb.on('finish', async () => {
    await writePromise
    if (fileError) {
      if (savedPath) unlinkSafe(savedPath, 'rejected upload')
      return json(res, 400, { error: fileError })
    }
    if (!savedPath) return json(res, 400, { error: 'File required' })

    const kind = buildFileKind(originalName)
    const isIos = kind === 'ios-zip' || kind === 'ios-tar'
    const platform = fields.platform ?? (isIos ? 'ios' : 'android')
    const status = ['Backlog', 'In Progress', 'Done', 'Rejected'].includes(fields.status)
      ? fields.status : null

    let bundleId: string | null = null
    let versionName: string | null = null
    let buildNumber: string | null = null
    let resolvedAppName: string | null = null

    if (isIos) {
      // .tar.gz 는 설치 전에 traversal/symlink/bomb/손상을 걸러낸다 (R7).
      if (kind === 'ios-tar') {
        const tarError = await validateTarGz(savedPath)
        if (tarError) {
          unlinkSafe(savedPath, 'rejected upload')
          return json(res, 400, { error: tarError })
        }
      }

      const info = extractAppInfo(savedPath)
      if (info === null) {
        fs.unlinkSync(savedPath)
        return json(res, 400, { error: 'No .app directory found in the archive. Upload a .app.zip or .tar.gz that contains a .app directory.' })
      }

      // lipo 슬라이스 검증 (macOS only; Linux에서는 null → skip)
      const appDir = findAppDir(savedPath)
      if (appDir) {
        const sliceOk = hasSimulatorSlice(savedPath, appDir)
        if (sliceOk === false) {
          fs.unlinkSync(savedPath)
          return json(res, 400, { error: 'This build contains device-only slices. Build for iphonesimulator to include a simulator slice.' })
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
    const appName     = resolvedAppName ?? fields.label ?? stripArchiveExt(originalName)

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

// Fall back to 7 when the env var is missing or malformed; a NaN here would make
// SQLite store delete_after as NULL and silently skip scheduling.
const ttlEnv = Number(process.env['TAPFLOW_BUILD_TTL_DAYS'])
const BUILD_TTL_DAYS = Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 7
const SQLITE_MAX_PARAMS = 999

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}


export function purgeExpiredBuilds(recordingsDir: string): void {
  const db = getDb()
  const expired = db.prepare(
    `SELECT id, file_path FROM builds WHERE delete_after IS NOT NULL AND delete_after < datetime('now')`
  ).all() as { id: number; file_path: string }[]

  if (expired.length === 0) return

  const buildIds = expired.map((r) => r.id)
  const chunks = chunkArray(buildIds, SQLITE_MAX_PARAMS)

  // 연결된 recording 파일 삭제 후 레코드 제거 (recordings.build_id FK에 CASCADE 없음)
  const recordings = chunks.flatMap((chunk) => {
    const ph = chunk.map(() => '?').join(',')
    return db.prepare(`SELECT filename FROM recordings WHERE build_id IN (${ph})`).all(...chunk) as { filename: string }[]
  })
  for (const { filename } of recordings) {
    unlinkSafe(path.join(recordingsDir, filename), 'recording')
  }
  if (recordings.length > 0) {
    for (const chunk of chunks) {
      const ph = chunk.map(() => '?').join(',')
      db.prepare(`DELETE FROM recordings WHERE build_id IN (${ph})`).run(...chunk)
    }
  }

  for (const { file_path } of expired) {
    unlinkSafe(file_path, 'build')
  }
  for (const chunk of chunks) {
    const ph = chunk.map(() => '?').join(',')
    db.prepare(`DELETE FROM builds WHERE id IN (${ph})`).run(...chunk)
  }
}
