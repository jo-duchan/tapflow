import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// node's http client does NOT auto-decode Content-Encoding, so res.body is the
// exact bytes the server sent — perfect for asserting which sibling was served.
function httpGet(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      .on('error', reject)
  })
}

describe('static asset compression', () => {
  let server: RelayServer
  let port: number
  let pub: string
  let dbDir: string

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-comp-db-'))
    initDb(path.join(dbDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true })
  })

  beforeEach(async () => {
    pub = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-pub-'))
    fs.mkdirSync(path.join(pub, 'assets'))
    fs.writeFileSync(path.join(pub, 'assets', 'app.js'), 'RAW_JS')
    fs.writeFileSync(path.join(pub, 'assets', 'app.js.br'), 'BR_BYTES')
    fs.writeFileSync(path.join(pub, 'assets', 'plain.js'), 'PLAIN')
    fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html>')
    server = new RelayServer({ port: 0, publicDir: pub })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(pub, { recursive: true })
  })

  it('serves the brotli sibling when the client accepts br', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br, gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-type']).toContain('javascript')
    expect(res.headers['vary']).toBe('Accept-Encoding')
    expect(res.body).toBe('BR_BYTES')
  })

  it('serves the raw asset (no gzip) when only gzip is accepted', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'gzip' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('RAW_JS')
  })

  it('serves the raw asset when no encoding is accepted', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('RAW_JS')
  })

  it('does not serve brotli when br is explicitly disabled (br;q=0)', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br;q=0, identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('RAW_JS')
  })

  it('sets Vary even when raw is served, since a .br sibling exists', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['vary']).toBe('Accept-Encoding')
  })

  it('serves raw when no precompressed sibling exists', async () => {
    const res = await httpGet(port, '/assets/plain.js', { 'Accept-Encoding': 'br' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('PLAIN')
  })

  it('marks hashed assets immutable', async () => {
    const res = await httpGet(port, '/assets/app.js', {})
    expect(res.headers['cache-control']).toContain('immutable')
  })
})
