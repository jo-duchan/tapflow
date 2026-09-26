import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { hashPat, signJwt } from '../middleware/auth'
import { WS_AGENT_OWNER_REASON, WS_REJECT_REASON, WS_SCOPE_REASON } from '../lib/connectionAuth'
import { waitForMessage, waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'

// The tunnel listener exists because a tunnel client — rathole, `tailscale serve` — connects from
// loopback on behalf of someone on the internet or the tailnet. Every test here connects from loopback
// for real, which is exactly the situation: the only thing that differs between the two ports is the
// listener, so a pass on one and a refusal on the other is the property itself.

interface HttpResult { status: number; body: { error?: string; ok?: boolean; initialized?: boolean; canInitialize?: boolean } }

function request(port: number, method: string, urlPath: string, payload?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? '' : JSON.stringify(payload)
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as HttpResult['body'] }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

const closeOf = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

const register = (ws: WebSocket, agentName: string) =>
  ws.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName, devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))

const userCount = () => (getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen({ port: 0, host: '::', ipv6Only: false }, () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ port, host }, () => probe.close(() => resolve(true)))
  })
}

describe('RelayServer tunnel listener', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-tunnel-ingress-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(() => {
    getDb().prepare('DELETE FROM personal_access_tokens').run()
    getDb().prepare('DELETE FROM users').run()
  })

  describe('when a tunnel port is given', () => {
    let server: RelayServer
    let relayPort: number
    let tunnelPort: number

    const start = async (options: { trustedProxies?: string[] } = {}) => {
      server = new RelayServer({ port: 0, tunnelPort: 0, ...options })
      await server.start()
      relayPort = (server.address() as net.AddressInfo).port
      tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
    }

    afterEach(async () => { await server.stop() })

    it('listens on loopback only, on a port of its own', async () => {
      await start()
      const addr = server.tunnelAddress() as net.AddressInfo
      expect(addr.address).toBe('127.0.0.1')
      expect(addr.port).not.toBe(relayPort)
    })

    it('serves the same routes as the relay port', async () => {
      await start()
      const r = await request(tunnelPort, 'GET', '/api/v1/auth/status')
      expect(r.status).toBe(200)
      expect(r.body.initialized).toBe(false)
    })

    it('refuses a socket with no credentials, which the relay port accepts as local', async () => {
      await start()

      const viaTunnel = new WebSocket(`ws://127.0.0.1:${tunnelPort}`)
      expect(await closeOf(viaTunnel)).toBe(1008)

      const direct = new WebSocket(`ws://127.0.0.1:${relayPort}`)
      await waitForOpen(direct)
      register(direct, 'TunnelIngress-local')
      const msg = await waitForMessage<AgentRegistered>(direct)
      expect(msg.type).toBe('agent:registered')
      direct.close()
    })

    it('accepts an agent that presents an agent-scope token', async () => {
      await start()
      const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
      getDb().prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (7101, 'tunnel-agent@test.local', 'Tunnel Agent', 'Admin', 'x')").run()
      getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (7101, ?, ?, ?)').run('tunnel', hashPat(raw), 'agent')

      const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers: { authorization: `Bearer ${raw}` } })
      await waitForOpen(ws)
      register(ws, 'TunnelIngress-token')
      const msg = await waitForMessage<AgentRegistered>(ws)
      expect(msg.type).toBe('agent:registered')
      ws.close()
    })

    it('refuses first-admin setup through the tunnel and allows it on the relay port', async () => {
      await start()
      expect((await request(tunnelPort, 'GET', '/api/v1/auth/status')).body.canInitialize).toBe(false)
      expect((await request(relayPort, 'GET', '/api/v1/auth/status')).body.canInitialize).toBe(true)
      const viaTunnel = await request(tunnelPort, 'POST', '/api/v1/auth/init', { email: 'evil@example.com', password: 'password123' })
      expect(viaTunnel.status).toBe(403)
      expect(userCount()).toBe(0)

      const direct = await request(relayPort, 'POST', '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' })
      expect(direct.status).toBe(201)
    })

    // `/api/v1/logs` is host-only, and the tunnel listener is never the host. Mutations: the route's
    // `isLocal` check dropped, or `resolveRequestClient` passing `viaTunnel: false`, turn this red.
    it('refuses /api/v1/logs through the tunnel and serves it on the relay port', async () => {
      await start()
      expect((await request(tunnelPort, 'GET', '/api/v1/logs')).status).toBe(403)
      expect((await request(relayPort, 'GET', '/api/v1/logs')).status).toBe(200)
    })

    // ── A remote WebSocket on a PAT needs `view` to be a browser ─────────────────────────────────────
    //
    // Mutations: `canView` forced true → the builds:write row; `mayBrowse` forced true → the agent-only
    // row; `mayRegisterAgent` forced true → the demoted `view,agent` row; `touchPat` moved ahead of the
    // reject (or `verifyPat` writing again) → the `last_used_at` assertion; `getAuth` without the row
    // lookup → the removed-member cookie row.

    const seedUser = (id: number, role: string) =>
      getDb().prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, 'U', ?, 'x')").run(id, `u${id}@test.local`, role)
    const seedToken = (userId: number, scope: string) => {
      const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
      const r = getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)').run(userId, 't', hashPat(raw), scope)
      return { raw, id: Number(r.lastInsertRowid) }
    }
    const lastUsed = (id: number) =>
      (getDb().prepare('SELECT last_used_at FROM personal_access_tokens WHERE id = ?').get(id) as { last_used_at: string | null }).last_used_at
    const closeWith = (ws: WebSocket) =>
      new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    const viaTunnelWith = (headers: Record<string, string>) => new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers })
    const agentOnRelayPort = async (name: string) => {
      const agent = new WebSocket(`ws://127.0.0.1:${relayPort}`)
      await waitForOpen(agent)
      register(agent, name)
      const msg = await waitForMessage<AgentRegistered>(agent)
      return { agent, sessionId: msg.registeredSessions[0]!.sessionId }
    }

    it('closes a builds:write-only PAT with the scope reason and leaves its last-used alone', async () => {
      await start()
      seedUser(7201, 'Admin')
      const { raw, id } = seedToken(7201, 'builds:write')
      const ws = viaTunnelWith({ authorization: `Bearer ${raw}` })
      expect(await closeWith(ws)).toEqual({ code: 1008, reason: WS_SCOPE_REASON })
      expect(lastUsed(id)).toBeNull()
    })

    it('lets a view,builds:write PAT join a session, and records the use', async () => {
      await start()
      const { agent, sessionId } = await agentOnRelayPort('Tunnel-view-pat')
      seedUser(7202, 'Viewer')
      const { raw, id } = seedToken(7202, 'view,builds:write')
      const ws = viaTunnelWith({ authorization: `Bearer ${raw}` })
      await waitForOpen(ws)
      ws.send(JSON.stringify({ type: 'session:start', sessionId }))
      expect((await waitForType<{ type: string; sessionId: string }>(ws, 'session:joined')).sessionId).toBe(sessionId)
      expect(lastUsed(id)).not.toBeNull()
      ws.close(); agent.close()
    })

    it('closes an agent-only PAT whose first frame is not a handshake', async () => {
      await start()
      const { agent, sessionId } = await agentOnRelayPort('Tunnel-agent-as-browser')
      seedUser(7203, 'Admin')
      const { raw } = seedToken(7203, 'agent')
      const ws = viaTunnelWith({ authorization: `Bearer ${raw}` })
      await waitForOpen(ws)
      const closed = closeWith(ws)
      ws.send(JSON.stringify({ type: 'session:start', sessionId }))
      expect(await closed).toEqual({ code: 1008, reason: WS_SCOPE_REASON })
      agent.close()
    })

    it("refuses an agent PAT whose owner is no longer an Admin, at the handshake", async () => {
      await start()
      seedUser(7204, 'Developer')
      const { raw, id } = seedToken(7204, 'agent')
      const ws = viaTunnelWith({ authorization: `Bearer ${raw}` })
      expect(await closeWith(ws)).toEqual({ code: 1008, reason: WS_AGENT_OWNER_REASON })
      expect(lastUsed(id)).toBeNull()
    })

    it('lets a demoted owner\'s view,agent PAT browse but not register an agent', async () => {
      await start()
      const { agent, sessionId } = await agentOnRelayPort('Tunnel-view-agent-demoted')
      seedUser(7205, 'QA')
      const { raw } = seedToken(7205, 'view,agent')

      const browser = viaTunnelWith({ authorization: `Bearer ${raw}` })
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')

      const wouldBeAgent = viaTunnelWith({ authorization: `Bearer ${raw}` })
      await waitForOpen(wouldBeAgent)
      const closed = closeWith(wouldBeAgent)
      register(wouldBeAgent, 'Tunnel-demoted-register')
      expect(await closed).toEqual({ code: 1008, reason: WS_AGENT_OWNER_REASON })
      browser.close(); agent.close()
    })

    it("closes a removed member's validly signed cookie with the sign-in reason", async () => {
      await start()
      seedUser(7206, 'Developer')
      const cookie = `tapflow_token=${signJwt({ userId: 7206, email: 'u7206@test.local', role: 'Developer' })}`
      const live = viaTunnelWith({ cookie })
      await waitForOpen(live)
      live.close()

      getDb().prepare('DELETE FROM users WHERE id = 7206').run()
      expect(await closeWith(viaTunnelWith({ cookie }))).toEqual({ code: 1008, reason: WS_REJECT_REASON })
    })

    // With the loopback proxy trusted, a forwarded `::1` resolves to a loopback client — local on the relay
    // port. Arriving through the tunnel, the same request is remote whatever the header says.
    it('keeps a forwarded loopback client remote when the proxy is trusted', async () => {
      await start({ trustedProxies: ['127.0.0.1'] })
      const viaTunnel = await request(tunnelPort, 'POST', '/api/v1/auth/init', { email: 'evil@example.com', password: 'password123' }, { 'X-Forwarded-For': '::1' })
      expect(viaTunnel.status).toBe(403)

      const direct = await request(relayPort, 'POST', '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' }, { 'X-Forwarded-For': '::1' })
      expect(direct.status).toBe(201)
    })
  })

  it('releases both ports on stop()', async () => {
    const server = new RelayServer({ port: 0, tunnelPort: 0 })
    await server.start()
    const relayPort = (server.address() as net.AddressInfo).port
    const tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
    await server.stop()
    expect(await canListen(relayPort, '::')).toBe(true)
    expect(await canListen(tunnelPort, '127.0.0.1')).toBe(true)
  })

  it('opens no tunnel listener unless asked', async () => {
    const server = new RelayServer({ port: 0 })
    await server.start()
    try {
      expect(server.tunnelAddress()).toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('refuses a tunnel port equal to the relay port', () => {
    expect(() => new RelayServer({ port: 4555, tunnelPort: 4555 })).toThrow(/TAPFLOW_TUNNEL_PORT/)
  })

  it('fails to start when the tunnel port is taken, naming the setting, and gives the relay port back', async () => {
    const holder = net.createServer()
    await new Promise<void>((resolve) => holder.listen({ port: 0, host: '127.0.0.1' }, resolve))
    const taken = (holder.address() as net.AddressInfo).port
    const relayPort = await freePort()
    const server = new RelayServer({ port: relayPort, tunnelPort: taken })
    try {
      await expect(server.start()).rejects.toThrow(new RegExp(`${taken}.*TAPFLOW_TUNNEL_PORT`))
      expect(await canListen(relayPort, '::')).toBe(true)
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })
})
