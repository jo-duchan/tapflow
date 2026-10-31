import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AgentsListed, DeviceBoot, DeviceBootError, DeviceBootWaiting, GenericError, SessionJoined } from '@tapflowio/protocol'

// The wiring half of `admission/HostBootGate.ts`. The gate's rules are in `hostBootGate.test.ts`; these check
// that the relay's messages reach it, and the claims a unit test cannot make — that the paths which must *not*
// release a slot (a correlator's TTL, a rebind) really do not, since the gate has no input for them at all.
describe('the relay routes boots through the per-Mac boot gate', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  const sockets: WebSocket[] = []

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-boot-gate-'))
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

  async function start(opts: Partial<ConstructorParameters<typeof RelayServer>[0]> = {}): Promise<void> {
    server = new RelayServer({ port: 0, ...opts })
    await server.start()
    port = (server.address() as { port: number }).port
  }

  async function open(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    sockets.push(ws)
    await waitForOpen(ws)
    return ws
  }

  /** An agent on Mac `agentId` with the named devices, all shut down. */
  async function agent(agentId: string, deviceIds: string[], platform = 'ios') {
    const ws = await open()
    ws.send(JSON.stringify({
      type: 'agent:register', agentId, agentName: `${agentId}-${platform}`, platform,
      devices: deviceIds.map((id) => ({ id, name: id, platform, status: 'shutdown' })),
    }))
    const reply = await waitForType<AgentRegistered>(ws, 'agent:registered')
    return { ws, session: new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId])) }
  }

  async function join(sessionId: string, clientKind?: 'flow-runner'): Promise<WebSocket> {
    const ws = await open()
    ws.send(JSON.stringify({ type: 'session:start', sessionId, ...(clientKind ? { clientKind } : {}) }))
    await waitForType<SessionJoined>(ws, 'session:joined')
    return ws
  }

  function boot(browser: WebSocket, sessionId: string, deviceId: string, requestId = `${sessionId}-boot`): void {
    browser.send(JSON.stringify({ type: 'device:boot', sessionId, requestId, payload: { deviceId } }))
  }

  const resources = (cpuPercent: number, memoryPressure?: string) => JSON.stringify({
    type: 'agent:resources',
    resources: { cpuPercent, memUsedMB: 4000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 2, reportedAt: Date.now(), memoryPressure },
  })

  it('forwards the tier a run asks for, and charges a running device on another tier as a cold boot', async () => {
    await start()
    const ws = await open()
    const lean = { name: 'lean', keep: [] }
    ws.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-1', agentName: 'mac-1-ios', platform: 'ios',
      devices: [
        { id: 'a', name: 'a', platform: 'ios', status: 'booted', serviceTier: lean },
        { id: 'b', name: 'b', platform: 'ios', status: 'shutdown' },
      ],
    }))
    const reply = await waitForType<AgentRegistered>(ws, 'agent:registered')
    const session = new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId]))
    const slim = { name: 'slim', keep: ['push'] }
    const robot = await join(session.get('a')!, 'flow-runner')
    robot.send(JSON.stringify({ type: 'device:boot', sessionId: session.get('a'), requestId: 'r-a', payload: { deviceId: 'a', serviceTier: slim } }))
    const forwarded = await waitForType<DeviceBoot>(ws, 'device:boot')
    expect(forwarded.payload.serviceTier).toEqual(slim)

    // `a` is booted, but on lean: moving it to slim restarts it, so the Mac's slot is taken.
    const second = await join(session.get('b')!, 'flow-runner')
    boot(second, session.get('b')!, 'b')
    expect((await waitForType<DeviceBootError>(second, 'device:boot-error')).reason).toBe('host-booting')
  })

  it('does not charge a running device already on the asked tier, which it learns from the ready', async () => {
    await start()
    const ws = await open()
    ws.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-1', agentName: 'mac-1-ios', platform: 'ios',
      devices: [{ id: 'a', name: 'a', platform: 'ios', status: 'shutdown' }, { id: 'b', name: 'b', platform: 'ios', status: 'shutdown' }],
    }))
    const reply = await waitForType<AgentRegistered>(ws, 'agent:registered')
    const session = new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId]))
    const slim = { name: 'slim', keep: [] }
    const robot = await join(session.get('a')!, 'flow-runner')
    robot.send(JSON.stringify({ type: 'device:boot', sessionId: session.get('a'), requestId: 'r1', payload: { deviceId: 'a', serviceTier: slim } }))
    await waitForType<DeviceBoot>(ws, 'device:boot')
    ws.send(JSON.stringify({ type: 'device:ready', sessionId: session.get('a'), requestId: 'r1', payload: { deviceId: 'a', cold: false, serviceTier: slim } }))
    await waitForType(robot, 'device:ready')

    const listed = async () => {
      robot.send(JSON.stringify({ type: 'agents:list' }))
      return (await waitForType<AgentsListed>(robot, 'agents:listed')).sessions[0]!.devices.find((d) => d.id === 'a')!.serviceTier
    }
    expect(await listed()).toEqual(slim)

    // The same tier again: warm, so it does not take the slot and the other device can boot.
    robot.send(JSON.stringify({ type: 'device:boot', sessionId: session.get('a'), requestId: 'r2', payload: { deviceId: 'a', serviceTier: slim } }))
    await waitForType<DeviceBoot>(ws, 'device:boot')
    boot(await join(session.get('b')!, 'flow-runner'), session.get('b')!, 'b')
    expect((await waitForType<DeviceBoot>(ws, 'device:boot')).sessionId).toBe(session.get('b'))

    // Off, the recorded tier goes with it: the agent reverts the overrides on shutdown, and the next ready says anew.
    ws.send(JSON.stringify({ type: 'device:shutdown-done', sessionId: session.get('a'), payload: { deviceId: 'a' } }))
    await vi.waitFor(async () => expect(await listed()).toBeUndefined())
  })

  it('refuses a second automated cold boot on the same Mac with host-booting', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const first = await join(mac.session.get('a')!, 'flow-runner')
    const second = await join(mac.session.get('b')!, 'flow-runner')

    boot(first, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    boot(second, mac.session.get('b')!, 'b')
    const refused = await waitForType<DeviceBootError>(second, 'device:boot-error')
    expect(refused.reason).toBe('host-booting')
    expect(refused.requestId).toBe(`${mac.session.get('b')}-boot`)
  })

  it('counts an iOS and an Android agent on one Mac together, and other Macs apart', async () => {
    await start()
    const ios = await agent('mac-1', ['a'])
    const android = await agent('mac-1', ['p'], 'android')
    const elsewhere = await agent('mac-2', ['q'], 'android')
    boot(await join(ios.session.get('a')!, 'flow-runner'), ios.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(ios.ws, 'device:boot')

    const sameMac = await join(android.session.get('p')!, 'flow-runner')
    boot(sameMac, android.session.get('p')!, 'p')
    expect((await waitForType<DeviceBootError>(sameMac, 'device:boot-error')).reason).toBe('host-booting')

    boot(await join(elsewhere.session.get('q')!, 'flow-runner'), elsewhere.session.get('q')!, 'q')
    await waitForType<DeviceBoot>(elsewhere.ws, 'device:boot')
  })

  it('holds a person behind an automated boot and sends theirs when the agent reports the first was warm', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const robot = await join(mac.session.get('a')!, 'flow-runner')
    const person = await join(mac.session.get('b')!)

    boot(robot, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    boot(person, mac.session.get('b')!, 'b')
    expect(await waitForTypeOrNull(mac.ws, 'device:boot', 150)).toBeNull()

    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: mac.session.get('a'), requestId: `${mac.session.get('a')}-boot`, payload: { deviceId: 'a', cold: false } }))
    const forwarded = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    expect(forwarded.sessionId).toBe(mac.session.get('b'))
  })

  it('tells a held person their boot is waiting, and until when', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    boot(await join(mac.session.get('a')!, 'flow-runner'), mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    const person = await join(mac.session.get('b')!)
    const before = Date.now()
    boot(person, mac.session.get('b')!, 'b')
    const waiting = await waitForType<DeviceBootWaiting>(person, 'device:boot-waiting')
    expect(waiting.requestId).toBe(`${mac.session.get('b')}-boot`)
    expect(waiting.until).toBeGreaterThanOrEqual(before + 60_000)
  })

  // Clients wait out any boot error that carries a `reason`, so only the relay's gate may set one.
  it('strips a reason an agent put on its own boot failure', async () => {
    await start()
    const mac = await agent('mac-1', ['a'])
    const person = await join(mac.session.get('a')!)
    boot(person, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('a'), requestId: `${mac.session.get('a')}-boot`, reason: 'host-booting', message: 'simctl failed' }))
    const failed = await waitForType<DeviceBootError>(person, 'device:boot-error')
    expect(failed.message).toBe('simctl failed')
    expect(failed.reason).toBeUndefined()
  })

  // The memory safety valve, end to end: the agent's own report is what closes and reopens the Mac.
  it('refuses automation and holds a person while an agent reports critical memory, and lets the person go when it clears', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    // A report from an agent that cannot read pressure says nothing, so a co-resident one's critical stands.
    const other = await agent('mac-1', ['z'], 'android')
    mac.ws.send(resources(40, 'critical'))
    other.ws.send(resources(40))
    const robot = await join(mac.session.get('a')!, 'flow-runner')
    boot(robot, mac.session.get('a')!, 'a')
    const refused = await waitForType<DeviceBootError>(robot, 'device:boot-error')
    expect(refused.reason).toBe('host-memory-critical')
    expect(refused.message).toMatch(/short of memory/)

    const person = await join(mac.session.get('b')!)
    boot(person, mac.session.get('b')!, 'b')
    expect((await waitForType<DeviceBootWaiting>(person, 'device:boot-waiting')).reason).toBe('host-memory-critical')
    expect(await waitForTypeOrNull(mac.ws, 'device:boot', 150)).toBeNull()

    mac.ws.send(resources(40, 'warn'))
    expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
  })

  it('reports each Mac\'s admission on the device listing, the same on both of its agents', async () => {
    await start()
    const ios = await agent('mac-1', ['a'])
    const android = await agent('mac-1', ['p'], 'android')
    ios.ws.send(resources(95))
    await new Promise((r) => setTimeout(r, 50))
    const lister = await open()
    const list = async () => {
      lister.send(JSON.stringify({ type: 'agents:list' }))
      return (await waitForType<AgentsListed>(lister, 'agents:listed')).sessions.map((s) => [s.platform, s.admission])
    }
    // CPU over the line and no boot: a new join would be refused, on the Mac's iOS agent; Android's own reading is idle.
    await vi.waitFor(async () => expect(await list()).toEqual(expect.arrayContaining([['ios', { booting: false, overloaded: true, memoryRefuses: [] }]])))

    boot(await join(android.session.get('p')!, 'flow-runner'), android.session.get('p')!, 'p')
    await waitForType<DeviceBoot>(android.ws, 'device:boot')
    // A boot holds the Mac: both agents say so, and the CPU is the boot's, so the join gate is paused.
    await vi.waitFor(async () => expect(await list()).toEqual(expect.arrayContaining([
      ['ios', { booting: true, overloaded: false, memoryRefuses: [] }],
      ['android', { booting: true, overloaded: false, memoryRefuses: [] }],
    ])))
  })

  it('keeps a Mac short of memory open while it has a device up to rejoin, and names the devices it would refuse', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const memFull = JSON.stringify({ type: 'agent:resources', resources: { cpuPercent: 10, memUsedMB: 15_500, memTotalMB: 16_000, slotsAvailable: 1, slotsTotal: 2, reportedAt: Date.now() } })
    mac.ws.send(memFull)
    await new Promise((r) => setTimeout(r, 50))
    const lister = await open()
    const admission = async () => {
      lister.send(JSON.stringify({ type: 'agents:list' }))
      return (await waitForType<AgentsListed>(lister, 'agents:listed')).sessions[0]!.admission
    }
    // Nothing up: a person could not get in anywhere on this Mac.
    await vi.waitFor(async () => expect(await admission()).toEqual({ booting: false, overloaded: true, memoryRefuses: ['a', 'b'] }))

    // Bring one device up through the relay (memory was fine then), and the Mac opens again — for that device.
    mac.ws.send(resources(10))
    await new Promise((r) => setTimeout(r, 50))
    const person = await join(mac.session.get('a')!)
    boot(person, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: mac.session.get('a'), requestId: `${mac.session.get('a')}-boot`, payload: { deviceId: 'a', cold: false } }))
    mac.ws.send(memFull)
    await new Promise((r) => setTimeout(r, 50))
    await vi.waitFor(async () => expect(await admission()).toEqual({ booting: false, overloaded: false, memoryRefuses: ['b'] }))
  })

  it('sends a held person after the longest wait even with the slot still taken', async () => {
    await start({ bootGate: { humanWaitMs: 100 } })
    const mac = await agent('mac-1', ['a', 'b'])
    boot(await join(mac.session.get('a')!, 'flow-runner'), mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    boot(await join(mac.session.get('b')!), mac.session.get('b')!, 'b')
    const forwarded = await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    expect(forwarded.sessionId).toBe(mac.session.get('b'))
  })

  it('answers a held boot whose person left, and never sends it', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    boot(await join(mac.session.get('a')!, 'flow-runner'), mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    const person = await join(mac.session.get('b')!)
    boot(person, mac.session.get('b')!, 'b')
    await new Promise((r) => setTimeout(r, 50))
    person.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('b') }))
    // The held boot is answered on the socket that asked, and nothing is forwarded when the slot frees.
    expect((await waitForType<DeviceBootError>(person, 'device:boot-error')).requestId).toBe(`${mac.session.get('b')}-boot`)
    mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId: mac.session.get('a'), payload: { deviceId: 'a', cold: false } }))
    expect(await waitForTypeOrNull(mac.ws, 'device:boot', 150)).toBeNull()
  })

  it('lets a person join an up device at high CPU while a boot holds the Mac, and not otherwise', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    mac.ws.send(resources(95))
    await new Promise((r) => setTimeout(r, 50))

    const refusedBefore = await open()
    refusedBefore.send(JSON.stringify({ type: 'session:start', sessionId: mac.session.get('b') }))
    expect((await waitForType<GenericError>(refusedBefore, 'error')).reason).toBe('agent-resources-exhausted')

    // A boot already holding the slot was let in before the CPU rose; its CPU is the boot's.
    mac.ws.send(resources(10))
    await new Promise((r) => setTimeout(r, 50))
    boot(await join(mac.session.get('a')!, 'flow-runner'), mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    mac.ws.send(resources(95))
    await new Promise((r) => setTimeout(r, 50))
    await join(mac.session.get('b')!)
  })

  it('keeps the slot past the boot correlator\'s TTL — the device is still booting', async () => {
    await start({ pendingBootTtlMs: 30 })
    const mac = await agent('mac-1', ['a', 'b'])
    boot(await join(mac.session.get('a')!, 'flow-runner'), mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    await new Promise((r) => setTimeout(r, 100))

    const second = await join(mac.session.get('b')!, 'flow-runner')
    boot(second, mac.session.get('b')!, 'b')
    expect((await waitForType<DeviceBootError>(second, 'device:boot-error')).reason).toBe('host-booting')
  })

  it('keeps the slot across an agent restart that rebinds the booting session', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const robot = await join(mac.session.get('a')!, 'flow-runner')
    boot(robot, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')

    // The same agent restarts and registers the same devices: the sessions are rebound, not replaced.
    await agent('mac-1', ['a', 'b'])
    const second = await join(mac.session.get('b')!, 'flow-runner')
    boot(second, mac.session.get('b')!, 'b')
    expect((await waitForType<DeviceBootError>(second, 'device:boot-error')).reason).toBe('host-booting')
  })

  it('frees the slot when the booting session ends', async () => {
    await start()
    const mac = await agent('mac-1', ['a', 'b'])
    const robot = await join(mac.session.get('a')!, 'flow-runner')
    boot(robot, mac.session.get('a')!, 'a')
    await waitForType<DeviceBoot>(mac.ws, 'device:boot')
    robot.send(JSON.stringify({ type: 'session:end', sessionId: mac.session.get('a') }))
    await new Promise((r) => setTimeout(r, 50))

    boot(await join(mac.session.get('b')!, 'flow-runner'), mac.session.get('b')!, 'b')
    expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
  })

  // S3: the automation cap. The gate's slot is released at once (`noSampleMs`/`settleCapMs` tiny), so these test the
  // cap and not the one-boot-at-a-time rule.
  describe('the per-Mac automation cap', () => {
    const quickGate = { bootGate: { noSampleMs: 1, settleCapMs: 1 } }
    const ready = (agentWs: WebSocket, sessionId: string, deviceId: string, cold = true) =>
      agentWs.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: `${sessionId}-boot`, payload: { deviceId, cold } }))

    afterEach(() => { delete process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] })

    /** A flow-runner boots `id` cold, the agent brings it up, and the runner leaves. */
    async function runAndLeave(mac: Awaited<ReturnType<typeof agent>>, id: string): Promise<void> {
      const sessionId = mac.session.get(id)!
      const robot = await join(sessionId, 'flow-runner')
      boot(robot, sessionId, id)
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, sessionId, id)
      await waitForType(robot, 'device:ready')
      robot.send(JSON.stringify({ type: 'session:leave', sessionId }))
      await new Promise((r) => setTimeout(r, 30))
    }

    it('shuts down the oldest idle automation device to make room, and lets the boot go', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      await runAndLeave(mac, 'a')
      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      const shutdown = await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')
      expect(shutdown.sessionId).toBe(mac.session.get('a'))
      expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
    })

    // #1087: a person picked up a device automation left running, then their connection dropped. The device is waiting
    // for them, which makes it theirs, as a person's countdown already is to a lease.
    it('does not shut down a device waiting for a person to come back', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      await runAndLeave(mac, 'a')
      const person = await join(mac.session.get('a')!)
      person.terminate()
      await new Promise((r) => setTimeout(r, 50))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBootError>(robot, 'device:boot-error')).reason).toBe('host-at-capacity')
      await barrier(robot)
      await barrier(mac.ws)
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 0)).toBeNull()
    })

    it('refuses with host-at-capacity when every automation device is in use', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      const holder = await join(mac.session.get('a')!, 'flow-runner')
      boot(holder, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, mac.session.get('a')!, 'a')
      await waitForType(holder, 'device:ready')
      await new Promise((r) => setTimeout(r, 20))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      const refused = await waitForType<DeviceBootError>(robot, 'device:boot-error')
      expect(refused.reason).toBe('host-at-capacity')
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
    })

    it('does not count a boot that failed, or a device a person started', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'p', 'b'])
      // An automated boot that fails leaves nothing up.
      const robotA = await join(mac.session.get('a')!, 'flow-runner')
      boot(robotA, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('a'), requestId: `${mac.session.get('a')}-boot`, message: 'simctl failed' }))
      await waitForType(robotA, 'device:boot-error')
      // A person starts p and leaves it up.
      const person = await join(mac.session.get('p')!)
      boot(person, mac.session.get('p')!, 'p')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, mac.session.get('p')!, 'p')
      await waitForType(person, 'device:ready')
      await new Promise((r) => setTimeout(r, 20))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
    })

    // A boot can fail on the relay's side and still bring the device up (a slow simulator past the agent's deadline).
    // When the agent comes back reporting it running, nothing says automation started it.
    it('forgets who asked for a boot that failed, even if the device turns up running', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      const robotA = await join(mac.session.get('a')!, 'flow-runner')
      boot(robotA, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('a'), requestId: `${mac.session.get('a')}-boot`, message: 'timed out' }))
      await waitForType(robotA, 'device:boot-error')
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
      // The agent restarts and finds a up.
      const again = await open()
      again.send(JSON.stringify({
        type: 'agent:register', agentId: 'mac-1', agentName: 'mac-1-ios', platform: 'ios',
        devices: [{ id: 'a', name: 'a', platform: 'ios', status: 'booted' }, { id: 'b', name: 'b', platform: 'ios', status: 'shutdown' }],
      }))
      await waitForType<AgentRegistered>(again, 'agent:registered')

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(again, 'device:boot')).sessionId).toBe(mac.session.get('b'))
      expect(await waitForTypeOrNull(again, 'device:shutdown', 100)).toBeNull()
    })

    it('keeps a device on the books when an earlier boot brought it up and a later one found it running', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      const sessionId = mac.session.get('a')!
      const robotA = await join(sessionId, 'flow-runner')
      boot(robotA, sessionId, 'a', 'r1')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      boot(robotA, sessionId, 'a', 'r2') // a retry before the first answered
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'r1', payload: { deviceId: 'a', cold: true } }))
      mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'r2', payload: { deviceId: 'a', cold: false } }))
      await waitForType(robotA, 'device:ready')
      await new Promise((r) => setTimeout(r, 20))
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId }))
      await new Promise((r) => setTimeout(r, 30))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(sessionId)
    })

    it('counts nothing when two overlapping boots both found the device already running', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      const sessionId = mac.session.get('a')!
      const robotA = await join(sessionId, 'flow-runner')
      boot(robotA, sessionId, 'a', 'r1')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      boot(robotA, sessionId, 'a', 'r2')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'r1', payload: { deviceId: 'a', cold: false } }))
      mac.ws.send(JSON.stringify({ type: 'device:ready', sessionId, requestId: 'r2', payload: { deviceId: 'a', cold: false } }))
      await waitForType(robotA, 'device:ready')
      await new Promise((r) => setTimeout(r, 20))
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId }))
      await new Promise((r) => setTimeout(r, 30))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
    })

    it('forgets a boot an agent restart stranded, so it does not hold a place for good', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start({ bootGate: { noSampleMs: 1, settleCapMs: 1, reboundMs: 1 } })
      const mac = await agent('mac-1', ['a', 'b'])
      const robotA = await join(mac.session.get('a')!, 'flow-runner')
      boot(robotA, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      const again = await agent('mac-1', ['a', 'b']) // the agent restarts: the boot is answered by the relay
      await waitForType(robotA, 'device:boot-error')
      await new Promise((r) => setTimeout(r, 20)) // and the rebound slot is let go
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
      await new Promise((r) => setTimeout(r, 30))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(again.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
    })

    // The shutdown that makes room carries no correlator, and the device can be picked up and started again before
    // the agent answers it. That late answer must not wipe the new boot off the books.
    it('a late answer to a room-making shutdown does not erase the boot that picked the device up again', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '2'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b', 'c', 'e'])
      await runAndLeave(mac, 'a')
      await runAndLeave(mac, 'c')
      const id = (d: string) => mac.session.get(d)!
      // b needs room: a, the oldest idle, goes.
      const robotB = await join(id('b'), 'flow-runner')
      boot(robotB, id('b'), 'b')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(id('a'))
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, id('b'), 'b')
      await waitForType(robotB, 'device:ready')
      await new Promise((r) => setTimeout(r, 20))
      // Another run starts a again before the agent has answered its shutdown; c goes to make room.
      const robotD = await join(id('a'), 'flow-runner')
      boot(robotD, id('a'), 'a', 'a-again')
      await waitForType(mac.ws, 'device:shutdown')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      // Now the answer to a's first shutdown arrives.
      mac.ws.send(JSON.stringify({ type: 'device:shutdown-done', sessionId: id('a') }))
      await new Promise((r) => setTimeout(r, 20))
      // b (held) and a (booting, held) fill the cap of 2, and nothing is idle: e is refused for capacity.
      const robotE = await join(id('e'), 'flow-runner')
      boot(robotE, id('e'), 'e')
      expect((await waitForType<DeviceBootError>(robotE, 'device:boot-error')).reason).toBe('host-at-capacity')
    })

    // A shutdown the agent could not carry out, or never answered, leaves the device up: it counts, and can go again.
    it('counts a device again when the shutdown that was to make room fails', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b', 'c'])
      await runAndLeave(mac, 'a')
      const robotB = await join(mac.session.get('b')!, 'flow-runner')
      boot(robotB, mac.session.get('b')!, 'b')
      await waitForType(mac.ws, 'device:shutdown')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:shutdown-error', sessionId: mac.session.get('a'), message: 'simctl failed' }))
      mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('b'), requestId: `${mac.session.get('b')}-boot`, message: 'gave up' }))
      await waitForType(robotB, 'device:boot-error')
      robotB.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('b') }))
      await new Promise((r) => setTimeout(r, 20))
      // a is still up and idle, so c has to send it away again.
      const robotC = await join(mac.session.get('c')!, 'flow-runner')
      boot(robotC, mac.session.get('c')!, 'c')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(mac.session.get('a'))
    })

    it('counts a device again when the agent never answers the shutdown', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start({ ...quickGate, evictionGraceMs: 30 })
      const mac = await agent('mac-1', ['a', 'b', 'c'])
      await runAndLeave(mac, 'a')
      const robotB = await join(mac.session.get('b')!, 'flow-runner')
      boot(robotB, mac.session.get('b')!, 'b')
      await waitForType(mac.ws, 'device:shutdown')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('b'), requestId: `${mac.session.get('b')}-boot`, message: 'gave up' }))
      await waitForType(robotB, 'device:boot-error')
      robotB.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('b') }))
      await new Promise((r) => setTimeout(r, 50)) // past the grace, with no word from the agent
      const robotC = await join(mac.session.get('c')!, 'flow-runner')
      boot(robotC, mac.session.get('c')!, 'c')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(mac.session.get('a'))
    })

    it('forgets a boot its agent never answered once the boot\'s deadline passes', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start({ bootGate: { noSampleMs: 1, settleCapMs: 1, bootMs: 20 }, pendingBootTtlMs: 30 })
      const mac = await agent('mac-1', ['a', 'b'])
      const robotA = await join(mac.session.get('a')!, 'flow-runner')
      boot(robotA, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
      await new Promise((r) => setTimeout(r, 60)) // past both the gate's and the correlator's deadline, unanswered

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
    })

    it('records a boot that answers after its record expired as the automation boot it was', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start({ bootGate: { noSampleMs: 1, settleCapMs: 1, bootMs: 20 }, pendingBootTtlMs: 30 })
      const mac = await agent('mac-1', ['a', 'b', 'c'])
      const robotA = await join(mac.session.get('a')!, 'flow-runner')
      boot(robotA, mac.session.get('a')!, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('a') }))
      await new Promise((r) => setTimeout(r, 60))
      // b's boot expires a's record and goes; b fails, so it holds nothing.
      const robotB = await join(mac.session.get('b')!, 'flow-runner')
      boot(robotB, mac.session.get('b')!, 'b')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      mac.ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: mac.session.get('b'), requestId: `${mac.session.get('b')}-boot`, message: 'gave up' }))
      await waitForType(robotB, 'device:boot-error')
      robotB.send(JSON.stringify({ type: 'session:leave', sessionId: mac.session.get('b') }))
      // a's agent answers after all: the device is up, and automation started it, though nobody holds it now.
      ready(mac.ws, mac.session.get('a')!, 'a')
      await new Promise((r) => setTimeout(r, 40))

      const robotC = await join(mac.session.get('c')!, 'flow-runner')
      boot(robotC, mac.session.get('c')!, 'c')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(mac.session.get('a'))
    })

    it('does not count a boot that found the device already running', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b'])
      const sessionId = mac.session.get('a')!
      const robotA = await join(sessionId, 'flow-runner')
      boot(robotA, sessionId, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, sessionId, 'a', false)
      await waitForType(robotA, 'device:ready')
      robotA.send(JSON.stringify({ type: 'session:leave', sessionId }))
      await new Promise((r) => setTimeout(r, 30))

      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBoot>(mac.ws, 'device:boot')).sessionId).toBe(mac.session.get('b'))
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
    })

    it('shuts nothing down for a boot the gate holds back behind another boot', async () => {
      process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = '1'
      await start() // the slot stays taken until settled
      const mac = await agent('mac-1', ['a', 'b', 'c'])
      await runAndLeave(mac, 'a') // a is up, idle, and still holds the slot while it settles
      const robot = await join(mac.session.get('b')!, 'flow-runner')
      boot(robot, mac.session.get('b')!, 'b')
      expect((await waitForType<DeviceBootError>(robot, 'device:boot-error')).reason).toBe('host-booting')
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
    })

    // Idle automation devices are what fills a Mac, and while it is critical no boot gets far enough to free one
    // for the cap. The refusal frees the oldest idle one, one at a time.
    it('frees the oldest idle automation device when a boot is refused for critical memory, one at a time', async () => {
      await start(quickGate)
      const mac = await agent('mac-1', ['a', 'b', 'c', 'd'])
      await runAndLeave(mac, 'a')
      await runAndLeave(mac, 'b')
      mac.ws.send(resources(40, 'critical'))
      const robot = await join(mac.session.get('c')!, 'flow-runner')
      boot(robot, mac.session.get('c')!, 'c', 'c-1')
      expect((await waitForType<DeviceBootError>(robot, 'device:boot-error')).reason).toBe('host-memory-critical')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(mac.session.get('a'))
      // A retry while that shutdown is still on its way frees nothing more.
      boot(robot, mac.session.get('c')!, 'c', 'c-2')
      await waitForType<DeviceBootError>(robot, 'device:boot-error')
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 100)).toBeNull()
      // Once it is done, the next refusal frees the next one.
      mac.ws.send(JSON.stringify({ type: 'device:shutdown-done', sessionId: mac.session.get('a') }))
      await new Promise((r) => setTimeout(r, 20))
      mac.ws.send(resources(40, 'critical'))
      boot(robot, mac.session.get('c')!, 'c', 'c-3')
      await waitForType<DeviceBootError>(robot, 'device:boot-error')
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(mac.session.get('b'))
    })

    it('a run that borrowed a device in a person\'s idle countdown starts the countdown again when it leaves', async () => {
      await start({ ...quickGate, idleTimeoutMs: 150 })
      const mac = await agent('mac-1', ['a'])
      const sessionId = mac.session.get('a')!
      const person = await join(sessionId)
      boot(person, sessionId, 'a')
      await waitForType<DeviceBoot>(mac.ws, 'device:boot')
      ready(mac.ws, sessionId, 'a')
      await waitForType(person, 'device:ready')
      person.close() // the idle countdown starts
      await new Promise((r) => setTimeout(r, 30))
      const robot = await join(sessionId, 'flow-runner') // stops it
      // MCP calls connect_device again on a device it holds; that must not forget the countdown it stopped.
      robot.send(JSON.stringify({ type: 'session:start', sessionId, clientKind: 'flow-runner' }))
      await waitForType(robot, 'session:joined')
      robot.send(JSON.stringify({ type: 'session:leave', sessionId }))
      expect((await waitForType<{ type: 'device:shutdown'; sessionId: string }>(mac.ws, 'device:shutdown')).sessionId).toBe(sessionId)
    })

    it('a run that leaves a device nobody was counting down keeps it up, as before', async () => {
      await start({ ...quickGate, idleTimeoutMs: 100 })
      const mac = await agent('mac-1', ['a'])
      await runAndLeave(mac, 'a')
      expect(await waitForTypeOrNull(mac.ws, 'device:shutdown', 250)).toBeNull()
    })
  })
})
