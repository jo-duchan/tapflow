import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { writeZipFixture } from './helpers/zipFixture'
import { assertArchiveTools } from './helpers/archivePrereqs'

// multipart/form-data 바디를 직접 구성한다 (busboy 파싱용).
function multipartBody(boundary: string, parts: { name: string; filename?: string; contentType?: string; data: Buffer | string }[]): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    let disp = `Content-Disposition: form-data; name="${p.name}"`
    if (p.filename) disp += `; filename="${p.filename}"`
    chunks.push(Buffer.from(disp + '\r\n'))
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function httpPostMultipart(port: number, urlPath: string, body: Buffer, boundary: string, cookie: string, method = 'POST'): Promise<{ status: number; body: { error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

// #7 — 업로드 크기 초과 시 truncate된 파일을 저장하지 않고 거부 + orphan 정리
describe('upload size-limit handling', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(() => {
    assertArchiveTools(['unzip'])
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-upload-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })

  // Guarded: assertArchiveTools above can throw before tmpDir is assigned.
  afterAll(() => {
    closeDb()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Nested, because recordings go beside uploads (`<uploads>/../recordings`), not under the system tmp root.
    uploadsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-uploads-')), 'uploads')
    fs.mkdirSync(uploadsDir)
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(path.dirname(uploadsDir), { recursive: true, force: true })
    delete process.env.TAPFLOW_MAX_BUILD_BYTES
    delete process.env.TAPFLOW_MAX_COMMENT_BYTES
    delete process.env.TAPFLOW_MAX_RECORDING_BYTES
    delete process.env.TAPFLOW_MIN_FREE_DISK_BYTES
  })

  it('빌드: 크기 상한 초과 → 400 + uploads/builds에 잔존 파일 없음', async () => {
    process.env.TAPFLOW_MAX_BUILD_BYTES = '100'
    const boundary = 'X1'
    const body = multipartBody(boundary, [{ name: 'file', filename: 'app.zip', contentType: 'application/zip', data: Buffer.alloc(500, 0x41) }])
    const r = await httpPostMultipart(port, '/api/v1/builds', body, boundary, cookie)
    expect(r.status).toBe(400)
    const buildsDir = path.join(uploadsDir, 'builds')
    const leftover = fs.existsSync(buildsDir) ? fs.readdirSync(buildsDir) : []
    expect(leftover).toEqual([])
  })

  it('빌드: 상한 이내 정상 업로드는 거부되지 않음 (size 한도 통과)', async () => {
    process.env.TAPFLOW_MAX_BUILD_BYTES = String(10 * 1024)
    const boundary = 'X2'
    // 유효 zip이 아니므로 메타추출에서 다른 에러가 날 수 있지만, size 초과(400 exceeds)로는 거부되지 않아야 한다.
    const body = multipartBody(boundary, [{ name: 'file', filename: 'app.zip', contentType: 'application/zip', data: Buffer.alloc(200, 0x41) }])
    const r = await httpPostMultipart(port, '/api/v1/builds', body, boundary, cookie)
    expect(r.body.error).not.toBe('File exceeds the upload size limit')
  })

  // #263 — build-validation errors are returned in English, not Korean
  it('빌드: .ipa 업로드는 400 + 영어 안내', async () => {
    const boundary = 'X3'
    const body = multipartBody(boundary, [{ name: 'file', filename: 'app.ipa', contentType: 'application/octet-stream', data: Buffer.alloc(50, 0x41) }])
    const r = await httpPostMultipart(port, '/api/v1/builds', body, boundary, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('iOS simulator builds must be in .app.zip or .tar.gz format. Zip (or tar.gz, e.g. an EAS simulator build) the .app directory built for iphonesimulator and upload it.')
  })

  it('빌드: .app 디렉토리 없는 zip은 400 + 영어 안내', async () => {
    const noAppZip = path.join(uploadsDir, 'noapp.zip')
    writeZipFixture(noAppZip, [{ name: 'readme.txt', data: 'hello' }])
    const boundary = 'X4'
    const body = multipartBody(boundary, [{ name: 'file', filename: 'app.zip', contentType: 'application/zip', data: fs.readFileSync(noAppZip) }])
    const r = await httpPostMultipart(port, '/api/v1/builds', body, boundary, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('No .app directory found in the archive. Upload a .app.zip or .tar.gz that contains a .app directory.')
  })

  it('댓글 첨부: 크기 상한 초과 → 400 + uploads/comments에 잔존 파일 없음', async () => {
    process.env.TAPFLOW_MAX_COMMENT_BYTES = '100'
    const boundary = 'Y1'
    const body = multipartBody(boundary, [
      { name: 'build_id', data: '1' },
      { name: 'body', data: 'hi' },
      { name: 'file', filename: 'a.png', contentType: 'image/png', data: Buffer.alloc(500, 0x42) },
    ])
    const r = await httpPostMultipart(port, '/api/v1/comments', body, boundary, cookie)
    expect(r.status).toBe(400)
    const commentsDir = path.join(uploadsDir, 'comments')
    const leftover = fs.existsSync(commentsDir) ? fs.readdirSync(commentsDir) : []
    expect(leftover).toEqual([])
  })

  // Avatar and team logo used to be written straight over the live image, so an upload that failed left
  // it empty or cut short; and busboy stops at the size limit rather than failing, so an oversized one
  // was saved truncated. Now staged and renamed into place only when complete.
  it.each([
    ['avatar', '/api/v1/profile', 'avatar', path.join('avatars', 'user-1.png')],
    ['team logo', '/api/v1/settings', 'logo', path.join('team', 'logo.png')],
  ])('%s: an oversized replacement is refused and leaves the current image as it was', async (_name, route, field, rel) => {
    const live = path.join(uploadsDir, rel)
    fs.mkdirSync(path.dirname(live), { recursive: true })
    fs.writeFileSync(live, 'current-image')
    const boundary = 'image-limit'
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1)
    const body = multipartBody(boundary, [{ name: field, filename: 'a.png', contentType: 'image/png', data: big }])
    const r = await httpPostMultipart(port, route, body, boundary, cookie, 'PATCH')
    expect(r.status).toBe(400)
    expect(fs.readFileSync(live, 'utf8')).toBe('current-image')
    expect(fs.readdirSync(path.dirname(live)).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('avatar: a complete upload replaces the image and leaves nothing staged behind', async () => {
    const boundary = 'avatar-ok'
    const body = multipartBody(boundary, [{ name: 'avatar', filename: 'a.png', contentType: 'image/png', data: 'new-image' }])
    const r = await httpPostMultipart(port, '/api/v1/profile', body, boundary, cookie, 'PATCH')
    expect(r.status).toBe(200)
    const dir = path.join(uploadsDir, 'avatars')
    expect(fs.readFileSync(path.join(dir, 'user-1.png'), 'utf8')).toBe('new-image')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  // GHSA-jj96-5xwq-j8mx: any signed-in role could upload recordings of any size, so repeated uploads filled the
  // volume the database shares.
  const recordingsDir = () => path.join(uploadsDir, '..', 'recordings')
  const recordingRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM recordings').get() as { n: number }).n
  const onDisk = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

  it('recording: over the size limit → 413, no file kept and no row', async () => {
    process.env.TAPFLOW_MAX_RECORDING_BYTES = '100'
    const before = recordingRows()
    const boundary = 'rec-big'
    const body = multipartBody(boundary, [{ name: 'file', filename: 'r.webm', contentType: 'video/webm', data: Buffer.alloc(500, 1) }])
    const r = await httpPostMultipart(port, '/api/v1/recordings/upload', body, boundary, cookie)
    expect(r.status).toBe(413)
    expect(onDisk(recordingsDir())).toEqual([])
    expect(recordingRows()).toBe(before)
  })

  it('recording: within the limit is kept', async () => {
    process.env.TAPFLOW_MAX_RECORDING_BYTES = String(10 * 1024)
    const boundary = 'rec-ok'
    const body = multipartBody(boundary, [{ name: 'file', filename: 'r.webm', contentType: 'video/webm', data: Buffer.alloc(500, 1) }])
    const r = await httpPostMultipart(port, '/api/v1/recordings/upload', body, boundary, cookie)
    expect(r.status).toBe(200)
    expect(onDisk(recordingsDir())).toHaveLength(1)
  })

  // A second part used to be written too, with no row naming it, so the TTL purge never removed it.
  it('recording: a second file part is not written', async () => {
    const boundary = 'rec-two'
    const body = multipartBody(boundary, [
      { name: 'file', filename: 'a.webm', contentType: 'video/webm', data: Buffer.alloc(100, 1) },
      { name: 'file', filename: 'b.webm', contentType: 'video/webm', data: Buffer.alloc(100, 2) },
    ])
    const r = await httpPostMultipart(port, '/api/v1/recordings/upload', body, boundary, cookie)
    expect(r.status).toBe(200)
    expect(onDisk(recordingsDir())).toHaveLength(1)
  })

  it.each([
    ['recording', 'POST', '/api/v1/recordings/upload', () => recordingsDir(), [{ name: 'file', filename: 'r.webm', contentType: 'video/webm', data: 'video' }]],
    ['build', 'POST', '/api/v1/builds', () => path.join(uploadsDir, 'builds'), [{ name: 'file', filename: 'app.apk', contentType: 'application/octet-stream', data: 'apk' }]],
    ['comment attachment', 'POST', '/api/v1/comments', () => path.join(uploadsDir, 'comments'), [
      { name: 'build_id', data: '1' }, { name: 'body', data: 'hi' },
      { name: 'file', filename: 'a.png', contentType: 'image/png', data: 'png' },
    ]],
    ['avatar', 'PATCH', '/api/v1/profile', () => path.join(uploadsDir, 'avatars'), [{ name: 'avatar', filename: 'a.png', contentType: 'image/png', data: 'png' }]],
    ['team logo', 'PATCH', '/api/v1/settings', () => path.join(uploadsDir, 'team'), [{ name: 'logo', filename: 'a.png', contentType: 'image/png', data: 'png' }]],
  ] as const)('%s: refused with 507 below the free-space floor, nothing left on disk', async (_name, method, route, dir, parts) => {
    process.env.TAPFLOW_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER)
    const boundary = 'floor'
    const r = await httpPostMultipart(port, route, multipartBody(boundary, [...parts]), boundary, cookie, method)
    expect(r.status).toBe(507)
    expect(onDisk(dir())).toEqual([])
  })

  // A failed write rejects what the build route awaits in an async listener; uncaught, that ended the relay.
  it.skipIf(process.platform === 'win32')('빌드: 저장 실패 → 500 응답, 릴레이는 계속 동작', async () => {
    const buildsDir = path.join(uploadsDir, 'builds')
    fs.mkdirSync(buildsDir, { recursive: true })
    fs.chmodSync(buildsDir, 0o500)
    try {
      const boundary = 'write-fails'
      const body = multipartBody(boundary, [{ name: 'file', filename: 'app.apk', contentType: 'application/octet-stream', data: 'apk-bytes' }])
      const r = await httpPostMultipart(port, '/api/v1/builds', body, boundary, cookie)
      expect(r.status).toBe(500)
      expect(fs.readdirSync(buildsDir)).toEqual([])
    } finally {
      fs.chmodSync(buildsDir, 0o700)
    }
  })
})
