import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import type { AgentRegistered } from '@tapflowio/protocol'

/**
 * **MCP Flow Capture's observation through the relay** (L6a). An MCP holder arms record-time observation with
 * `capture:observe`; the relay forwards it to an agent that takes it, keeps it on across the holder's own boots and the
 * agent coming back, turns it off when the holder goes, and passes back the observation of each touch **that holder**
 * sent — and nothing else. The relay keeps none of it.
 *
 * Clients connect through the tunnel port with a session cookie, as in `flowCaptureRelay.test.ts`: the holder kind is
 * what `session:start` declares.
 */
describe('MCP capture observation through the relay', () => {
  let tmpDir: string
  let server: RelayServer
  let relayPort: number
  let tunnelPort: number
  let agent: WebSocket
  let sessionId: string
  let seq = 0
  const open: WebSocket[] = []

  const cookieFor = (userId: number) => `tapflow_token=${signJwt({ userId, email: `u${userId}@test.local`, role: 'Admin' })}`

  async function client(userId: number, tab = `c${userId}-${seq}`): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/?client=${tab}`, { headers: { cookie: cookieFor(userId) } })
    open.push(ws)
    await waitForOpen(ws)
    return ws
  }

  async function join(ws: WebSocket, clientKind: string): Promise<void> {
    ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind }))
    await waitForType(ws, 'session:joined')
  }

  async function registerAgent(capabilities: string[], name = `observe-agent-${seq}`): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${relayPort}`)
    open.push(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name, capabilities,
      devices: [{ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }],
    }))
    sessionId = (await waitForType<AgentRegistered>(ws, 'agent:registered')).registeredSessions[0]!.sessionId
    return ws
  }

  /** Arms or disarms, and waits for the one reply expected: a waiter for the other would stay queued and take a later
   *  reply meant for another wait (`waitForType` hands each message to the oldest waiter of its type). */
  async function observe(ws: WebSocket, on: boolean, requestId = `o-${on}`, reply: 'capture:observe-done' | 'capture:observe-error' = 'capture:observe-done'): Promise<{ type: string; requestId: string; observing?: boolean; message?: string }> {
    const answer = waitForType<{ type: string; requestId: string; observing?: boolean; message?: string }>(ws, reply)
    ws.send(JSON.stringify({ type: 'capture:observe', sessionId, requestId, payload: { on } }))
    const got = await answer
    expect(got.requestId).toBe(requestId)
    return got
  }

  /** One tap, acked, so everything before it has reached the agent. */
  async function tap(ws: WebSocket, requestId: string): Promise<void> {
    ws.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.5 } }))
    ws.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId, payload: { x: 0.5, y: 0.5 } }))
    const end = await waitForType<{ type: string; requestId: string }>(agent, 'input:touch:end')
    agent.send(JSON.stringify({ type: 'input:done', sessionId, requestId: end.requestId }))
    await waitForType(ws, 'input:done')
  }

  const touched = (requestId: string, label: string) => JSON.stringify({
    type: 'capture:touched', sessionId, requestId,
    observation: { point: { x: 0.5, y: 0.5 }, moving: false, element: { label, traits: 1 } },
  })

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-mcp-observe-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (1, 'u1@test.local', 'QA', 'x')").run()
    db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (2, 'u2@test.local', 'Admin', 'x')").run()
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    seq++
    server = new RelayServer({ port: 0, tunnelPort: 0, idleTimeoutMs: 60_000, agentGraceMs: 5_000 })
    await server.start()
    relayPort = (server.address() as net.AddressInfo).port
    tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
    agent = await registerAgent(['capture-observe'])
  })

  afterEach(async () => {
    for (const ws of open.splice(0)) ws.terminate()
    await server.stop()
  })

  it('forwards an MCP holder\'s arming to the agent and says it is observing', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    const forwarded = waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')
    expect(await observe(mcp, true)).toMatchObject({ type: 'capture:observe-done', observing: true })
    expect((await forwarded).payload).toEqual({ on: true })
  })

  it('answers not observing, and sends the agent nothing, when the agent cannot take it', async () => {
    agent = await registerAgent([], `plain-agent-${seq}`)
    const mcp = await client(1)
    await join(mcp, 'mcp')
    let got = false
    agent.on('message', (d) => { if (String(d).includes('capture:observe')) got = true })
    expect(await observe(mcp, true)).toMatchObject({ type: 'capture:observe-done', observing: false })
    await tap(mcp, 't-after')
    expect(got).toBe(false)
  })

  it.each([['dashboard'], ['flow-runner']])('refuses a %s holder: only an MCP client observes its own touches', async (kind) => {
    const holder = await client(1)
    await join(holder, kind)
    expect(await observe(holder, true, 'o-true', 'capture:observe-error')).toMatchObject({ type: 'capture:observe-error' })
  })

  it('refuses a client that does not hold the session', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    const other = await client(2)
    expect(await observe(other, true, 'o-other', 'capture:observe-error')).toMatchObject({ type: 'capture:observe-error' })
  })

  it('answers a malformed request rather than dropping it', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    mcp.send(JSON.stringify({ type: 'capture:observe', sessionId, requestId: 'bad', payload: { on: 'yes' } }))
    expect(await waitForType<{ type: string; requestId: string }>(mcp, 'capture:observe-error')).toMatchObject({ requestId: 'bad' })
  })

  it('passes back the observations of the touches the armed holder sent, and of no other', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await tap(mcp, 'mine')
    // A requestId this holder never sent (another holder's, or forged) is not passed on.
    agent.send(touched('not-mine', 'Forged'))
    agent.send(touched('mine', 'Login'))
    agent.send(JSON.stringify({ type: 'capture:landed', sessionId, requestId: 'mine', landed: { on: 'app' } }))
    const first = await waitForType<{ type: string; requestId: string; touched?: { element?: { label?: string } } }>(mcp, 'capture:observation')
    expect(first).toMatchObject({ requestId: 'mine', touched: { element: { label: 'Login' } } })
    const second = await waitForType<{ type: string; requestId: string; landed?: { on: string } }>(mcp, 'capture:observation')
    expect(second).toMatchObject({ requestId: 'mine', landed: { on: 'app' } })
  })

  it('passes nothing back for a touch sent before arming', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await tap(mcp, 'early')
    await observe(mcp, true)
    await tap(mcp, 'late')
    agent.send(touched('early', 'Before'))
    agent.send(touched('late', 'After'))
    const got = await waitForType<{ type: string; requestId: string }>(mcp, 'capture:observation')
    expect(got.requestId).toBe('late')
  })

  it('keeps observation on across the armed holder\'s own boot, and off for one that did not arm', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
    expect((await waitForType<{ type: string; payload: { observed?: boolean } }>(agent, 'device:boot')).payload.observed).toBe(false)
    await observe(mcp, true)
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b2', payload: { deviceId: 'dev-1' } }))
    expect((await waitForType<{ type: string; payload: { observed?: boolean } }>(agent, 'device:boot')).payload.observed).toBe(true)
  })

  it('turns observation off on the device when the armed holder leaves', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    mcp.send(JSON.stringify({ type: 'session:leave', sessionId }))
    expect((await waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')).payload).toEqual({ on: false })
  })

  it('turns observation off when the armed holder\'s socket closes', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    mcp.close()
    expect((await waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')).payload).toEqual({ on: false })
  })

  it('turns observation off when someone else takes the device, and passes them nothing', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    mcp.send(JSON.stringify({ type: 'session:leave', sessionId }))
    await waitForType(agent, 'capture:observe')
    const person = await client(2)
    await join(person, 'dashboard')
    await tap(person, 'theirs')
    let passed = false
    person.on('message', (d) => { if (String(d).includes('capture:observation')) passed = true })
    agent.send(touched('theirs', 'Theirs'))
    await tap(person, 'after')
    expect(passed).toBe(false)
  })

  it('arms the agent again when it comes back, for the holder still there', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    // The same agent re-registering (a restart) gets the session back, and with it what was armed.
    const again = new WebSocket(`ws://localhost:${relayPort}`)
    open.push(again)
    await waitForOpen(again)
    again.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: `observe-agent-${seq}`, capabilities: ['capture-observe'],
      devices: [{ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }],
    }))
    const rearm = await waitForType<{ type: string; sessionId: string; payload: { on: boolean } }>(again, 'capture:observe')
    expect(rearm).toMatchObject({ sessionId, payload: { on: true } })
  })

  it('announces that it takes capture:observe on the device listing', async () => {
    const mcp = await client(1)
    mcp.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType<{ type: string; features?: string[] }>(mcp, 'agents:listed')
    expect(listed.features).toContain('capture-observe')
  })

  it('does not arm an agent that cannot take it, so its boots are not observed either', async () => {
    agent = await registerAgent([], `plain-agent-boot-${seq}`)
    const mcp = await client(1)
    await join(mcp, 'mcp')
    expect(await observe(mcp, true)).toMatchObject({ observing: false })
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
    expect((await waitForType<{ type: string; payload: { observed?: boolean } }>(agent, 'device:boot')).payload.observed).toBe(false)
  })

  it('puts right at the ready an arming that changed while the boot ran', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    // Booted unarmed, armed while the boot runs: the boot will set it off, so its ready turns it back on.
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
    const boot = await waitForType<{ type: string; requestId: string; payload: { observed?: boolean } }>(agent, 'device:boot')
    expect(boot.payload.observed).toBe(false)
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: boot.requestId, payload: { deviceId: 'dev-1', cold: false } }))
    expect((await waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')).payload).toEqual({ on: true })
  })

  it('puts right at the ready an armed boot whose holder left while it ran', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
    const boot = await waitForType<{ type: string; requestId: string; payload: { observed?: boolean } }>(agent, 'device:boot')
    expect(boot.payload.observed).toBe(true)
    mcp.send(JSON.stringify({ type: 'session:leave', sessionId }))
    expect((await waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')).payload).toEqual({ on: false })
    // The boot then finishes and turns it on again; its ready turns it off once more.
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: boot.requestId, payload: { deviceId: 'dev-1', cold: false } }))
    expect((await waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')).payload).toEqual({ on: false })
  })

  // Only a boot's own ready reads what that boot set (CodeRabbit, #1243). A later boot went armed and the holder then
  // turned observation off: an earlier boot's late ready must not take that snapshot as its own, or the later boot's
  // ready — the one that actually sets the device — finds nothing to put right and leaves observation on.
  it('puts right at a boot\'s own ready, not at an earlier boot\'s late one', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1' } }))
    expect((await waitForType<{ type: string; payload: { observed?: boolean } }>(agent, 'device:boot')).payload.observed).toBe(false)
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    mcp.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'b2', payload: { deviceId: 'dev-1' } }))
    expect((await waitForType<{ type: string; payload: { observed?: boolean } }>(agent, 'device:boot')).payload.observed).toBe(true)
    await observe(mcp, false)
    await waitForType(agent, 'capture:observe')
    const seen: Array<{ on: boolean }> = []
    agent.on('message', (d) => { const m = JSON.parse(String(d)) as { type: string; payload: { on: boolean } }; if (m.type === 'capture:observe') seen.push(m.payload) })
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'b1', payload: { deviceId: 'dev-1', cold: false } }))
    // Two round trips through the agent's socket: anything the ready made the relay send has arrived by then.
    await tap(mcp, 's1')
    await tap(mcp, 's2')
    expect(seen).toEqual([])
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'b2', payload: { deviceId: 'dev-1', cold: false } }))
    await tap(mcp, 's3')
    await tap(mcp, 's4')
    expect(seen).toEqual([{ on: false }])
  })

  // The same person back as a dashboard is not the MCP holder that armed it (CodeRabbit, #1243).
  it('turns observation off when the armed holder comes back as another kind of client, and passes it nothing', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    await tap(mcp, 'mine')
    const off = waitForType<{ type: string; payload: { on: boolean } }>(agent, 'capture:observe')
    const dash = await client(1)
    await join(dash, 'dashboard')
    expect((await off).payload).toEqual({ on: false })
    let passed = false
    for (const ws of [mcp, dash]) ws.on('message', (d) => { if (String(d).includes('capture:observation')) passed = true })
    agent.send(touched('mine', 'Mine'))
    await tap(dash, 'after')
    expect(passed).toBe(false)
  })

  it('keeps an off sent while the agent is away, so the agent coming back is not armed again', async () => {
    const mcp = await client(1)
    await join(mcp, 'mcp')
    await observe(mcp, true)
    await waitForType(agent, 'capture:observe')
    const away = waitForType(mcp, 'session:agent-away')
    agent.close()
    await away
    const refused = waitForType<{ type: string; requestId: string }>(mcp, 'capture:observe-error')
    mcp.send(JSON.stringify({ type: 'capture:observe', sessionId, requestId: 'o-off', payload: { on: false } }))
    expect(await refused).toMatchObject({ requestId: 'o-off' })
    const again = new WebSocket(`ws://localhost:${relayPort}`)
    open.push(again)
    await waitForOpen(again)
    let rearmed = false
    again.on('message', (d) => { if (String(d).includes('"capture:observe"')) rearmed = true })
    again.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: `observe-agent-${seq}`, capabilities: ['capture-observe'],
      devices: [{ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }],
    }))
    await waitForType(again, 'agent:registered')
    // A tap through the agent that came back orders everything the relay sent it after the registration.
    mcp.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.5, y: 0.5 } }))
    mcp.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'after', payload: { x: 0.5, y: 0.5 } }))
    await waitForType(again, 'input:touch:end')
    expect(rearmed).toBe(false)
  })
})
