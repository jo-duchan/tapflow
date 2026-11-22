import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { resolveToken } from '@tapflowio/flow-runner'
import { TapflowClient } from '../client.js'
import { startClient } from '../startup.js'
import { registerTools } from '../tools.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// A token rotated while the MCP server runs reaches it by writing the credentials file (T1). The relay closes a
// socket whose token was revoked (1008), and the person writes the new one afterwards — so the client looks again
// on the next tool call, not at the close.

/** A relay: HTTP answers by `rest`, the socket answers `agents:list` and `session:start`, and every handshake's
 *  bearer is recorded. `refuseSocket` closes the socket 1008 right after the upgrade, as the relay does. */
function relayOn(port: number) { return relay({}, port) }

function relay(opts: { rest?: (auth: string | undefined) => number; refuseSocket?: (auth: string | undefined) => boolean; closeCode?: number } = {}, port = 0) {
  const auths: (string | undefined)[] = []
  const sockets: WebSocket[] = []
  const server = http.createServer((req, res) => {
    res.writeHead(opts.rest?.(req.headers.authorization) ?? 200, { 'Content-Type': 'application/json' })
    res.end('{"items":[]}')
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    auths.push(req.headers.authorization)
    sockets.push(ws)
    if (opts.refuseSocket?.(req.headers.authorization)) { ws.close(opts.closeCode ?? 1008, 'Unauthorized'); return }
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>
      if (msg['type'] === 'agents:list') ws.send(JSON.stringify({ type: 'agents:listed', sessions: [] }))
      if (msg['type'] === 'session:start') ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
    })
  })
  return new Promise<{ port: number; auths: typeof auths; sockets: typeof sockets; close: () => Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port: (server.address() as { port: number }).port,
      auths,
      sockets,
      close: async () => {
        for (const s of wss.clients) s.terminate()
        await new Promise<void>((r) => wss.close(() => r()))
        await new Promise<void>((r) => server.close(() => r()))
      },
    }))
  })
}

let dir: string
let file: string
const store = (port: number, token: string) =>
  fs.writeFileSync(file, JSON.stringify({ version: 1, relays: { [`http://localhost:${port}`]: { token } } }), { mode: 0o600 })
