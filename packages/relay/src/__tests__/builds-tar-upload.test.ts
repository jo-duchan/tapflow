import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { makeAppTarGz, writeRawTarGz } from './helpers/tarFixture'

const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.eas</string>
  <key>CFBundleShortVersionString</key><string>2.1.0</string>
  <key>CFBundleVersion</key><string>42</string>
  <key>CFBundleDisplayName</key><string>EAS App</string>
</dict></plist>`

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

type UploadResult = { status: number; body: { error?: string; bundle_id?: string; version_name?: string; build_number?: string; platform?: string } }

function postTar(port: number, boundary: string, filename: string, data: Buffer, cookie: string): Promise<UploadResult> {
  const body = multipartBody(boundary, [{ name: 'file', filename, contentType: 'application/gzip', data }])
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/v1/builds', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
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

describe('POST /api/v1/builds — .tar.gz (EAS simulator) ingest', () => {
  let server: RelayServer
  let port: number
  let dbDir: string
  let fixtureDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-targz-db-'))
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-targz-fix-'))
    initDb(path.join(dbDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-targz-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    delete process.env.TAPFLOW_MAX_UNPACKED_BYTES
  })

  const buildsDir = () => path.join(uploadsDir, 'builds')
  const leftover = () => (fs.existsSync(buildsDir()) ? fs.readdirSync(buildsDir()) : [])

  // #1 — 정상 tar.gz 업로드 → 201 + 메타 추출
  it('accepts a valid .tar.gz and extracts metadata (201)', async () => {
    const tarPath = makeAppTarGz(fixtureDir, 'EasApp', XML_PLIST)
    const r = await postTar(port, 'T1', 'EasApp.tar.gz', fs.readFileSync(tarPath), cookie)
    expect(r.status).toBe(201)
    expect(r.body.bundle_id).toBe('com.example.eas')
    expect(r.body.version_name).toBe('2.1.0')
    expect(r.body.build_number).toBe('42')
    expect(r.body.platform).toBe('ios')
    expect(leftover()).toHaveLength(1)
  })

  // #3 — .tgz 확장자
  it('accepts the .tgz extension', async () => {
    const tarPath = makeAppTarGz(fixtureDir, 'TgzApp', XML_PLIST, '.tgz')
    const r = await postTar(port, 'T3', 'TgzApp.tgz', fs.readFileSync(tarPath), cookie)
    expect(r.status).toBe(201)
    expect(r.body.bundle_id).toBe('com.example.eas')
  })

  // #4 — .ipa 거절, 안내에 .tar.gz 포함
  it('rejects .ipa with guidance mentioning .tar.gz', async () => {
    const r = await postTar(port, 'T4', 'app.ipa', Buffer.alloc(50, 0x41), cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('.tar.gz')
  })

  // #5 — .aab 거절
  it('rejects .aab with .apk guidance', async () => {
    const r = await postTar(port, 'T5', 'app.aab', Buffer.alloc(50, 0x41), cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('.apk')
  })

  // #6 — path traversal 엔트리 → 400, 잔존 파일 0
  it('rejects a tar.gz with a path-traversal entry and leaves no build file', async () => {
    const evil = writeRawTarGz([{ name: '../../etc/passwd', data: Buffer.from('pwned') }])
    const r = await postTar(port, 'T6', 'evil.tar.gz', evil, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/unsafe path|\.\./i)
    expect(leftover()).toEqual([])
  })

  // #7 — symlink 탈출 엔트리 → 400
  it('rejects a tar.gz containing a symbolic link', async () => {
    const evil = writeRawTarGz([{ name: 'EvilApp.app', type: '5' }, { name: 'link', type: '2', linkname: '/etc' }])
    const r = await postTar(port, 'T7', 'symlink.tar.gz', evil, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/link/i)
    expect(leftover()).toEqual([])
  })

  // #8 — gzip bomb → 해제 크기 상한 초과로 400
  it('rejects a gzip bomb that exceeds the unpacked size limit', async () => {
    process.env.TAPFLOW_MAX_UNPACKED_BYTES = '1024'
    // 2MB 의 0 → gzip 시 극히 작지만 해제 시 상한(1KB) 초과.
    const bomb = writeRawTarGz([{ name: 'MyApp.app/big.bin', data: Buffer.alloc(2 * 1024 * 1024, 0) }])
    const r = await postTar(port, 'T8', 'bomb.tar.gz', bomb, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/unpacked size/i)
    expect(leftover()).toEqual([])
  })

  // #9 — 손상된 tar.gz → 400
  it('rejects a corrupt / truncated .tar.gz', async () => {
    const r = await postTar(port, 'T9', 'corrupt.tar.gz', Buffer.from('not a real gzip stream'), cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/corrupt|invalid/i)
    expect(leftover()).toEqual([])
  })

  // #10 — .app 부재 → 400 (구조 오류)
  it('rejects a valid tar.gz that has no .app directory', async () => {
    const noApp = writeRawTarGz([{ name: 'readme.txt', data: Buffer.from('hello') }])
    const r = await postTar(port, 'T10', 'noapp.tar.gz', noApp, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/\.app/i)
    expect(leftover()).toEqual([])
  })

  // #13 — Linux relay parity: lipo unavailable → slice check skipped, upload still succeeds.
  // Real Linux has no lipo (spawnSync → ENOENT, status=null); here we shadow lipo with a
  // failing shim (status≠0). Both hit the same `status !== 0 → null → skip` branch.
  it('stores + extracts metadata when lipo is unavailable (Linux parity)', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-nolipo-'))
    fs.writeFileSync(path.join(shimDir, 'lipo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const origPath = process.env.PATH
    // shim 을 PATH 앞에 두어 실제 lipo 보다 먼저 잡히게 (tar/unzip/plutil 은 origPath 로 계속 resolve).
    process.env.PATH = `${shimDir}:${origPath}`
    try {
      const tarPath = makeAppTarGz(fixtureDir, 'NoLipoApp', XML_PLIST)
      const r = await postTar(port, 'T13', 'NoLipoApp.tar.gz', fs.readFileSync(tarPath), cookie)
      expect(r.status).toBe(201)
      expect(r.body.bundle_id).toBe('com.example.eas')
      expect(r.body.version_name).toBe('2.1.0')
    } finally {
      process.env.PATH = origPath
      fs.rmSync(shimDir, { recursive: true, force: true })
    }
  })
})
