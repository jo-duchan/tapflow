import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

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

function httpPostMultipart(port: number, urlPath: string, body: Buffer, boundary: string, cookie: string): Promise<{ status: number; body: { error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-upload-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-uploads-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    delete process.env.TAPFLOW_MAX_BUILD_BYTES
    delete process.env.TAPFLOW_MAX_COMMENT_BYTES
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
    const readme = path.join(uploadsDir, 'readme.txt')
    fs.writeFileSync(readme, 'hello')
    const noAppZip = path.join(uploadsDir, 'noapp.zip')
    spawnSync('zip', ['-j', noAppZip, readme])
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
})