const closed = (client: TapflowClient) => new Promise<void>((resolve) => {
  const ws = (client as unknown as { ws: WebSocket | null }).ws
  if (!ws) { resolve(); return }
  ws.once('close', () => resolve())
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-mcp-token-'))
  file = path.join(dir, 'credentials.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('TapflowClient after the relay closes it for its token', () => {
  it('reconnects with the token written after the close, once, and says the sessions it held were released', async () => {
    const r = await relay()
    store(r.port, 'tflw_pat_old')
    const tokens = resolveToken({ relayUrl: `ws://localhost:${r.port}`, env: { TAPFLOW_TOKEN_FILE: file } })
    const client = new TapflowClient(`ws://localhost:${r.port}`, tokens)
    await client.connect()
    await client.connectDevice('s1')
    const gone = closed(client)
    r.sockets[0]!.close(1008, 'token revoked')
    await gone

    // Still the old token: nothing to reconnect with, and no loop.
    await client.reconnectIfClosed()
    expect(r.auths).toEqual(['Bearer tflw_pat_old'])

    store(r.port, 'tflw_pat_new')
    // Two tools at once: the second waits for the one reconnect rather than running on no socket.
    const first = client.reconnectIfClosed()
    await client.reconnectIfClosed()
    expect(await client.listDevices()).toEqual([])
    await first
    expect(r.auths).toEqual(['Bearer tflw_pat_old', 'Bearer tflw_pat_new'])
    expect(client.releasedByReconnect('s1')).toContain('call connect_device again')

    await client.connectDevice('s1')
    expect(client.releasedByReconnect('s1')).toBeUndefined()
    client.disconnect()
    await r.close()
  })

  it('does not read a schema-less tool\'s request context as a session', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>>()
    const server = { registerTool: (name: string, _c: unknown, cb: never) => { handlers.set(name, cb) } } as unknown as McpServer
    const fake = {
      reconnectIfClosed: vi.fn(async () => {}),
      releasedByReconnect: () => 'released',
      listDevices: vi.fn(async () => []),
    } as unknown as TapflowClient
    registerTools(server, fake)
    // A transport with session ids puts its own `sessionId` in the context a schema-less tool receives first.
    const result = await handlers.get('list_devices')!({ sessionId: 'transport-1', signal: new AbortController().signal })
    expect(result.isError).toBeFalsy()
  })

  it('answers a tool aimed at a released session with the reason, before it reaches the relay', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>>()
    const server = { registerTool: (name: string, _c: unknown, cb: never) => { handlers.set(name, cb) } } as unknown as McpServer
    const tap = vi.fn()
    const fake = {
      reconnectIfClosed: vi.fn(async () => {}),
      releasedByReconnect: (id: string) => (id === 's1' ? 'released — call connect_device again' : undefined),
      tap,
    } as unknown as TapflowClient
    registerTools(server, fake)
    const result = await handlers.get('tap')!({ sessionId: 's1', x: 0.5, y: 0.5 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('tap failed: released — call connect_device again')
    expect(tap).not.toHaveBeenCalled()
    expect(fake.reconnectIfClosed).toHaveBeenCalled()
  })
})

describe('TapflowClient after the relay closes it for any other reason (#1213)', () => {
  it('reconnects on the next call after the relay drops the socket, once, and says which close released the sessions', async () => {
    const r = await relay()
    const client = new TapflowClient(`ws://localhost:${r.port}`, 'tflw_pat_x')
    await client.connect()
    await client.connectDevice('s1')
    const gone = closed(client)
    r.sockets[0]!.terminate()
    await gone

    const first = client.reconnectIfClosed()
    await client.reconnectIfClosed()
    await first
    expect(r.auths).toHaveLength(2)
    expect(await client.listDevices()).toEqual([])
    expect(client.releasedByReconnect('s1')).toBe(
      "reconnected to the relay after the connection closed (relay closed 1006), and session s1 went with the old connection: the relay releases a closed connection's sessions — call connect_device again",
    )

    await client.connectDevice('s1')
    expect(client.releasedByReconnect('s1')).toBeUndefined()
    // Open again: nothing to do.
    await client.reconnectIfClosed()
    expect(r.auths).toHaveLength(2)
    client.disconnect()
    await r.close()
  })

  it('reconnects after a relay going away (1001), as one restarting does', async () => {
    const r = await relay()
    const client = new TapflowClient(`ws://localhost:${r.port}`, 'tflw_pat_x')
    await client.connect()
    const gone = closed(client)
    r.sockets[0]!.close(1001, 'going away')
    await gone
    await client.reconnectIfClosed()
    expect(r.auths).toHaveLength(2)
    expect(await client.listDevices()).toEqual([])
    client.disconnect()
    await r.close()
  })

  it('while the relay is down, a call names the failed reconnect; once it is back, the next call reconnects', async () => {
    const r = await relay()
    const port = r.port
    const client = new TapflowClient(`ws://localhost:${port}`, 'tflw_pat_x')
    await client.connect()
    const gone = closed(client)
    await r.close()
    await gone

    await expect(client.reconnectIfClosed()).rejects.toThrow()
    await expect(client.listDevices()).rejects.toThrow(/^Not connected to relay \(relay closed 1006; reconnecting failed: .*ECONNREFUSED/)

    const back = await relayOn(port)
    await client.reconnectIfClosed()
    expect(await client.listDevices()).toEqual([])
    // The failure belonged to that outage: a later close does not repeat it.
    const again = closed(client)
    back.sockets[0]!.terminate()
    await again
    await expect(client.listDevices()).rejects.toThrow(/^Not connected to relay \(relay closed 1006\)$/)
    client.disconnect()
    await back.close()
  })

  it('does not reconnect a client that disconnected itself', async () => {
    const r = await relay()
    const client = new TapflowClient(`ws://localhost:${r.port}`, 'tflw_pat_x')
    await client.connect()
    client.disconnect()
    await client.reconnectIfClosed()
    expect(r.auths).toHaveLength(1)
    await r.close()
  })

  it('gives up on a relay that accepts the connection and never answers the upgrade', async () => {
    const sockets: import('net').Socket[] = []
    const silent = (await import('net')).createServer((s) => { sockets.push(s) })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    const port = (silent.address() as { port: number }).port
    const client = new TapflowClient(`ws://localhost:${port}`, 'tflw_pat_x', { handshakeTimeoutMs: 50 })
    await expect(client.connect()).rejects.toThrow(/timed out/i)
    for (const s of sockets) s.destroy()
    await new Promise<void>((r) => silent.close(() => r()))
  })
})

describe('startClient', () => {
  it('says the relay URL is not one, instead of crashing on it', async () => {
    const lines: string[] = []
    expect(await startClient({ TAPFLOW_RELAY_URL: '4000', TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))).toBeNull()
    expect(lines[0]).toMatch(/^TAPFLOW_RELAY_URL is not a relay URL \("4000"\)/)
  })

  it('starts anyway when the first request fails for a reason that is not the token', async () => {
    // The relay goes away right after the upgrade, as one restarting would — not a 1008.
    const r = await relay({ refuseSocket: () => true, closeCode: 1001 })
    const lines: string[] = []
    const client = await startClient({ TAPFLOW_RELAY_URL: `ws://localhost:${r.port}`, TAPFLOW_TOKEN: 'tflw_pat_x', TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))
    expect(client).not.toBeNull()
    expect(lines.join('\n')).toContain('did not answer the first request')
    expect(lines.join('\n')).not.toContain('did not accept the token')
    client!.disconnect()
    await r.close()
  })

  it('without a token, exits when the relay refuses the socket, naming the relay and where to store one', async () => {
    const r = await relay({ refuseSocket: (auth) => auth === undefined })
    const lines: string[] = []
    const client = await startClient({ TAPFLOW_RELAY_URL: `ws://localhost:${r.port}`, TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))
    expect(client).toBeNull()
    expect(lines.join('\n')).toContain(`no token for the relay at http://localhost:${r.port}: run \`tapflow token set --relay http://localhost:${r.port}\`, or store one in ${file}`)
    await r.close()
  })

  it('without a token, starts when the relay accepts the socket, and says REST will need one', async () => {
    const r = await relay()
    const lines: string[] = []
    const client = await startClient({ TAPFLOW_RELAY_URL: `ws://localhost:${r.port}`, TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))
    expect(client).not.toBeNull()
    expect(lines).toEqual([expect.stringContaining('until then screenshot, query_ui_tree, list_builds, list_runs and get_run are refused')])
    client!.disconnect()
    await r.close()
  })

  it('starts with a token the socket accepts and REST refuses, and says so at start', async () => {
    const r = await relay({ rest: () => 401 })
    const lines: string[] = []
    const client = await startClient({ TAPFLOW_RELAY_URL: `ws://localhost:${r.port}`, TAPFLOW_TOKEN: 'tflw_pat_wrong', TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))
    expect(client).not.toBeNull()
    expect(lines).toEqual([expect.stringContaining('did not accept the token from TAPFLOW_TOKEN')])
    client!.disconnect()
    await r.close()
  })

  it('starts quietly with a token both accept, read from the file', async () => {
    const r = await relay({ rest: (auth) => (auth === 'Bearer tflw_pat_ok' ? 200 : 401) })
    store(r.port, 'tflw_pat_ok')
    const lines: string[] = []
    const client = await startClient({ TAPFLOW_RELAY_URL: `ws://127.0.0.1:${r.port}`, TAPFLOW_TOKEN_FILE: file }, (l) => lines.push(l))
    expect(client).not.toBeNull()
    expect(lines).toEqual([])
    expect(r.auths).toEqual(['Bearer tflw_pat_ok'])
    client!.disconnect()
    await r.close()
  })
})
