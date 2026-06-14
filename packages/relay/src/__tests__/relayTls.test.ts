import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer.js'
import { initDb, closeDb } from '../db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cert = fs.readFileSync(path.join(here, 'fixtures/tls-cert.pem'), 'utf-8')
const key = fs.readFileSync(path.join(here, 'fixtures/tls-key.pem'), 'utf-8')

const portOf = (s: RelayServer) => (s.address() as { port: number }).port
const openWs = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

describe('RelayServer TLS termination', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-tls-'))
    initDb(path.join(tmp, 't.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('tls 옵션이 있으면 https로 서빙하고 wss 핸드셰이크가 된다', async () => {
    const server = new RelayServer({ port: 0, tls: { cert, key } })
    await server.start()
    const port = portOf(server)
    try {
      const status = await new Promise<number>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
            resolve(res.statusCode ?? 0)
            res.resume()
          })
          .on('error', reject)
      })
      expect(status).toBeGreaterThan(0)

      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
      await openWs(ws)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      ws.close()
    } finally {
      await server.stop()
    }
  })

  it('tls 옵션이 없으면 http(ws)로 서빙한다 (기존 동작 보존)', async () => {
    const server = new RelayServer({ port: 0 })
    await server.start()
    const port = portOf(server)
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await openWs(ws)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      ws.close()
    } finally {
      await server.stop()
    }
  })

  it('updateTlsContext는 https 서버에서 throw하지 않는다 (갱신 핫적용)', async () => {
    const server = new RelayServer({ port: 0, tls: { cert, key } })
    await server.start()
    try {
      expect(() => server.updateTlsContext({ cert, key })).not.toThrow()
    } finally {
      await server.stop()
    }
  })
})
