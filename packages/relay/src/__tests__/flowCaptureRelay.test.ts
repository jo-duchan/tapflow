import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt, hashPat } from '../middleware/auth'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'
import type { CaptureEntry, CaptureSnapshot } from '../capture/CaptureStore'

/**
 * **Flow Capture's wiring through the relay** (#1125). `captureStore.test.ts` holds the rules; this holds that the relay
 * feeds them — which inputs reach the record, which joins and shutdowns end it, and who may read it back.
 *
 * Browsers connect through the tunnel port with a session cookie, as in `sessionResumeRelay.test.ts`: a loopback socket
 * on the relay port is anonymous, and an anonymous holder is never captured.
 */
const VIEW_PAT = 'tflw_pat_capture_view'
/** Short, so the countdown can run out inside a test; a reload re-joins well inside it. */
const IDLE = 1_500

describe('Flow Capture through the relay', () => {
  let tmpDir: string
  let server: RelayServer
  let relayPort: number
  let tunnelPort: number
  let agent: WebSocket
  let sessionId: string
  let seq = 0
  const open: WebSocket[] = []

  const cookieFor = (userId: number) => `tapflow_token=${signJwt({ userId, email: `u${userId}@test.local`, role: 'Admin' })}`

  async function browser(userId: number, tab = `t${userId}-${seq}`): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/?client=${tab}`, { headers: { cookie: cookieFor(userId) } })
    open.push(ws)
    await waitForOpen(ws)
    return ws
  }

  async function join(ws: WebSocket, clientKind: string = 'dashboard'): Promise<void> {
    ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind }))
    await waitForType(ws, 'session:joined')
  }

  /** One tap, and the agent's answer to it — which the relay forwards, so waiting on it orders everything before it. */
  async function tap(ws: WebSocket, requestId: string): Promise<void> {
    ws.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.5 } }))
    ws.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId, payload: { x: 0.5, y: 0.5 } }))
    const end = await waitForType<{ type: string; requestId: string }>(agent, 'input:touch:end')
    agent.send(JSON.stringify({ type: 'input:done', sessionId, requestId: end.requestId }))
    await waitForType(ws, 'input:done')
  }

  const api = (method: string, route: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`http://127.0.0.1:${tunnelPort}/api/v1${route}`, {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const snapshot = async (userId: number): Promise<CaptureSnapshot | null> => {
    const r = await api('POST', `/sessions/${sessionId}/capture/snapshot`, { cookie: cookieFor(userId) })
    return r.status === 200 ? (await r.json() as CaptureSnapshot) : null
  }
  const kinds = (entries: CaptureEntry[]) => entries.map((e) => (e.kind === 'input' ? e.msg.type : e.kind))

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-flow-capture-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'u1@test.local', 'QA', 'x')").run()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (2, 'u2@test.local', 'Admin', 'x')").run()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (3, 'u3@test.local', 'Viewer', 'x')").run()
    db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (1, ?, ?, ?)')
      .run('mcp', hashPat(VIEW_PAT), 'view')
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    seq++
    getDb().prepare('UPDATE users SET flow_capture = 1').run()
    server = new RelayServer({ port: 0, tunnelPort: 0, idleTimeoutMs: IDLE, agentGraceMs: 5_000 })
    await server.start()
    relayPort = (server.address() as net.AddressInfo).port
    tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
    agent = new WebSocket(`ws://localhost:${relayPort}`)
    open.push(agent)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: `capture-agent-${seq}`,
      devices: [{ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }],
    }))
    sessionId = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions[0]!.sessionId
  })

  afterEach(async () => {
    for (const ws of open.splice(0)) ws.terminate()
    await server.stop()
  })

  it('records a dashboard holder\'s inputs and the agent\'s answers', async () => {
    const alice = await browser(1)
    await join(alice)
    await tap(alice, 'r1')
    expect(kinds((await snapshot(1))!.entries)).toEqual(['input:touch:start', 'input:touch:end', 'ack'])
  })

  it('keeps it across a reload by the same person', async () => {
    const tab = await browser(1, 'first')
    await join(tab)
    await tap(tab, 'r1')
    tab.terminate()
    const again = await browser(1, 'second')
    await join(again)
    expect((await snapshot(1))!.entries).toHaveLength(3)
  })

  it('ends it when the person\'s own flow run borrows the device', async () => {
    const tab = await browser(1, 'tab')
    await join(tab)
    await tap(tab, 'r1')
    tab.terminate()
    await join(await browser(1, 'runner'), 'flow-runner')
    expect(await snapshot(1)).toBeNull()
  })

  it('ends it when the device is shut down from the dashboard, without waiting for the countdown', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    tab.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    expect(await snapshot(1)).toBeNull()
  })

  it('ends it on a cold boot and keeps it on a warm one', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1', cold: false } }))
    await waitForType(tab, 'device:ready')
    expect(await snapshot(1)).not.toBeNull()
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1', cold: true } }))
    await waitForType(tab, 'device:ready')
    expect(await snapshot(1)).toBeNull()
  })

  /** The relay acts when it acts: ask until the answer comes, rather than guessing a delay. */
  async function untilGone(userId: number, ms = 1_000): Promise<CaptureSnapshot | null> {
    const end = Date.now() + ms
    let got = await snapshot(userId)
    while (got !== null && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50))
      got = await snapshot(userId)
    }
    return got
  }

  it('ends it when nobody comes back before the countdown runs out', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    tab.terminate()
    await waitForType(agent, 'device:shutdown')
    expect(await snapshot(1)).toBeNull()
  }, IDLE + 5_000)

  it('ends it when the session ends', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    tab.send(JSON.stringify({ type: 'session:end', sessionId }))
    expect(await untilGone(1)).toBeNull()
  })

  it('records a refused input as refused', async () => {
    const tab = await browser(1)
    await join(tab)
    tab.send(JSON.stringify({ type: 'input:key', sessionId, requestId: 'k1', payload: { code: 'KeyA', modifiers: 0 } }))
    const key = await waitForType<{ type: string; requestId: string }>(agent, 'input:key')
    agent.send(JSON.stringify({ type: 'input:error', sessionId, requestId: key.requestId, reason: 'failed', message: 'no' }))
    await waitForType(tab, 'input:error')
    expect((await snapshot(1))!.entries.at(-1)).toMatchObject({ kind: 'ack', requestId: 'k1', ok: false })
  })

  it('reads back only with the owner\'s cookie: not another person\'s, not the owner\'s own PAT', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    expect(await snapshot(2)).toBeNull()
    const pat = await api('POST', `/sessions/${sessionId}/capture/snapshot`, { authorization: `Bearer ${VIEW_PAT}` })
    expect(pat.status).toBe(401)
    expect((await api('PUT', `/sessions/${sessionId}/capture/pause`, { authorization: `Bearer ${VIEW_PAT}` })).status).toBe(401)
    expect(await snapshot(1)).not.toBeNull()
  })

  it('records nothing while the owner holds the replay pause', async () => {
    const tab = await browser(1)
    await join(tab)
    await tap(tab, 'r1')
    const taken = (await snapshot(1))!
    const paused = await api('PUT', `/sessions/${sessionId}/capture/pause`, { cookie: cookieFor(1) })
    expect(paused.status).toBe(200)
    await tap(tab, 'r2')
    expect((await api('DELETE', `/sessions/${sessionId}/capture/pause`, { cookie: cookieFor(1) })).status).toBe(200)
    const got = await api('GET', `/sessions/${sessionId}/capture/snapshot`, { cookie: cookieFor(1) })
    expect(await got.json()).toEqual(taken)
    await tap(tab, 'r3')
    expect((await snapshot(1))!.entries).toHaveLength(6)
  })

  it('lets every role, a Viewer included, turn it off — which ends what was recorded', async () => {
    const tab = await browser(3)
    await join(tab)
    await tap(tab, 'r1')
    expect(await snapshot(3)).not.toBeNull()
    const off = await api('PATCH', '/me/preferences', { cookie: cookieFor(3) }, { flowCapture: false })
    expect(off.status).toBe(200)
    expect(await snapshot(3)).toBeNull()
    await tap(tab, 'r2')
    expect(await snapshot(3)).toBeNull()
    const me = await api('GET', '/auth/me', { cookie: cookieFor(3) })
    expect(await me.json()).toMatchObject({ flowCapture: false })
    // Back on takes effect on the next input, not the next join.
    await api('PATCH', '/me/preferences', { cookie: cookieFor(3) }, { flowCapture: true })
    await tap(tab, 'r3')
    expect((await snapshot(3))!.entries).toHaveLength(3)
  })

  it('refuses a setting that is not a boolean, and a PAT', async () => {
    expect((await api('PATCH', '/me/preferences', { cookie: cookieFor(1) }, { flowCapture: 'no' })).status).toBe(400)
    expect((await api('PATCH', '/me/preferences', { authorization: `Bearer ${VIEW_PAT}` }, { flowCapture: false })).status).toBe(401)
  })
})
