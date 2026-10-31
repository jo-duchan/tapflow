import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import type { Device } from '@tapflowio/agent-core'
import type { AgentsListed, DeviceSummary } from '@tapflowio/protocol'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import { IOSAgent } from '../IOSAgent'
import type { SimctlWrapper } from '../SimctlWrapper'
import type { GuestHelperNative } from '../GuestHelper'

// #1085. The agent re-reads its simulators and sends the list when it changed, so one added on the Mac reaches the
// dashboard without an agent restart. Against a real relay: the relay's answer is what gives the agent a state for
// the new session, and a test that faked it would pass with that half missing.

const IPHONE: Device = { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3', typeId: 'type-iphone' }
const IPAD: Device = { id: 'dev-2', name: 'iPad Air', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3', typeId: 'type-ipad' }
const DUO_1: Device = { id: 'duo-1', name: 'iPhone Duo', platform: 'ios', status: 'shutdown', osVersion: 'iOS 27.1', typeId: 'type-duo' }
const DUO_2: Device = { ...DUO_1, id: 'duo-2', name: 'iPhone Duo 2' }

function simctlListing(initial: Device[]) {
  let devices = initial
  const sw = {
    listDevices: vi.fn(async () => devices),
    formFactorsByType: vi.fn(async () => new Map([['type-iphone', 'phone'], ['type-ipad', 'tablet'], ['type-duo', 'phone']])),
    integratedPanelCounts: vi.fn(async (types: string[]) => new Map(types.map((t) => [t, t === 'type-duo' ? 2 : 1]))),
    stopKeyboardDaemon: vi.fn(),
  } as unknown as SimctlWrapper
  return { sw, set: (next: Device[]) => { devices = next } }
}

const guestReady = { unavailableReason: async () => null } as unknown as GuestHelperNative

describe('IOSAgent device list re-read (#1085)', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string
  let agent: IOSAgent | null = null

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ios-device-list-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  beforeEach(async () => {
    relay = new RelayServer({ port: 0 })
    await relay.start()
    port = (relay.address() as { port: number }).port
  })
  afterEach(async () => {
    agent?.disconnect()
    agent = null
    await relay.stop()
  })

  async function listed(): Promise<DeviceSummary[]> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const reply = await waitForType<AgentsListed>(ws, 'agents:listed')
    ws.close()
    return reply.sessions.flatMap((s) => s.devices)
  }
  const states = () => [...(agent as unknown as { deviceStates: Map<string, { deviceId: string }> }).deviceStates.values()].map((s) => s.deviceId).sort()

  async function connect(simctl: SimctlWrapper, deviceFilter?: string) {
    agent = new IOSAgent({ deviceRereadMs: 40, guestHelperNative: guestReady, ...(deviceFilter ? { deviceFilter } : {}) }, simctl)
    await agent.connect(`ws://localhost:${port}`)
  }

  it('lists a simulator added on the Mac, and can serve its session', async () => {
    const { sw, set } = simctlListing([IPHONE])
    await connect(sw)
    set([IPHONE, IPAD])
    await vi.waitFor(async () => expect((await listed()).map((d) => d.id).sort()).toEqual(['dev-1', 'dev-2']), { timeout: 2000 })
    const ipad = (await listed()).find((d) => d.id === 'dev-2')!
    expect(ipad).toMatchObject({ name: 'iPad Air', formFactor: 'tablet', osVersion: 'iOS 18.3' })
    // The relay's answer gave the agent a state for the new session.
    await vi.waitFor(() => expect(states()).toEqual(['dev-1', 'dev-2']))
  })

  it('drops a simulator deleted on the Mac after two reads without it', async () => {
    const { sw, set } = simctlListing([IPHONE, IPAD])
    await connect(sw)
    set([IPHONE])
    await vi.waitFor(async () => expect((await listed()).map((d) => d.id)).toEqual(['dev-1']), { timeout: 2000 })
    await vi.waitFor(() => expect(states()).toEqual(['dev-1']))
  })

  it('keeps to the --device filter', async () => {
    const { sw, set } = simctlListing([IPHONE])
    await connect(sw, 'iPhone 15')
    set([IPHONE, IPAD])
    await new Promise((r) => setTimeout(r, 200))
    expect((await listed()).map((d) => d.id)).toEqual(['dev-1'])
  })

  // A second device of a type already known to fold is offered as one, without asking about the type again: asking
  // could read a plist that will not open as one panel and drop a Duo in use onto the wrong input path.
  it('offers a second Duo as foldable without looking its type up again', async () => {
    const { sw, set } = simctlListing([DUO_1])
    await connect(sw)
    expect((await listed())[0]).toMatchObject({ id: 'duo-1', formFactor: 'foldable' })
    const lookups = (sw.integratedPanelCounts as ReturnType<typeof vi.fn>).mock.calls.length
    set([DUO_1, DUO_2])
    await vi.waitFor(async () => expect((await listed()).find((d) => d.id === 'duo-2')).toMatchObject({ formFactor: 'foldable' }), { timeout: 2000 })
    expect((sw.integratedPanelCounts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(lookups)
  })

  it('stops reading when it disconnects', async () => {
    const { sw } = simctlListing([IPHONE])
    await connect(sw)
    agent!.disconnect()
    agent = null
    const reads = (sw.listDevices as ReturnType<typeof vi.fn>).mock.calls.length
    await new Promise((r) => setTimeout(r, 200))
    expect((sw.listDevices as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads)
  })
})
