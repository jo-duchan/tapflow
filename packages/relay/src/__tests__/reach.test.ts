import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered, ReachResult, ReachTarget, UiReachRequest } from '@tapflowio/protocol'

// #1125: where a touch meant for an element lands, judged by the session's agent. The engine taps there instead of at
// a frame's centre, which a tab bar can cover — the false pass this route exists to end.

const ROW: ReachTarget = { role: 'button', label: 'Row 13', identifier: 'list.row.13', frame: { x: 0, y: 0.879, width: 1, height: 0.06 } }
const TAB: ReachTarget = { role: 'button', label: 'Hard', frame: { x: 0.4, y: 0.91, width: 0.2, height: 0.06 } }

function post(port: number, urlPath: string, body: unknown, cookie = true): Promise<{ status: number; body: Record<string, unknown> }> {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': data.length }
    if (cookie) headers['Cookie'] = `tapflow_token=${signJwt({ userId: 1, email: 'test@example.com', role: 'Admin' })}`
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

describe('POST /api/v1/sessions/:sessionId/reach', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-reach-test-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'test@example.com', 'Admin', 'x')").run()
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })
  beforeEach(async () => {
    server = new RelayServer({ port: 0, uiTreeTimeoutMs: 300 })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  async function agentWith(capabilities: string[], name = 'reach-1') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name, capabilities,
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const sessionId = (await waitForType<AgentRegistered>(agent, 'agent:registered')).registeredSessions[0]!.sessionId
    return { agent, sessionId }
  }

  it('asks the agent and answers its results, in order', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    const answer: ReachResult[] = [
      { state: 'reachable', point: [0.1, 0.885], atCentre: false, frame: ROW.frame },
      { state: 'reachable', point: [0.5, 0.94], atCentre: true, frame: TAB.frame },
    ]
    const asked = waitForType<UiReachRequest>(agent, 'ui:reach:request')
    const res = post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW, TAB] })
    const req = await asked
    expect(req.targets).toEqual([ROW, TAB])
    agent.send(JSON.stringify({ type: 'ui:reach:response', sessionId, requestId: req.requestId, results: answer }))
    expect(await res).toEqual({ status: 200, body: { results: answer } })
    agent.close()
  })

  // An older Mac must not fail a flow: the caller taps the centre and says the tap was not checked.
  it('answers every target unknown for an agent without reach, and asks nothing', async () => {
    const { agent, sessionId } = await agentWith([])
    let asked = false
    agent.on('message', (d) => { if (String(d).includes('ui:reach:request')) asked = true })
    const res = await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW, TAB] })
    expect(res.status).toBe(200)
    expect((res.body['results'] as ReachResult[]).map((r) => r.state)).toEqual(['unknown', 'unknown'])
    expect(asked).toBe(false)
    agent.close()
  })

  it('reads an answer for the wrong number of targets, or an unreadable result, as unknown', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    agent.on('message', (d) => {
      const m = JSON.parse(String(d)) as UiReachRequest
      if (m.type !== 'ui:reach:request') return
      const results = m.targets.length === 2 ? [{ state: 'offscreen' }] : [{ state: 'teleported' }]
      agent.send(JSON.stringify({ type: 'ui:reach:response', sessionId, requestId: m.requestId, results }))
    })
    const short = await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW, TAB] })
    expect((short.body['results'] as ReachResult[]).map((r) => r.state)).toEqual(['unknown', 'unknown'])
    const odd = await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW] })
    expect((odd.body['results'] as ReachResult[])[0]).toMatchObject({ state: 'unknown' })
    agent.close()
  })

  it('takes the answer only from the session\'s own agent', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    const other = await agentWith(['reach'], 'reach-2')
    const asked = waitForType<UiReachRequest>(agent, 'ui:reach:request')
    const res = post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW] })
    const req = await asked
    other.agent.send(JSON.stringify({ type: 'ui:reach:response', sessionId, requestId: req.requestId, results: [{ state: 'reachable', point: [0.5, 0.5], atCentre: true, frame: ROW.frame }] }))
    await new Promise((r) => setTimeout(r, 50))
    agent.send(JSON.stringify({ type: 'ui:reach:response', sessionId, requestId: req.requestId, results: [{ state: 'occluded', by: 'Hard' }] }))
    expect((await res).body).toEqual({ results: [{ state: 'occluded', by: 'Hard' }] })
    agent.close(); other.agent.close()
  })

  it.each([
    [{}, 'targets must be a non-empty array'],
    [{ targets: [{ ...ROW, role: 'widget' }] }, 'targets[0].role is not a UI element role'],
    [{ targets: [{ ...ROW, frame: { x: 0, y: 0 } }] }, 'targets[0].frame must have numeric x, y, width and height'],
  ])('refuses a malformed body (%j)', async (body, error) => {
    const { agent, sessionId } = await agentWith(['reach'])
    expect(await post(port, `/api/v1/sessions/${sessionId}/reach`, body)).toEqual({ status: 400, body: { error } })
    agent.close()
  })

  it('needs view access', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    expect((await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW] }, false)).status).toBe(401)
    agent.close()
  })

  // Review of #1125: a flat deadline gave up on a large batch the agent was still answering (iOS judges ~130 ms each).
  it('waits longer for more targets', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    agent.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as UiReachRequest
      if (m.type !== 'ui:reach:request') return
      // Past the 300 ms tree deadline, inside 300 ms + 0.3 s for each of the four targets.
      setTimeout(() => agent.send(JSON.stringify({ type: 'ui:reach:response', sessionId, requestId: m.requestId, results: m.targets.map(() => ({ state: 'offscreen' })) })), 700)
    })
    const res = await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW, TAB, ROW, TAB] })
    expect(res.status).toBe(200)
    agent.close()
  })

  it('times out when the agent never answers', async () => {
    const { agent, sessionId } = await agentWith(['reach'])
    expect((await post(port, `/api/v1/sessions/${sessionId}/reach`, { targets: [ROW] })).status).toBe(504)
    agent.close()
  })
})
