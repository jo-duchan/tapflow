import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { hashPat, signJwt } from '../middleware/auth'
import { getJwtSecret } from '../lib/config'
import { WS_AGENT_OWNER_REASON, WS_REJECT_REASON, WS_TOKEN_GONE_REASON } from '../lib/connectionAuth'
import { barrier, waitForMessage, waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'

// An open socket keeps only the access its credential still has. Every remote socket here arrives
// through the tunnel listener, which is remote by construction; the heartbeat is 30 s and never fires
// inside a test, so a close observed after a team or token write is the write's own `onAuthChanged`,
// and a close observed after `runHeartbeat()` is the sweep.
//
// The grace window is set to a minute, so a session that ends within the test ended because the relay
// skipped the hold, not because the hold ran out.
//
// Mutations run against this file, each turning it red:
// - `revalidatePrincipal` always null → every "closes" case.
// - `onAuthChanged()` removed from one handler (update member / delete member / revoke token /
//   invitation accept) → that handler's case: nothing closes within the wait.
// - the `jwtExp` / `expires_at` checks dropped → the two sweep cases.
// - `revokedSockets` taken out of `holdAgentSocket` → the viewer sees `session:agent-away`, not
//   `session:terminated`, in the demotion case.
// - the try/catch around `handleConnection`'s auth block removed → the database-fault case (the throw
//   is uncaught and fails the run); the one around `/uploads` → the upload fault case.
// - the sweep closing unconditionally → the two negative controls.

interface Res { status: number; body: string }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: Buffer | object, contentType?: string): Promise<Res> {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const h: Record<string, string | number> = { ...headers }
  if (payload) {
    h['Content-Type'] = contentType ?? 'application/json'
    h['Content-Length'] = payload.length
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function multipart(boundary: string, fields: Record<string, string>): Buffer {
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
  return Buffer.from(`${parts.join('')}--${boundary}--\r\n`)
}

/** The close code and reason, or null when the socket is still open after `ms`. */
function closedWithin(ws: WebSocket, ms = 2000): Promise<{ code: number; reason: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('close', onClose); resolve(null) }, ms)
    const onClose = (code: number, reason: Buffer) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }) }
    ws.once('close', onClose)
  })
}

/**
 * Still open, proven by a round trip on that socket rather than by waiting: the relay answers
 * `agents:list` on any role, and a close it had already sent would arrive first on the same connection.
 */
function stillOpen(ws: WebSocket): Promise<boolean> {
  return Promise.race([
    barrier(ws).then(() => true),
    new Promise<boolean>((resolve) => ws.once('close', () => resolve(false))),
  ])
}

