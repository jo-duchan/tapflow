import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { SessionManager, REFRESHED_FIELDS } from '../SessionManager'
import { initDb, closeDb, getDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentDevicesApplied, AgentRegistered, AgentsListed, DeviceReport, SessionJoined } from '@tapflowio/protocol'

// #1085. An agent re-reads its device list and sends it whole when it changed; the relay diffs it against the
// sessions it holds for that socket. These run the real relay over real sockets, as the agents would.
describe('agent:devices (#1085)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-agent-devices-'))
    initDb(path.join(tmpDir, 'test.db'))
    for (const id of [1, 2]) {
      getDb().prepare('INSERT INTO users (id, email, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(id, `u${id}@example.com`, `User ${id}`, 'QA', makePasswordHash('password123'))
    }
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  const DEV_A: DeviceReport = { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown', osVersion: 'iOS 26.5' }
  const DEV_B: DeviceReport = { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.6' }

  async function open(userId?: number) {
    const ws = new WebSocket(`ws://localhost:${port}`, userId
      ? { headers: { Cookie: `tapflow_token=${signJwt({ userId, email: `u${userId}@example.com`, role: 'QA' })}` } }
      : {})
    await waitForOpen(ws)
    return ws
  }

  async function register(devices: DeviceReport[]) {
    const agent = await open()
    agent.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-1', agentName: 'the-mac', platform: 'ios', devices, capabilities: ['clipboard'],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    return { agent, reply, sessionOf: new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId])) }
  }

  async function update(agent: WebSocket, devices: DeviceReport[]) {
    agent.send(JSON.stringify({ type: 'agent:devices', devices }))
    return waitForType<AgentDevicesApplied>(agent, 'agent:devices-applied')
  }

  async function listing() {
    const ws = await open()
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType<AgentsListed>(ws, 'agents:listed')
    ws.close()
    return listed.sessions
  }
  const listedDevices = async () => (await listing()).flatMap((s) => s.devices)

  const heartbeat = () => (server as unknown as { runHeartbeat(): void }).runHeartbeat()

  it('tells the agent it may send updates', async () => {
    const { reply } = await register([DEV_A])
    expect(reply.features).toEqual(['device-updates'])
  })

  // The case the feature exists for: a Mac with nothing on it yet. No session holds the agent's identity, so the
  // relay must have kept it from the register.
  it('gives a device that appears on an empty Mac a session under its agent', async () => {
    const { agent } = await register([])
    const applied = await update(agent, [DEV_A])
    expect(applied.added).toEqual([{ deviceId: 'devA', sessionId: expect.any(String) }])
    expect(applied.removed).toEqual([])

    const [group] = await listing()
    expect(group).toMatchObject({ agentName: 'the-mac', agentKey: 'mac-1', platform: 'ios', capabilities: ['clipboard'] })
    expect(group!.devices.map((d) => d.sessionId)).toEqual([applied.added[0]!.sessionId])

    // A restart finds that session by the identity it was created under, and keeps it.
    const restarted = await register([DEV_A])
    expect(restarted.sessionOf.get('devA')).toBe(applied.added[0]!.sessionId)
    agent.close()
  })

  it('keeps the session of a listed device, refreshing its name but not what the relay tracks itself', async () => {
    const { agent, sessionOf } = await register([{ ...DEV_A, status: 'booted', serviceTier: { name: 'lean', keep: [] } }])
    const applied = await update(agent, [{ id: 'devA', name: 'iPhone A renamed', platform: 'ios', status: 'shutdown' }])
    expect(applied).toMatchObject({ added: [], removed: [] })

    const [device] = await listedDevices()
    expect(device).toMatchObject({
      sessionId: sessionOf.get('devA'), name: 'iPhone A renamed',
      // Tracked from device:ready and shutdowns, and read by the lease: a list read must not move them.
      status: 'booted', serviceTier: { name: 'lean', keep: [] },
      // An emulator shut down outside tapflow reports no version. It has not changed.
      osVersion: 'iOS 26.5',
    })
  })

  it('removes a device nobody is on, and says which session went', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const applied = await update(agent, [DEV_A])
    expect(applied.removed).toEqual([{ deviceId: 'devB', sessionId: sessionOf.get('devB') }])
    expect((await listedDevices()).map((d) => d.id)).toEqual(['devA'])
  })

  it('keeps a device someone is on, unlisted, and removes it once they leave', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const browser = await open()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(browser, 'session:joined')

    const applied = await update(agent, [DEV_A])
    expect(applied.removed).toEqual([])
    expect((await listedDevices()).map((d) => d.id)).toEqual(['devA'])

    // Still held: the heartbeat leaves it.
    heartbeat()
    expect(await waitForTypeOrNull(agent, 'agent:devices-applied', 200)).toBeNull()

    browser.send(JSON.stringify({ type: 'session:leave', sessionId: sessionOf.get('devB') }))
    await new Promise((r) => setTimeout(r, 50))
    heartbeat()
    const swept = await waitForType<AgentDevicesApplied>(agent, 'agent:devices-applied')
    expect(swept).toMatchObject({ added: [], removed: [{ deviceId: 'devB', sessionId: sessionOf.get('devB') }] })
    browser.close()
  })

  it('lists a kept device again, under the same session, when it comes back', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const browser = await open()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(browser, 'session:joined')

    await update(agent, [DEV_A])
    const back = await update(agent, [DEV_A, DEV_B])
    expect(back).toMatchObject({ added: [], removed: [] })
    expect((await listedDevices()).find((d) => d.id === 'devB')?.sessionId).toBe(sessionOf.get('devB'))
    browser.close()
  })

  // A device kept for someone who is still on it, then back in the list of an agent that reconnected: the register
  // is the new list, so the device is present again and must be listed — and never swept.
  it('lists a kept device again when its agent comes back with it', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const browser = await open()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(browser, 'session:joined')
    await update(agent, [DEV_A])
    expect((await listedDevices()).map((d) => d.id)).toEqual(['devA'])

    const restarted = await register([DEV_A, DEV_B])
    expect(restarted.sessionOf.get('devB')).toBe(sessionOf.get('devB'))
    expect((await listedDevices()).map((d) => d.id).sort()).toEqual(['devA', 'devB'])
    browser.send(JSON.stringify({ type: 'session:leave', sessionId: sessionOf.get('devB') }))
    await new Promise((r) => setTimeout(r, 50))
    heartbeat()
    expect(await waitForTypeOrNull(restarted.agent, 'agent:devices-applied', 200)).toBeNull()
    browser.close()
    agent.close()
  })

  // A link or an MCP client holding the session id must not take a device that has left: it would boot nothing, and
  // as its holder keep the session from being swept. The one who was on it can still come back.
  it('lets the holder of a gone device re-join its session', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const browser = await open()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(browser, 'session:joined')
    await update(agent, [DEV_A])

    browser.close()
    agent.close()
  })

  // A tab that dropped leaves the device waiting for its person: with the device gone, a teammate may not take it
  // over, and the person may still come back.
  it('keeps a gone device waiting for the person who dropped, and from anyone else', async () => {
    const { agent, sessionOf } = await register([DEV_A, DEV_B])
    const holder = await open(1)
    holder.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(holder, 'session:joined')
    await update(agent, [DEV_A])
    holder.close()
    await new Promise((r) => setTimeout(r, 100))

    const teammate = await open(2)
    teammate.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    expect(await waitForTypeOrNull(teammate, 'session:joined', 300)).toBeNull()
    const back = await open(1)
    back.send(JSON.stringify({ type: 'session:start', sessionId: sessionOf.get('devB') }))
    await waitForType<SessionJoined>(back, 'session:joined')
    teammate.close()
    back.close()
    agent.close()
  })

  // Re-registering evicts the sockets it finds through their sessions, so one that registered empty lingers.
  it('takes no list from a socket its agent has since replaced', async () => {
    const first = await register([])
    const second = await register([DEV_A])
    first.agent.send(JSON.stringify({ type: 'agent:devices', devices: [DEV_A] }))
    expect(await waitForTypeOrNull(first.agent, 'agent:devices-applied', 300)).toBeNull()
    expect((await listedDevices()).map((d) => d.sessionId)).toEqual([second.sessionOf.get('devA')])
    first.agent.close()
    second.agent.close()
  })

  it('takes no list from a socket that never registered', async () => {
    const stranger = await open()
    // A stream socket: registered as something, but not as an agent.
    stranger.send(JSON.stringify({ type: 'stream:register', sessionId: 'nope' }))
    stranger.send(JSON.stringify({ type: 'agent:devices', devices: [DEV_A] }))
    expect(await waitForTypeOrNull(stranger, 'agent:devices-applied', 200)).toBeNull()
    expect(await listedDevices()).toEqual([])
    stranger.close()
  })
})

describe('SessionManager.refreshDevice', () => {
  // `deviceFields` is what a register writes; `refreshDevice` writes a chosen part of it. A field added to the first
  // must be a decision for the second, not something it misses in silence.
  it('writes exactly the fields it declares', () => {
    const before = SessionManager.deviceFields({ id: 'd', name: 'a', platform: 'ios', status: 'booted', osVersion: '1', formFactor: 'phone', serviceTier: { name: 'lean', keep: [] } })
    const report: DeviceReport = { id: 'd', name: 'b', platform: 'android', status: 'shutdown', osVersion: '2', formFactor: 'tablet', serviceTier: 'unsupported' }
    const manager = new SessionManager()
    const [id] = manager.create({ readyState: 1 } as unknown as WebSocket, [{ id: 'd', name: 'a', platform: 'ios', status: 'booted', osVersion: '1', formFactor: 'phone', serviceTier: { name: 'lean', keep: [] } }])
    manager.refreshDevice(id!, report)
    const after = manager.get(id!)!
    const changed = (Object.keys(before) as Array<keyof typeof before>).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))
    expect(changed.sort()).toEqual([...REFRESHED_FIELDS].sort())
  })
})
