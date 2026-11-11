import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { MAX_JSON_BODY_BYTES } from '../router'

// A request body is bounded before anything else reads it, on the routes a caller with no credential reaches.
// Each of these used to buffer whatever arrived until the request ended, so one anonymous request could take
// the relay's memory.

interface Reply { status: number; body: { error?: string } }

function post(port: number, urlPath: string, headers: http.OutgoingHttpHeaders, body: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function multipart(fields: [string, string][]): { headers: http.OutgoingHttpHeaders; body: Buffer } {
  const boundary = '----tapflowlimits'
  const parts = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  const body = Buffer.from(parts.join('') + `--${boundary}--\r\n`)
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }, body }
}

describe('request body limits on unauthenticated routes', () => {
  let tmpDir: string
  let server: RelayServer
  let port: number

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-body-limits-'))
    initDb(path.join(tmpDir, 'test.db'))
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it.each([
    '/api/v1/auth/login',
    '/api/v1/auth/reset-password',
  ])('%s answers 413 to a JSON body over the limit', async (route) => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(MAX_JSON_BODY_BYTES) }))
    const reply = await post(port, route, { 'Content-Type': 'application/json', 'Content-Length': payload.length }, payload)
    expect(reply.status).toBe(413)
    expect(reply.body.error).toBe('Body too large')
  })

  it('invitation accept answers 413 to more fields than the form has', async () => {
    const fields: [string, string][] = Array.from({ length: 50 }, (_, i) => [`f${i}`, 'x'])
    const { headers, body } = multipart(fields)
    const reply = await post(port, '/api/v1/invitations/accept', headers, body)
    expect(reply.status).toBe(413)
  })

  it('invitation accept answers 413 to a field over the size limit', async () => {
    const { headers, body } = multipart([['token', 't'], ['password', 'x'.repeat(256 * 1024)]])
    const reply = await post(port, '/api/v1/invitations/accept', headers, body)
    expect(reply.status).toBe(413)
  })
})
