import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'
import { signJwt } from '../middleware/auth'

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic bytes
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]) // JPEG magic bytes

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<RelayMessage>((resolve) => {
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === type) {
        ws.off('message', listener)
        resolve(msg)
      }
    }
    ws.on('message', listener)
  })

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

describe('GET /api/v1/sessions/:sessionId/screenshot', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-screenshot-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0, screenshotTimeoutMs: 300 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
  })

  async function setupAgent(devices = [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }]) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({ type: 'agent:register', devices }))
    const reply = await new Promise<RelayMessage>((resolve) =>
      agent.once('message', (d) => resolve(JSON.parse(d.toString()))),
    )
    const sessionId = reply.registeredSessions![0].sessionId
    return { agent, sessionId }
  }

  it('TC1: 정상 PNG 스크린샷 — agent가 screenshot:done 응답 시 200 image/png', async () => {
    const { agent, sessionId } = await setupAgent()

    // Agent: screenshot:request를 수신하면 즉시 screenshot:done 응답
    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          format: 'png',
          data: FAKE_PNG.toString('base64'),
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body).toEqual(FAKE_PNG)

    agent.close()
  })

  it('TC2: JPEG 포맷 요청 — agent가 jpeg 응답 시 200 image/jpeg', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        expect(msg.format).toBe('jpeg')
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          format: 'jpeg',
          data: FAKE_JPEG.toString('base64'),
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot?format=jpeg`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.body).toEqual(FAKE_JPEG)

    agent.close()
  })

  it('TC3: 인증 없음 → 401', async () => {
    const { agent, sessionId } = await setupAgent()

    const res = await httpGet(port, `/api/v1/sessions/${sessionId}/screenshot`)

    expect(res.status).toBe(401)

    agent.close()
  })

  it('TC4: 존재하지 않는 세션 → 404', async () => {
    const res = await httpGet(
      port,
      '/api/v1/sessions/nonexistent-session-id/screenshot',
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(404)
  })

  it('TC5: agent가 응답 전 연결 끊기면 → 502', async () => {
    const { agent, sessionId } = await setupAgent()

    // agent는 screenshot:request를 받으면 즉시 종료 (응답 없이)
    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') agent.close()
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(502)
  })

  it('TC6: agent 무응답 — screenshotTimeoutMs 초과 시 504', async () => {
    const { agent, sessionId } = await setupAgent()

    // agent는 screenshot:request를 무시함
    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(504)

    agent.close()
  })

  it('TC7: agent가 screenshot:error 응답 → 502 + 에러 메시지', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        agent.send(JSON.stringify({
          type: 'screenshot:error',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          message: 'simulator not booted',
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(502)
    const body = JSON.parse(res.body.toString()) as { error: string }
    expect(body.error).toBe('simulator not booted')

    agent.close()
  })

  it('TC8: deviceStatus가 shutdown인 세션 → 409', async () => {
    const { agent, sessionId } = await setupAgent([
      { id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'shutdown' },
    ])

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(409)

    agent.close()
  })

  it('같은 세션에 동시 요청 두 개 — 각각 독립적으로 응답', async () => {
    const { agent, sessionId } = await setupAgent()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          format: 'png',
          data: FAKE_PNG.toString('base64'),
        }))
      }
    })

    const [res1, res2] = await Promise.all([
      httpGet(port, `/api/v1/sessions/${sessionId}/screenshot`, { Cookie: makeAuthCookie() }),
      httpGet(port, `/api/v1/sessions/${sessionId}/screenshot`, { Cookie: makeAuthCookie() }),
    ])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    agent.close()
  })

  it('screenshot:done에서 requestId 불일치 시 응답 무시', async () => {
    const { agent, sessionId } = await setupAgent()

    // 잘못된 requestId로 응답 먼저 보내고, 올바른 requestId로 나중에 응답
    let correctRequestId: string | undefined
    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        correctRequestId = msg.requestId
        // 잘못된 requestId 먼저
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: 'wrong-request-id',
          format: 'png',
          data: Buffer.from('bad').toString('base64'),
        }))
        // 올바른 requestId
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: correctRequestId,
          format: 'png',
          data: FAKE_PNG.toString('base64'),
        }))
      }
    })

    const res = await httpGet(
      port,
      `/api/v1/sessions/${sessionId}/screenshot`,
      { Cookie: makeAuthCookie() },
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual(FAKE_PNG)

    agent.close()
  })

  it('screenshot:request는 relay가 agent에게만 전달 (browser WS로 브로드캐스트되지 않음)', async () => {
    const { agent, sessionId } = await setupAgent()

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    let browserGotScreenshotRequest = false
    browser.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') browserGotScreenshotRequest = true
    })

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        agent.send(JSON.stringify({
          type: 'screenshot:done',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          format: 'png',
          data: FAKE_PNG.toString('base64'),
        }))
      }
    })

    await httpGet(port, `/api/v1/sessions/${sessionId}/screenshot`, { Cookie: makeAuthCookie() })
    await new Promise<void>((r) => setImmediate(r))

    expect(browserGotScreenshotRequest).toBe(false)

    agent.close()
    browser.close()
  })

  it('TC9: re-register eviction rejects an in-flight screenshot immediately (502, not a 504 timeout)', async () => {
    const devices = [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }]
    const agent1 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent1)
    agent1.send(JSON.stringify({ type: 'agent:register', agentId: 'uuid-1', platform: 'ios', devices }))
    const reply = await waitForType(agent1, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    // On the screenshot request, the same Mac reconnects on a fresh socket → evicts agent1.
    let agent2: WebSocket | undefined
    agent1.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'screenshot:request') {
        agent2 = new WebSocket(`ws://localhost:${port}`)
        agent2.on('open', () =>
          agent2!.send(JSON.stringify({ type: 'agent:register', agentId: 'uuid-1', platform: 'ios', devices })),
        )
      }
    })

    const start = Date.now()
    const res = await httpGet(port, `/api/v1/sessions/${sessionId}/screenshot`, { Cookie: makeAuthCookie() })
    expect(res.status).toBe(502)                 // rejected as Agent disconnected, not the 504 timeout
    expect(Date.now() - start).toBeLessThan(300) // resolved before screenshotTimeoutMs

    agent1.close()
    agent2?.close()
  })
})
