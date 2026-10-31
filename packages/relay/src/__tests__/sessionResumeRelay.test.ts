import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AgentsListed, DeviceSummary } from '@tapflowio/protocol'

/**
 * **The relay says whose a waiting device is, to the right people, and ends the wait only when it really ends**
 * (#1087). `sessionWaitingOwner.test.ts` holds the rules in `SessionManager`; this holds the wiring: the listing is
 * asked for on behalf of the signed-in user, and a shutdown counts only once it is actually sent to the agent.
 *
 * Browsers connect through the tunnel port with a session cookie. A loopback socket on the relay port is never
 * authenticated, so two of them would be the same anonymous user and "someone else" could not be tested.
 */
const IDLE = 1_500

describe('a device waiting for its owner, through the relay', () => {
  let tmpDir: string
  let server: RelayServer
  let relayPort: number
  let tunnelPort: number
  let agent: WebSocket
  let sessionId: string
  let agentName: string
  let seq = 0
  const open: WebSocket[] = []

  const cookieFor = (userId: number) => `tapflow_token=${signJwt({ userId, email: `u${userId}@test.local`, role: 'Admin' })}`

  async function browser(userId: number, tab: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/?client=${tab}`, { headers: { cookie: cookieFor(userId) } })
    open.push(ws)
    await waitForOpen(ws)
    return ws
  }

  async function registerAgent(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${relayPort}`)
    open.push(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName,
      devices: [{ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }],
    }))
    sessionId = (await waitForType<AgentRegistered>(ws, 'agent:registered')).registeredSessions[0]!.sessionId
    return ws
  }

  async function device(ws: WebSocket): Promise<DeviceSummary> {
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType<AgentsListed>(ws, 'agents:listed')
    return listed.sessions.flatMap((s) => s.devices).find((d) => d.sessionId === sessionId)!
  }

  /** A socket's close reaches the relay when it does; ask until the listing shows it, rather than guessing a delay. */
  async function until(ws: WebSocket, pred: (d: DeviceSummary) => boolean): Promise<DeviceSummary> {
    for (let i = 0; i < 40; i++) {
      const d = await device(ws)
      if (pred(d)) return d
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('the listing never showed it')
  }

  async function aliceDropped(): Promise<WebSocket> {
    const tab = await browser(1, `alice-${seq}`)
    tab.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'dashboard' }))
    await waitForType(tab, 'session:joined')
    tab.terminate()
    const laptop = await browser(1, `alice-laptop-${seq}`)
    await until(laptop, (d) => d.resumable === true)
    return laptop
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-session-resume-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    // One with a display name and one without, so both halves of the naming rule are on the wire.
    for (const [id, name] of [[1, 'Alice'], [2, null]] as const) {
      db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, 'Admin', 'x')").run(id, `u${id}@test.local`, name)
    }
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    seq++
    agentName = `resume-agent-${seq}`
    server = new RelayServer({ port: 0, tunnelPort: 0, idleTimeoutMs: IDLE, agentGraceMs: 5_000 })
    await server.start()
    relayPort = (server.address() as net.AddressInfo).port
    tunnelPort = (server.tunnelAddress() as net.AddressInfo).port
    agent = await registerAgent()
  })

  afterEach(async () => {
    for (const ws of open.splice(0)) ws.terminate()
    await server.stop()
  })

  it('offers the owner a resume from another browser, and shows everyone else whose it is', async () => {
    const laptop = await aliceDropped()
    const bob = await browser(2, 'bob')

    const mine = await device(laptop)
    expect(mine.waiting?.user).toBe('u1@test.local')
    expect(mine.waiting?.name).toBe('Alice')
    expect(mine.resumable).toBe(true)
    const theirs = await device(bob)
    expect(theirs.waiting?.user).toBe('u1@test.local')
    expect(theirs.resumable).toBeUndefined()
  })

  it('tells the owner who took the device, and nobody else', async () => {
    const laptop = await aliceDropped()
    const bob = await browser(2, 'bob')
    bob.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'dashboard' }))
    await waitForType(bob, 'session:joined')

    // No display name, so the part of the email before `@`, as `/auth/me` names them.
    expect((await device(laptop)).endedBy).toMatchObject({ by: 'u2@test.local', name: 'u2' })
    expect((await device(bob)).endedBy).toBeUndefined()
  })

  it('tells the owner who shut the device down', async () => {
    const laptop = await aliceDropped()
    const bob = await browser(2, 'bob')
    bob.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')

    const mine = await device(laptop)
    expect(mine.endedBy?.by).toBe('u2@test.local')
    expect(mine.waiting).toBeUndefined()
  })

  // Refused because the agent is away. Counting it would tell the owner the device was taken while it still waits.
  it('ends nothing on a shutdown that was refused', async () => {
    const laptop = await aliceDropped()
    agent.terminate()
    const bob = await browser(2, 'bob')
    bob.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId: 'rq-refused', payload: { deviceId: 'dev-1' } }))
    await waitForType(bob, 'device:shutdown-error')

    agent = await registerAgent()
    const mine = await device(laptop)
    expect(mine.endedBy).toBeUndefined()
    expect(mine.waiting?.user).toBe('u1@test.local')
  })

  // The countdown is the backstop for a device nobody is using; a shutdown that did not happen must not remove it.
  it('keeps the countdown when the shutdown fails', async () => {
    const laptop = await aliceDropped()
    laptop.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    agent.send(JSON.stringify({ type: 'device:shutdown-error', sessionId, message: 'simctl failed' }))

    await barrier(agent)
    expect((await device(laptop)).resumable).toBe(true)
    // The relay's own shutdown when the countdown runs out.
    expect(await waitForTypeOrNull(agent, 'device:shutdown', IDLE * 2)).not.toBeNull()
  })

  // The device is still up and its countdown still runs, so it still waits for its owner — and nobody shut it down.
  it('puts the wait back when someone else\'s shutdown fails', async () => {
    const laptop = await aliceDropped()
    const bob = await browser(2, 'bob')
    bob.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    expect((await device(laptop)).endedBy).toBeDefined()

    agent.send(JSON.stringify({ type: 'device:shutdown-error', sessionId, message: 'simctl failed' }))
    await barrier(agent)
    const mine = await device(laptop)
    expect(mine.resumable).toBe(true)
    expect(mine.waiting?.user).toBe('u1@test.local')
    expect(mine.endedBy).toBeUndefined()
  })

  // The failure answers the shutdown, not the pick-up after it: that one's wait stands.
  it('does not put an old wait back over a boot that went out after the shutdown', async () => {
    const laptop = await aliceDropped()
    const bob = await browser(2, 'bob')
    bob.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    bob.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'dashboard' }))
    await waitForType(bob, 'session:joined')
    bob.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-bob', payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:boot')

    agent.send(JSON.stringify({ type: 'device:shutdown-error', sessionId, message: 'simctl failed' }))
    await barrier(agent)
    const mine = await device(laptop)
    expect(mine.waiting).toBeUndefined()
    expect(mine.endedBy?.by).toBe('u2@test.local')
  })

  // The shutdown's done arrives after the owner already came back, booted the device and dropped again.
  it('keeps a wait that began after the device was booted again behind a shutdown', async () => {
    const laptop = await aliceDropped()
    laptop.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    laptop.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'dashboard' }))
    await waitForType(laptop, 'session:joined')
    laptop.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-again', payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:boot')
    laptop.terminate()
    const phone = await browser(1, `alice-phone-${seq}`)
    await until(phone, (d) => d.resumable === true)

    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId }))
    await barrier(agent)
    expect((await device(phone)).resumable).toBe(true)
  })

  it('stops the countdown once the device is down', async () => {
    const laptop = await aliceDropped()
    laptop.send(JSON.stringify({ type: 'device:shutdown', sessionId, payload: { deviceId: 'dev-1' } }))
    await waitForType(agent, 'device:shutdown')
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId }))
    await barrier(agent)

    // Past the whole window: nothing more is sent to a device that is already off.
    await new Promise((r) => setTimeout(r, IDLE + 300))
    await barrier(laptop)
    await barrier(agent)
    expect(await waitForTypeOrNull(agent, 'device:shutdown', 0)).toBeNull()
  })
})