describe('open sockets are re-validated', () => {
  let tmpDir: string
  let server: RelayServer
  let relayPort: number
  let tunnelPort: number
  const sockets: WebSocket[] = []

  const openDb = () => initDb(path.join(tmpDir, 'test.db'))

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-auth-revalidation-'))
    openDb()
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    const db = getDb()
    db.prepare('DELETE FROM invitations').run()
    db.prepare('DELETE FROM personal_access_tokens').run()
    db.prepare('DELETE FROM users').run()
    for (const [id, role] of [[1, 'Admin'], [2, 'Admin'], [3, 'Admin'], [4, 'Developer']] as const) {
      db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, 'U', ?, 'x')").run(id, `u${id}@test.local`, role)
    }
    server = new RelayServer({ port: 0, tunnelPort: 0, agentGraceMs: 60_000 })
    await server.start()
    relayPort = (server.address() as net.AddressInfo).port
    tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
  })
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await server.stop()
  })

  const cookieFor = (userId: number) => `tapflow_token=${signJwt({ userId, email: `u${userId}@test.local`, role: 'Admin' })}`
  const adminCookie = { Cookie: cookieFor(1) }
  const seedToken = (userId: number, scope: string) => {
    const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
    const r = getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)').run(userId, 't', hashPat(raw), scope)
    return { raw, id: Number(r.lastInsertRowid) }
  }
  const remote = async (headers: Record<string, string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers })
    sockets.push(ws)
    await waitForOpen(ws)
    return ws
  }
  const runHeartbeat = () => (server as unknown as { runHeartbeat: () => void }).runHeartbeat()

  /** A remote agent on `ownerId`'s agent token, and a local viewer holding its session. */
  async function remoteAgentWithViewer(ownerId: number) {
    const token = seedToken(ownerId, 'agent')
    const agent = await remote({ authorization: `Bearer ${token.raw}` })
    agent.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: `revalidate-${ownerId}`, devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
    const registered = await waitForMessage<AgentRegistered>(agent)
    expect(registered.type).toBe('agent:registered')
    const sessionId = registered.registeredSessions[0]!.sessionId
    const viewer = new WebSocket(`ws://127.0.0.1:${relayPort}`)
    sockets.push(viewer)
    await waitForOpen(viewer)
    viewer.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(viewer, 'session:joined')
    return { token, agent, viewer, sessionId }
  }

  it('demoting the owner closes the agent at once, ends its sessions with no grace hold, and refuses the reconnect', async () => {
    const { token, agent, viewer } = await remoteAgentWithViewer(2)
    const closed = closedWithin(agent)
    const r = await request(relayPort, 'PATCH', '/api/v1/team/members/2', adminCookie, { role: 'Developer' })
    expect(r.status).toBe(200)
    expect(await closed).toEqual({ code: 1008, reason: WS_AGENT_OWNER_REASON })
    expect((await waitForType<{ type: string; reason: string }>(viewer, 'session:terminated')).reason).toBe('agent-disconnected')

    const again = new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers: { authorization: `Bearer ${token.raw}` } })
    sockets.push(again)
    expect(await closedWithin(again)).toEqual({ code: 1008, reason: WS_AGENT_OWNER_REASON })
  })

  it('removing the member closes their agent (token cascaded) and their cookie socket', async () => {
    const { agent } = await remoteAgentWithViewer(2)
    const browser = await remote({ cookie: cookieFor(2) })
    const agentClosed = closedWithin(agent)
    const browserClosed = closedWithin(browser)
    expect((await request(relayPort, 'DELETE', '/api/v1/team/members/2', adminCookie)).status).toBe(204)
    expect(await agentClosed).toEqual({ code: 1008, reason: WS_TOKEN_GONE_REASON })
    expect(await browserClosed).toEqual({ code: 1008, reason: WS_REJECT_REASON })
  })

  it('revoking the token closes the socket opened with it', async () => {
    const { token, agent } = await remoteAgentWithViewer(2)
    const closed = closedWithin(agent)
    expect((await request(relayPort, 'DELETE', `/api/v1/tokens/${token.id}`, { Cookie: cookieFor(2) })).status).toBe(204)
    expect(await closed).toEqual({ code: 1008, reason: WS_TOKEN_GONE_REASON })
  })

  it('an invitation accepted for an existing Admin\'s email with another role closes their agent', async () => {
    const { agent } = await remoteAgentWithViewer(2)
    const invite = crypto.randomBytes(16).toString('hex')
    getDb().prepare("INSERT INTO invitations (token, email, role, expires_at) VALUES (?, 'u2@test.local', 'QA', datetime('now', '+1 day'))").run(invite)
    const closed = closedWithin(agent)
    const boundary = 'revalidate-boundary'
    const r = await request(relayPort, 'POST', '/api/v1/invitations/accept', {}, multipart(boundary, { token: invite, password: 'password123' }), `multipart/form-data; boundary=${boundary}`)
    expect(r.status).toBe(200)
    expect(await closed).toEqual({ code: 1008, reason: WS_AGENT_OWNER_REASON })
  })

  it('the heartbeat closes a socket whose token expired since it connected', async () => {
    const token = seedToken(4, 'view')
    const browser = await remote({ authorization: `Bearer ${token.raw}` })
    getDb().prepare("UPDATE personal_access_tokens SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(token.id)
    expect(await stillOpen(browser)).toBe(true)
    const closed = closedWithin(browser)
    runHeartbeat()
    expect(await closed).toEqual({ code: 1008, reason: WS_TOKEN_GONE_REASON })
  })

  it('the heartbeat closes a cookie socket whose session expired since it connected', async () => {
    const exp = Math.floor(Date.now() / 1000) + 1
    const shortLived = jwt.sign({ userId: 4, email: 'u4@test.local', role: 'Developer', exp }, getJwtSecret())
    const browser = await remote({ cookie: `tapflow_token=${shortLived}` })
    while (Math.floor(Date.now() / 1000) < exp) await new Promise((r) => setTimeout(r, 50))
    expect(await stillOpen(browser)).toBe(true)
    const closed = closedWithin(browser)
    runHeartbeat()
    expect(await closed).toEqual({ code: 1008, reason: WS_REJECT_REASON })
  })

  it('demoting a different Admin leaves the agent open', async () => {
    const { agent } = await remoteAgentWithViewer(2)
    expect((await request(relayPort, 'PATCH', '/api/v1/team/members/3', adminCookie, { role: 'Developer' })).status).toBe(200)
    expect(await stillOpen(agent)).toBe(true)
  })

  it("a member's role change that keeps what their socket rests on leaves it open (Developer → QA)", async () => {
    const token = seedToken(4, 'view,builds:write')
    const browser = await remote({ authorization: `Bearer ${token.raw}` })
    expect((await request(relayPort, 'PATCH', '/api/v1/team/members/4', adminCookie, { role: 'QA' })).status).toBe(200)
    expect(await stillOpen(browser)).toBe(true)
  })

  it('a database fault during the handshake closes that socket with 1011 and the relay keeps serving', async () => {
    getDb().close()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers: { cookie: cookieFor(1) } })
      sockets.push(ws)
      expect(await closedWithin(ws)).toEqual({ code: 1011, reason: 'Internal error' })
      expect((await request(relayPort, 'GET', '/api/v1/logs')).status).toBe(200)
    } finally {
      openDb()
    }
  })

  it('a database fault while authorizing /uploads answers 500 and the relay keeps serving', async () => {
    getDb().close()
    try {
      expect((await request(relayPort, 'GET', '/uploads/avatars/x.png', { Cookie: cookieFor(1) })).status).toBe(500)
      expect((await request(relayPort, 'GET', '/api/v1/logs')).status).toBe(200)
    } finally {
      openDb()
    }
  })

  // Agents retry forever on a refusal; one line per token per minute keeps one agent from filling the
  // 500-line buffer, and the line names the actual reason instead of "no credentials" for every refusal.
  // Mutation: the throttle removed → two lines.
  it('logs a refused token once per interval, with the reason', async () => {
    const token = seedToken(4, 'builds:write')
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`, { headers: { authorization: `Bearer ${token.raw}` } })
      sockets.push(ws)
      expect((await closedWithin(ws))?.code).toBe(1008)
    }
    const logs = JSON.parse((await request(relayPort, 'GET', '/api/v1/logs?lines=500')).body) as string[]
    const refusals = logs.filter((l) => l.includes('WS connection rejected'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain("lacks the 'view' scope")
  })

  it('warns at start about agent tokens whose owner is no longer an Admin', async () => {
    seedToken(4, 'agent')
    seedToken(1, 'agent')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = new RelayServer({ port: 0 })
    try {
      await second.start()
      expect(warn.mock.calls.flat().join(' ')).toMatch(/1 agent token\(s\) belong to a member who is no longer an Admin/)
    } finally {
      warn.mockRestore()
      await second.stop()
    }
  })

  it('a local socket is never re-validated', async () => {
    const local = new WebSocket(`ws://127.0.0.1:${relayPort}`)
    sockets.push(local)
    await waitForOpen(local)
    getDb().prepare('DELETE FROM users').run()
    runHeartbeat()
    expect(await stillOpen(local)).toBe(true)
  })
})
