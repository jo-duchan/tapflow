import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type {
  AgentRegistered, AgentsListed, DeviceBoot, DeviceLeased, DeviceLeaseRefused, DeviceReady, DeviceShutdown, SessionJoined,
} from '@tapflowio/protocol'

// `device:lease`: the relay chooses a device, makes the asker its holder and boots it in one step. The choice rules
// are `leaseChoice.test.ts`; these check the wiring — that a burst of leases spreads over Macs, that a device a person
// may come back to is never taken, and that every boot still goes through the Mac's gate.
describe('the relay leases a device to an automation client', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  const sockets: WebSocket[] = []

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-lease-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close()
    await server.stop()
  })

  async function start(): Promise<void> {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  }

  async function open(client?: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}${client ? `?client=${client}` : ''}`)
    sockets.push(ws)
    await waitForOpen(ws)
    return ws
  }

  /** An agent on Mac `agentId`. Devices are shut down unless named in `booted`. */
  async function agent(agentId: string, deviceIds: string[], opts: { platform?: string; booted?: string[]; memUsedMB?: number } = {}) {
    const platform = opts.platform ?? 'ios'
    const ws = await open()
    ws.send(JSON.stringify({
      type: 'agent:register', agentId, agentName: `${agentId}-${platform}`, platform,
      devices: deviceIds.map((id) => ({ id, name: id, platform, status: opts.booted?.includes(id) ? 'booted' : 'shutdown' })),
    }))
    const reply = await waitForType<AgentRegistered>(ws, 'agent:registered')
    if (opts.memUsedMB !== undefined) report(ws, { memUsedMB: opts.memUsedMB })
    return { ws, session: new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId])) }
  }

  function report(ws: WebSocket, over: { memUsedMB?: number; memoryPressure?: string } = {}): void {
    ws.send(JSON.stringify({
      type: 'agent:resources',
      resources: { cpuPercent: 10, memUsedMB: over.memUsedMB ?? 4_000, memTotalMB: 16_000, slotsAvailable: 1, slotsTotal: 2, reportedAt: Date.now(), memoryPressure: over.memoryPressure },
    }))
  }

  function lease(ws: WebSocket, requestId: string, payload: Record<string, unknown> = { platform: 'ios' }): void {
    ws.send(JSON.stringify({ type: 'device:lease', requestId, payload }))
  }

  /** The next lease answer of each kind; asserted to be the one for `requestId`, since answers arrive in order. */
  const leased = async (ws: WebSocket, requestId: string) => {
    const m = await waitForType<DeviceLeased>(ws, 'device:leased')
    expect(m.requestId).toBe(requestId)
    return m
  }
  const refused = async (ws: WebSocket, requestId: string) => {
    const m = await waitForType<DeviceLeaseRefused>(ws, 'device:lease-refused')
    expect(m.requestId).toBe(requestId)
    return m
  }

  /** Lease, let the agent answer the boot, and leave: what one finished run leaves behind. */
  async function runOnce(mac: { ws: WebSocket }, client: WebSocket, requestId: string, ready: Record<string, unknown> = {}): Promise<DeviceLeased> {
    lease(client, requestId)
    const got = await leased(client, requestId)
    const boot = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: boot.sessionId, requestId, payload: { deviceId: boot.payload.deviceId, cold: true, ...ready } }))
    await waitForType<DeviceReady>(client, 'device:ready')
    client.send(JSON.stringify({ type: 'session:leave', sessionId: got.sessionId }))
    // A leave has no reply, and the next lease comes on another socket. The relay handles one socket's messages in
    // order, so an answer to a later one means the leave has landed.
    client.send(JSON.stringify({ type: 'agents:list' }))
    await waitForType<AgentsListed>(client, 'agents:listed')
    return got
  }

  it('says it leases, so a client can tell a relay that would drop the message', async () => {
    await start()
    const ws = await open()
    ws.send(JSON.stringify({ type: 'agents:list' }))
    expect((await waitForType<AgentsListed>(ws, 'agents:listed')).features).toContain('device-lease')
  })

  it('joins the asker, then boots with the lease correlator and what the lease asked for', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const runner = await open()
    const runReset = { uninstall: ['com.example.app'], clear: [] }
    lease(runner, 'L1', { platform: 'ios', runReset, acceptH264: true })
    const got = await leased(runner, 'L1')
    expect(got).toMatchObject({ sessionId: mac.session.get('a'), deviceId: 'a', platform: 'ios', source: 'boot' })
    await waitForType<SessionJoined>(runner, 'session:joined')
    const boot = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    expect(boot).toMatchObject({ sessionId: got.sessionId, requestId: 'L1', payload: { deviceId: 'a', runReset, acceptH264: true } })
    // Booted as automation: the agent is told so, as it would be for a flow runner's own boot.
    expect((boot.payload as Record<string, unknown>)['automation']).toBe(true)
  })

  // D1: each lease is visible to the next one in the same burst — it took the Mac's boot slot — so they spread.
  it('spreads a burst of leases over Macs, one cold boot on each', async () => {
    await start()
    const one = await agent('mac-1', ['a1', 'a2'])
    const two = await agent('mac-2', ['b1', 'b2'])
    const runner = await open()
    lease(runner, 'L1')
    lease(runner, 'L2')
    const first = await leased(runner, 'L1')
    const second = await leased(runner, 'L2')
    const macs = [first, second].map((l) => (one.session.has(l.deviceId) ? 'mac-1' : 'mac-2')).sort()
    expect(macs).toEqual(['mac-1', 'mac-2'])
    await waitForType<DeviceBoot>(one.ws, 'device:boot')
    await waitForType<DeviceBoot>(two.ws, 'device:boot')
    // A third finds both slots taken, and is told to wait rather than handed a device that would only be refused.
    lease(runner, 'L3')
    expect(await refused(runner, 'L3')).toMatchObject({ reason: 'host-booting', retryable: true })
  })

  it('prefers the Mac with more memory left for a boot', async () => {
    await start()
    await agent('mac-1', ['a'], { memUsedMB: 12_000 })
    const two = await agent('mac-2', ['b'], { memUsedMB: 3_000 })
    const runner = await open()
    lease(runner, 'L1')
    expect((await leased(runner, 'L1')).sessionId).toBe(two.session.get('b'))
  })

  it('hands over a device an earlier run left up, warm, before booting another', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const first = await runOnce(mac, await open(), 'L1')
    const runner = await open()
    lease(runner, 'L2')
    const again = await leased(runner, 'L2')
    expect(again).toMatchObject({ sessionId: first.sessionId, source: 'pool' })
    // Warm: delivered even though nothing has settled the first boot's slot.
    expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(first.sessionId)
  })

  // D2: up but not brought up by automation through this relay — opened by hand, or before a restart.
  it('never takes a device that was up before the relay booted it', async () => {
    await start()
    await agent('mac-1', ['a'], { booted: ['a'] })
    const runner = await open()
    lease(runner, 'L1')
    expect(await refused(runner, 'L1')).toMatchObject({ reason: 'all-held', retryable: true })
  })

  // E2: automation booted it, a person picked it up warm and closed the tab; their idle countdown is running.
  it('never takes a device in a person\'s idle countdown', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    await runOnce(mac, await open(), 'L1')
    const person = await open()
    person.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('a') }))
    await waitForType<SessionJoined>(person, 'session:joined')
    person.close()
    await new Promise((r) => person.once('close', r))
    const runner = await open()
    lease(runner, 'L2')
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'all-held' })
  })

  it('takes a device whose countdown an automation client started', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const crashed = await open()
    lease(crashed, 'L1')
    const got = await leased(crashed, 'L1')
    const boot = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: boot.sessionId, requestId: 'L1', payload: { deviceId: 'a', cold: true } }))
    await waitForType<DeviceReady>(crashed, 'device:ready')
    crashed.close() // a runner that died without leaving
    await new Promise((r) => crashed.once('close', r))
    const runner = await open()
    lease(runner, 'L2')
    expect(await leased(runner, 'L2')).toMatchObject({ sessionId: got.sessionId, source: 'pool' })
  })

  // The lease above borrows that countdown and hands it back on leaving; it must come back as automation's, not a person's.
  it('still takes a device whose automation countdown an earlier lease borrowed and handed back', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const crashed = await open()
    lease(crashed, 'L1')
    const got = await leased(crashed, 'L1')
    const boot = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: boot.sessionId, requestId: 'L1', payload: { deviceId: 'a', cold: true } }))
    await waitForType<DeviceReady>(crashed, 'device:ready')
    crashed.close()
    await new Promise((r) => crashed.once('close', r))
    await runOnce(mac, await open(), 'L2')
    const runner = await open()
    lease(runner, 'L3')
    expect(await leased(runner, 'L3')).toMatchObject({ sessionId: got.sessionId, source: 'pool' })
  })

  // A device of ours on another tier is a cold boot (a restart onto the tier), judged as the boot would judge it.
  it('treats a device left up on another tier as a boot, not as one ready to hand over', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    // Another Mac: `a`'s boot still holds mac-1's slot, which refuses a second cold boot there.
    const other = await agent('mac-2', ['b'])
    await runOnce(mac, await open(), 'L1', { serviceTier: { name: 'lean', keep: [] } })
    const runner = await open()
    lease(runner, 'L2', { platform: 'ios', serviceTier: { name: 'slim', keep: [] } })
    expect(await leased(runner, 'L2')).toMatchObject({ sessionId: other.session.get('b'), source: 'boot' })
  })

  it('says to wait, not that every device is in use, when the only device must restart onto the tier', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    await runOnce(mac, await open(), 'L1', { serviceTier: { name: 'lean', keep: [] } })
    const runner = await open()
    lease(runner, 'L2', { platform: 'ios', serviceTier: { name: 'slim', keep: [] } })
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'host-booting', retryable: true })
  })

  it('never takes a device that is starting or stopping outside the relay', async () => {
    await start()
    const ws = await open()
    ws.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-1', agentName: 'mac-1-ios', platform: 'ios',
      devices: [{ id: 'a', name: 'a', platform: 'ios', status: 'unknown' }],
    }))
    await waitForType<AgentRegistered>(ws, 'agent:registered')
    const runner = await open()
    lease(runner, 'L1')
    expect(await refused(runner, 'L1')).toMatchObject({ reason: 'all-held' })
  })

  // An AI client that joined during a person's countdown hands it back on leaving; the countdown stays the person's.
  it('never takes a device whose countdown an AI client handed back to a person', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    await runOnce(mac, await open(), 'L1')
    const person = await open()
    person.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('a') }))
    await waitForType<SessionJoined>(person, 'session:joined')
    person.close()
    await new Promise((r) => person.once('close', r))
    const agentClient = await open()
    agentClient.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('a'), clientKind: 'mcp' }))
    await waitForType<SessionJoined>(agentClient, 'session:joined')
    agentClient.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
    const runner = await open()
    lease(runner, 'L2')
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'all-held' })
  })

  it('never takes a device a person booted, even after they left it', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const person = await open()
    person.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('a') }))
    await waitForType<SessionJoined>(person, 'session:joined')
    person.send(JSON.stringify({ type: 'device:boot', sessionId: mac.session.get('a'), requestId: 'p1', payload: { deviceId: 'a' } }))
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: mac.session.get('a'), requestId: 'p1', payload: { deviceId: 'a', cold: true } }))
    await waitForType<DeviceReady>(person, 'device:ready')
    person.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
    const runner = await open()
    lease(runner, 'L1')
    expect(await refused(runner, 'L1')).toMatchObject({ reason: 'all-held' })
  })

  it('never takes a device another client holds', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const holder = await open()
    holder.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('a'), clientKind: 'flow-runner' }))
    await waitForType<SessionJoined>(holder, 'session:joined')
    const runner = await open()
    lease(runner, 'L1')
    expect(await refused(runner, 'L1')).toMatchObject({ reason: 'all-held' })
  })

  it('refuses at the automation cap before the boot gate is asked', async () => {
    const before = process.env['TAPFLOW_MAX_AUTOMATED_DEVICES']
    process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
    try {
      await start()
      const mac = await agent('mac-1', ['a', 'b'])
      const first = await open()
      lease(first, 'L1')
      await leased(first, 'L1') // held, so the cap cannot shut it down to make room
      const runner = await open()
      lease(runner, 'L2')
      expect(await refused(runner, 'L2')).toMatchObject({ reason: 'host-at-capacity', retryable: true })
      expect(mac.session.size).toBe(2)
    } finally {
      if (before === undefined) delete process.env['TAPFLOW_MAX_AUTOMATED_DEVICES']
      else process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = before
    }
  })

  it('skips the sessions the lease excludes', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const runner = await open()
    lease(runner, 'L1', { platform: 'ios', exclude: [mac.session.get('a')] })
    expect((await leased(runner, 'L1')).sessionId).toBe(mac.session.get('b'))
  })

  it('reads the platform from the build', async () => {
    await start()
    const db = getDb()
    const app = db.prepare("INSERT INTO apps (name, platform) VALUES ('Shop', 'android')").run()
    const build = db.prepare("INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path, platform) VALUES (?, '1.0', '1', 'com.example.shop', 'x.apk', 'android')").run(app.lastInsertRowid)
    await agent('mac-1', ['ios-1'])
    const droid = await agent('mac-1', ['emu-1'], { platform: 'android' })
    const runner = await open()
    lease(runner, 'L1', { platform: 'ios', buildId: Number(build.lastInsertRowid) })
    expect((await leased(runner, 'L1')).sessionId).toBe(droid.session.get('emu-1'))
    lease(runner, 'L2', { buildId: 99_999 })
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'bad-request', retryable: false })
  })

  it('refuses what it cannot serve, and says waiting will not help', async () => {
    await start()
    await agent('mac-1', ['a'])
    const runner = await open()
    lease(runner, 'L1', {})
    expect(await refused(runner, 'L1')).toMatchObject({ reason: 'bad-request', retryable: false })
    lease(runner, 'L2', { platform: 'android' })
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'no-device', retryable: false })
  })

  // E3: a Mac refusing for critical memory frees an idle automation device, as a refused boot does.
  it('frees an idle automation device when critical memory refuses the lease', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const idle = await runOnce(mac, await open(), 'L1')
    report(mac.ws, { memoryPressure: 'critical' })
    const runner = await open()
    lease(runner, 'L2', { platform: 'ios', exclude: [idle.sessionId] })
    expect(await refused(runner, 'L2')).toMatchObject({ reason: 'host-memory-critical', retryable: true })
    expect((await waitForType<DeviceShutdown>(mac.ws, 'device:shutdown')).sessionId).toBe(idle.sessionId)
  })

  it('sends nothing to a Mac it passed over', async () => {
    await start()
    const one = await agent('mac-1', ['a'], { memUsedMB: 14_000 })
    await agent('mac-2', ['b'], { memUsedMB: 2_000 })
    const runner = await open()
    lease(runner, 'L1')
    await leased(runner, 'L1')
    expect(await waitForTypeOrNull(one.ws, 'device:boot', 300)).toBeNull()
  })
})
