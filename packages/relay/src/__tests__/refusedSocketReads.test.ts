import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// A socket the relay refuses is not read any further. `ws.close()` waits up to 30 s for the peer's close frame
// and keeps reading meanwhile, buffering one message up to `maxPayload` (100 MiB by default), so a client with
// no credential that never answered the close could make the relay hold that much per connection.

const SENT = 64 * 1024 * 1024

/** Opens a WebSocket on `port` with no credential, by hand, so the client can ignore the close and keep sending. */
function upgradeWithoutCredential(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.once('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) resolve(socket)
      else reject(new Error(`upgrade refused: ${chunk.toString('latin1').split('\r\n')[0]}`))
    })
    socket.on('error', reject)
  })
}

/** A masked binary frame header announcing `length` bytes, as a client must send. */
function frameHeader(length: number): Buffer {
  const header = Buffer.alloc(14)
  header[0] = 0x82
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return header // the 4-byte mask is zero, so the payload goes unchanged
}

describe('a refused WebSocket', () => {
  let tmpDir: string
  let server: RelayServer
  let tunnelPort: number

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-refused-reads-'))
    initDb(path.join(tmpDir, 'test.db'))
    // The tunnel port: nothing arriving there counts as local, so a socket with no credential is refused.
    server = new RelayServer({ port: 0, tunnelPort: 0 })
    await server.start()
    tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('is not read after the relay refuses it', async () => {
    const socket = await upgradeWithoutCredential(tunnelPort)
    socket.on('error', () => {})
    socket.write(frameHeader(SENT))
    socket.write(Buffer.alloc(SENT))
    await new Promise((r) => setTimeout(r, 1_000))
    // Read by the relay, the whole payload would have left the client by now. Unread, the kernel's buffers take
    // a few MiB at most and the rest waits on the client.
    expect(socket.writableLength).toBeGreaterThan(SENT / 2)
    socket.destroy()
  })

  it('still tells an ordinary client why, and lets it go within seconds', async () => {
    const started = Date.now()
    const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`)
      ws.on('close', (c, r) => resolve({ code: c, reason: r.toString() }))
      ws.on('error', reject)
    })
    expect(code).toBe(1008)
    expect(reason).not.toBe('')
    // Unread, the client's close reply would otherwise keep both ends waiting for ws's 30 s close timer.
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
