import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'

import type { UIElement } from '../types'
import { signJwt } from '../middleware/auth'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered, BrowserToRelay, RelayToAgent } from '@tapflowio/protocol'

/** What an agent socket actually receives. `RelayToAgent` is only the half the relay
 *  originates or rebuilds; browser commands it forwards verbatim (`app:clear-state`,
 *  `clipboard:*`, `input:*`) arrive unchanged and are declared in `BrowserToRelay`. The
 *  protocol has no single union for this — #557. */
type AgentSocketInbound = RelayToAgent | BrowserToRelay

const ELEMENTS: UIElement[] = [
  {
    role: 'button',
    label: 'Login',
    identifier: 'com.example.app:id/login',
    frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
    enabled: true,
    rawRole: 'android.widget.Button',
  },
]


function makeAuthCookie(): string {
  return `tapflow_token=${signJwt({ userId: 1, email: 'test@example.com', role: 'Admin' })}`
}

function httpGet(
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/v1/sessions/:sessionId/ui-tree', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-uitree-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    // The cookie check reads the users row, so the signed-in user has to exist.
    getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'test@example.com', 'Admin', 'x')").run()
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0, uiTreeTimeoutMs: 300 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
  })

  async function setupAgent(devices = [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }]) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: 'uiTree-1', devices }))
    // Through the shared recorder, not a raw `once`: the recorder queues the frame either way, and
    // consuming it here keeps a later wait on this socket from finding it.
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions[0]!.sessionId
    return { agent, sessionId }
  }

  it('TC1: agent responds ui:tree:response → 200 with the unified element schema', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as AgentSocketInbound
      if (msg.type === 'ui:tree:request') {
        agent.send(JSON.stringify({
          type: 'ui:tree:response',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          elements: ELEMENTS,
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.body.toString())).toEqual({ elements: ELEMENTS })

    agent.close()
  })

  it('TC2: no auth → 401', async () => {
    const { agent, sessionId } = await setupAgent()

    const res = await httpGet(port, `/api/v1/sessions/${sessionId}/ui-tree`)
    expect(res.status).toBe(401)

    agent.close()
  })

  it('TC3: unknown session → 404', async () => {
    const res = await httpGet(
      port,
      '/api/v1/sessions/nonexistent-session-id/ui-tree',
      { Cookie: makeAuthCookie() },
    )
    expect(res.status).toBe(404)
  })

  it('TC4: shutdown device → 409', async () => {
    const { agent, sessionId } = await setupAgent([
      { id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'shutdown' },
    ])

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )
    expect(res.status).toBe(409)

    agent.close()
  })

  it('TC5: agent responds ui:tree:error → 502 with the agent message (explicit, not a silent empty tree)', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as AgentSocketInbound
      if (msg.type === 'ui:tree:request') {
        agent.send(JSON.stringify({
          type: 'ui:tree:error',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          message: 'uiautomator dump produced no XML within 10s',
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(502)
    const body = JSON.parse(res.body.toString()) as { error: string }
    expect(body.error).toContain('uiautomator dump produced no XML')

    agent.close()
  })

  it('TC6: agent that ignores ui:tree:request (older version) → 504 after uiTreeTimeoutMs', async () => {
    const { agent, sessionId } = await setupAgent()

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )
    expect(res.status).toBe(504)

    agent.close()
  })

  it('TC7: agent disconnects mid-request → 502 immediately (not a 504 timeout)', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as AgentSocketInbound
      if (msg.type === 'ui:tree:request') agent.close()
    })

    const start = Date.now()
    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )
    expect(res.status).toBe(502)
    expect(Date.now() - start).toBeLessThan(300)
  })

  it('TC8: mismatched requestId is ignored, matching one resolves', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as AgentSocketInbound
      if (msg.type === 'ui:tree:request') {
        agent.send(JSON.stringify({
          type: 'ui:tree:response',
          sessionId: msg.sessionId,
          requestId: 'wrong-request-id',
          elements: [],
        }))
        agent.send(JSON.stringify({
          type: 'ui:tree:response',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          elements: ELEMENTS,
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/ui-tree`,
      { Cookie: makeAuthCookie() },
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ elements: ELEMENTS })

    agent.close()
  })

  it('TC9: a browser socket cannot spoof ui:tree:response (agent-only message → 1008 close)', async () => {
    const { agent, sessionId } = await setupAgent()

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const closed = new Promise<number>((resolve) => browser.on('close', (code) => resolve(code)))
    browser.send(JSON.stringify({ type: 'ui:tree:response', sessionId, requestId: 'x', elements: [] }))
    expect(await closed).toBe(1008)

    agent.close()
  })

  it('TC10: concurrent requests on the same session resolve independently', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as AgentSocketInbound
      if (msg.type === 'ui:tree:request') {
        agent.send(JSON.stringify({
          type: 'ui:tree:response',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          elements: ELEMENTS,
        }))
      }
    })

    const [res1, res2] = await Promise.all([
      httpGet(port, `/api/v1/sessions/${sessionId}/ui-tree`, { Cookie: makeAuthCookie() }),
      httpGet(port, `/api/v1/sessions/${sessionId}/ui-tree`, { Cookie: makeAuthCookie() }),
    ])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    agent.close()
  })
})
