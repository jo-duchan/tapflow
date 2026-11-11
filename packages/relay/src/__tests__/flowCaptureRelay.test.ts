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

  describe('the field typed into (#1135) and the keyboard language (#1134)', () => {
    /** An agent that answers field reads and takes keyboard resets; the session under test becomes its device. */
    async function capableAgent(): Promise<WebSocket> {
      const ws = new WebSocket(`ws://localhost:${relayPort}`)
      open.push(ws)
      await waitForOpen(ws)
      ws.send(JSON.stringify({
        type: 'agent:register', platform: 'ios', agentName: `field-agent-${seq}`,
        capabilities: ['field-value', 'keyboard-reset', 'keyboard-state', 'keyboard-set', 'run-reset'],
        devices: [{ id: 'dev-2', name: 'iPhone 17', platform: 'ios', status: 'booted' }],
      }))
      sessionId = (await waitForType<AgentRegistered>(ws, 'agent:registered')).registeredSessions[0]!.sessionId
      return ws
    }
    const field = { identifier: 'form.email', placeholder: 'Email', frame: { x: 0, y: 0, width: 1, height: 1 }, secure: false, value: '안녕' }

    it('asks the session\'s agent which field a person typed into, and keeps only its own agent\'s answer', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'input:key', sessionId, requestId: 'k1', payload: { code: 'KeyD', modifiers: 0 } }))
      const ask = await waitForType<{ type: string; requestId: string }>(fieldAgent, 'ui:field:request')
      // Another agent naming the same request must not write into a person's capture.
      agent.send(JSON.stringify({ type: 'ui:field:response', sessionId, requestId: ask.requestId, field: { ...field, value: 'forged' } }))
      fieldAgent.send(JSON.stringify({ type: 'ui:field:response', sessionId, requestId: ask.requestId, field }))
      // Taking the snapshot reads the field still being typed in, and waits for the answer.
      const taken = snapshot(1)
      const last = await waitForType<{ type: string; requestId: string }>(fieldAgent, 'ui:field:request')
      fieldAgent.send(JSON.stringify({ type: 'ui:field:response', sessionId, requestId: last.requestId, field }))
      const reads = (await taken)!.entries.flatMap((e) => (e.kind === 'field' ? [e] : []))
      expect(reads.map((r) => [r.phase, r.field?.value])).toEqual([['focus', '안녕'], ['value', '안녕']])
    })

    it('tells the agent to warm its tree runner when a recorded person boots, on an agent that reads fields only', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-2' } }))
      const boot = await waitForType<{ type: string; payload: { recorded?: boolean } }>(fieldAgent, 'device:boot')
      expect(boot.payload.recorded).toBe(true)
    })

    it('does not warm it for a person who turned capturing off', async () => {
      getDb().prepare('UPDATE users SET flow_capture = 0 WHERE id = 1').run()
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-2' } }))
      const boot = await waitForType<{ type: string; payload: { recorded?: boolean } }>(fieldAgent, 'device:boot')
      expect(boot.payload.recorded).toBe(false)
    })

    it('does not warm it on an agent that cannot read fields: the runner would cost memory for nothing', async () => {
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
      const boot = await waitForType<{ type: string; payload: { recorded?: boolean } }>(agent, 'device:boot')
      expect(boot.payload.recorded).toBe(false)
    })

    it('asks nothing of an agent that cannot answer', async () => {
      const alice = await browser(1)
      await join(alice)
      let asked = false
      agent.on('message', (d) => { if (String(d).includes('ui:field:request')) asked = true })
      alice.send(JSON.stringify({ type: 'input:key', sessionId, requestId: 'k1', payload: { code: 'KeyD', modifiers: 0 } }))
      await new Promise((r) => setTimeout(r, 800))
      expect(asked).toBe(false)
    })

    it('resets the keyboard with the boot of a different person, not when the same one comes back', async () => {
      const fieldAgent = await capableAgent()
      const seen: string[] = []
      fieldAgent.on('message', (d) => { const m = JSON.parse(String(d)) as { type: string }; if (m.type === 'device:keyboard-reset' || m.type === 'device:boot') seen.push(m.type) })
      const take = async (userId: number, tab: string) => {
        const ws = await browser(userId, tab)
        await join(ws)
        ws.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: `b-${tab}`, payload: { deviceId: 'dev-2' } }))
        await waitForType(fieldAgent, 'device:boot')
        ws.terminate()
      }
      await take(1, 'a')
      await take(1, 'b')
      expect(seen).toEqual(['device:boot', 'device:boot'])
      // Owed from the join, sent ahead of the boot: an agent away at the join still hears it with the boot.
      await take(2, 'c')
      expect(seen.slice(2)).toEqual(['device:keyboard-reset', 'device:boot'])
      await take(2, 'd')
      expect(seen.slice(4)).toEqual(['device:boot'])
    })

    it('reads the keyboard after a person\'s tap and keeps only its own agent\'s answer', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.8 } }))
      alice.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 't1', payload: { x: 0.5, y: 0.8 } }))
      const ask = await waitForType<{ type: string; requestId: string }>(fieldAgent, 'ui:keyboard:request')
      const keyboard = { shown: true, rect: { x: 0, y: 0.6, width: 1, height: 0.4 } }
      agent.send(JSON.stringify({ type: 'ui:keyboard:response', sessionId, requestId: ask.requestId, keyboard: { shown: false } }))
      fieldAgent.send(JSON.stringify({ type: 'ui:keyboard:response', sessionId, requestId: ask.requestId, keyboard }))
      await new Promise((r) => setTimeout(r, 50))
      const reads = (await snapshot(1))!.entries.flatMap((e) => (e.kind === 'keyboard' ? [e] : []))
      expect(reads.map((r) => r.keyboard)).toEqual([keyboard])
    })

    // The relay hands the agent's `app:*-done` to the capture: a unit test calling the store directly passed while the
    // relay never did, and the read after an install was never asked.
    it('reads the keyboard again once the agent says a clear-state is done', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      let asked = 0
      fieldAgent.on('message', (d) => {
        const m = JSON.parse(String(d)) as { type: string; requestId: string }
        if (m.type !== 'ui:keyboard:request') return
        asked++
        fieldAgent.send(JSON.stringify({ type: 'ui:keyboard:response', sessionId, requestId: m.requestId, keyboard: { shown: false, onHome: false } }))
      })
      alice.send(JSON.stringify({ type: 'app:clear-state', sessionId, requestId: 'c1', payload: { bundleId: 'com.example.app' } }))
      await waitForType(fieldAgent, 'app:clear-state')
      // The read the command started, and the one that settles it; then nothing until something asks again.
      await new Promise((r) => setTimeout(r, 1200))
      const before = asked
      expect(before).toBeGreaterThan(0)
      await new Promise((r) => setTimeout(r, 600))
      expect(asked).toBe(before)
      fieldAgent.send(JSON.stringify({ type: 'app:clear-state-done', sessionId, requestId: 'c1' }))
      await new Promise((r) => setTimeout(r, 200))
      expect(asked).toBeGreaterThan(before)
    })

    it('forwards a replay\'s keyboard language to the agent and its answer back', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'device:keyboard-set', sessionId, requestId: 'ks1', payload: { keyboard: 'ko_KR@sw=Korean;hw=Automatic' } }))
      const set = await waitForType<{ type: string; requestId: string; payload: { keyboard?: string } }>(fieldAgent, 'device:keyboard-set')
      expect(set).toMatchObject({ requestId: 'ks1', payload: { keyboard: 'ko_KR@sw=Korean;hw=Automatic' } })
      fieldAgent.send(JSON.stringify({ type: 'device:keyboard-set-done', sessionId, requestId: 'ks1' }))
      expect(await waitForType(alice, 'device:keyboard-set-done')).toMatchObject({ requestId: 'ks1' })
      // Not a person's input: the capture keeps none of it.
      expect(kinds((await snapshot(1))?.entries ?? [])).not.toContain('device:keyboard-set')
    })

    it('answers unsupported itself for an agent that cannot set the keyboard', async () => {
      const alice = await browser(1)
      await join(alice)
      let forwarded = false
      agent.on('message', (d) => { if (String(d).includes('device:keyboard-set')) forwarded = true })
      alice.send(JSON.stringify({ type: 'device:keyboard-set', sessionId, requestId: 'ks2', payload: {} }))
      expect(await waitForType(alice, 'device:keyboard-set-error')).toMatchObject({ requestId: 'ks2', reason: 'unsupported' })
      expect(forwarded).toBe(false)
    })

    // #1139: Match and Verify start from a run's reset on the device the person holds.
    it('forwards a run reset to an agent that does it, and its report back', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'device:run-reset', sessionId, requestId: 'rr1', payload: { apps: ['com.app'] } }))
      expect(await waitForType(fieldAgent, 'device:run-reset')).toMatchObject({ requestId: 'rr1', payload: { apps: ['com.app'] } })
      const report = { done: ['app-reinstall', 'keychain'], failed: ['location'] }
      fieldAgent.send(JSON.stringify({ type: 'device:run-reset-done', sessionId, requestId: 'rr1', report }))
      expect(await waitForType(alice, 'device:run-reset-done')).toMatchObject({ requestId: 'rr1', report })
      expect(kinds((await snapshot(1))?.entries ?? [])).not.toContain('device:run-reset')
    })

    // iOS uninstalls and installs the app again; one whose install fails is gone, so the relay's record must not answer
    // the next install as already done (pre-PR review of #1139).
    it('forgets the build it recorded as installed when a run reset resets an app', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      const session = (server as unknown as { sessions: { get(id: string): { installed?: unknown } } }).sessions.get(sessionId)!
      session.installed = { buildId: 1, path: '/x.app' }
      alice.send(JSON.stringify({ type: 'device:run-reset', sessionId, requestId: 'rr3', payload: { apps: [] } }))
      await waitForType(fieldAgent, 'device:run-reset')
      expect(session.installed).toBeDefined()
      alice.send(JSON.stringify({ type: 'device:run-reset', sessionId, requestId: 'rr4', payload: { apps: ['com.app'] } }))
      await waitForType(fieldAgent, 'device:run-reset')
      expect(session.installed).toBeUndefined()
    })

    it('answers unsupported itself for an agent that cannot reset a held device', async () => {
      const alice = await browser(1)
      await join(alice)
      let forwarded = false
      agent.on('message', (d) => { if (String(d).includes('device:run-reset')) forwarded = true })
      alice.send(JSON.stringify({ type: 'device:run-reset', sessionId, requestId: 'rr2', payload: { apps: [] } }))
      expect(await waitForType(alice, 'device:run-reset-error')).toMatchObject({ requestId: 'rr2', reason: 'unsupported' })
      expect(forwarded).toBe(false)
    })

    it('keeps no value of a secure field, whatever the agent sent', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      alice.send(JSON.stringify({ type: 'input:key', sessionId, requestId: 'k1', payload: { code: 'KeyD', modifiers: 0 } }))
      const ask = await waitForType<{ type: string; requestId: string }>(fieldAgent, 'ui:field:request')
      fieldAgent.send(JSON.stringify({ type: 'ui:field:response', sessionId, requestId: ask.requestId, field: { ...field, secure: true, value: 'hunter2' }, reason: 'secure' }))
      await new Promise((r) => setTimeout(r, 100))
      const reads = (await snapshot(1))!.entries.flatMap((e) => (e.kind === 'field' ? [e] : []))
      expect(reads[0]!.field).toMatchObject({ secure: true })
      expect(reads[0]!.field).not.toHaveProperty('value')
    })

    it('reads no field and warms no runner on a Mac over its memory line', async () => {
      const fieldAgent = await capableAgent()
      const alice = await browser(1)
      await join(alice)
      let asked = 0
      fieldAgent.on('message', (d) => { if (String(d).includes('ui:field:request')) asked++ })
      fieldAgent.send(JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 0, memUsedMB: 99, memTotalMB: 100, slotsAvailable: 1, slotsTotal: 1, reportedAt: Date.now() } }))
      await new Promise((r) => setTimeout(r, 100))
      alice.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-2' } }))
      expect((await waitForType<{ type: string; payload: { recorded?: boolean } }>(fieldAgent, 'device:boot')).payload.recorded).toBe(false)
      alice.send(JSON.stringify({ type: 'input:key', sessionId, requestId: 'k1', payload: { code: 'KeyD', modifiers: 0 } }))
      await new Promise((r) => setTimeout(r, 900))
      expect(asked).toBe(0)
    })
  })

  it('records a dashboard holder\'s inputs and the agent\'s answers', async () => {
    const alice = await browser(1)
    await join(alice)
    await tap(alice, 'r1')
    expect(kinds((await snapshot(1))!.entries)).toEqual(['input:touch:start', 'input:touch:end', 'ack'])
  })

  // 1b-3b: the screen each step began on, sent by the person's own dashboard after the input.
  describe('thumbnails', () => {
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
    const put = (userId: number, requestId: string, body: Buffer = JPEG) =>
      fetch(`http://127.0.0.1:${tunnelPort}/api/v1/sessions/${sessionId}/capture/thumbnails/${requestId}`, {
        method: 'PUT', headers: { cookie: cookieFor(userId), 'content-type': 'image/jpeg' }, body: new Uint8Array(body),
      })
    const get = (userId: number, requestId: string) =>
      fetch(`http://127.0.0.1:${tunnelPort}/api/v1/sessions/${sessionId}/capture/snapshot/thumbnails/${requestId}`, { headers: { cookie: cookieFor(userId) } })

    // A typed text, not a touch: a touch keeps a picture only when the keyboard reads place it, and this agent has none.
    async function typeIt(ws: WebSocket, requestId: string): Promise<void> {
      ws.send(JSON.stringify({ type: 'input:type', sessionId, requestId, payload: { text: 'x' } }))
      await waitForType(agent, 'input:type')
    }

    it('keeps one for an input the capture holds, lists it in the snapshot and serves it to its owner', async () => {
      const alice = await browser(1)
      await join(alice)
      await typeIt(alice, 'r1')
      expect((await put(1, 'r1')).status).toBe(201)
      expect((await snapshot(1))!.thumbnails).toEqual(['r1'])
      const res = await get(1, 'r1')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG)
    })

    it('answers anyone else as if there were none', async () => {
      const alice = await browser(1)
      await join(alice)
      await typeIt(alice, 'r1')
      expect((await put(2, 'r1')).status).toBe(404)
      expect((await put(1, 'r1')).status).toBe(201)
      await snapshot(1)
      expect((await get(2, 'r1')).status).toBe(404)
    })

    it('refuses an input not recorded yet, one already kept, and anything not a small JPEG', async () => {
      const alice = await browser(1)
      await join(alice)
      await typeIt(alice, 'r1')
      expect((await put(1, 'not-an-input')).status).toBe(409)
      expect((await put(1, 'r1', Buffer.from('<svg/>'))).status).toBe(415)
      expect((await put(1, 'r1', Buffer.concat([JPEG, Buffer.alloc(17 * 1024)]))).status).toBe(413)
      expect((await put(1, 'r1')).status).toBe(201)
      const again = await put(1, 'r1', Buffer.concat([JPEG, Buffer.from([1])]))
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ kept: false, reason: 'exists' })
    })

    it('takes no cookie-less or token caller', async () => {
      const alice = await browser(1)
      await join(alice)
      await typeIt(alice, 'r1')
      const res = await fetch(`http://127.0.0.1:${tunnelPort}/api/v1/sessions/${sessionId}/capture/thumbnails/r1`, { method: 'PUT', body: new Uint8Array(JPEG) })
      expect(res.status).toBe(401)
    })
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

  it('ends it when the member is removed', async () => {
    getDb().prepare("INSERT OR IGNORE INTO users (id, email, role, password_hash) VALUES (4, 'u4@test.local', 'QA', 'x')").run()
    const tab = await browser(4)
    await join(tab)
    await tap(tab, 'r1')
    expect(await snapshot(4)).not.toBeNull()
    const removed = await api('DELETE', '/team/members/4', { cookie: cookieFor(2) })
    expect(removed.status).toBe(204)
    // Put back only so the owner's cookie is accepted again and can ask: what it finds is what removal left.
    getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (4, 'u4@test.local', 'QA', 'x')").run()
    expect(await snapshot(4)).toBeNull()
  })

  it('refuses a setting that is not a boolean, and a PAT', async () => {
    expect((await api('PATCH', '/me/preferences', { cookie: cookieFor(1) }, { flowCapture: 'no' })).status).toBe(400)
    expect((await api('PATCH', '/me/preferences', { authorization: `Bearer ${VIEW_PAT}` }, { flowCapture: false })).status).toBe(401)
  })
})
