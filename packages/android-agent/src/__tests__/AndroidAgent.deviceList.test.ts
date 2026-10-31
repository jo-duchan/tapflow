import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import type { AgentsListed, DeviceSummary } from '@tapflowio/protocol'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'
import { AndroidAgent } from '../AndroidAgent'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

// #1085. The agent re-reads its AVDs and sends the list when it changed, so one created in Android Studio reaches the
// dashboard without an agent restart. Against a real relay, whose answer is what gives the agent a state for the new
// session.

function adbListing(initial: string[]) {
  let avds = initial
  const runner: AdbRunner = {
    exec: vi.fn(async (...args: string[]) => (args[0] === 'devices' ? 'List of devices attached\n' : '')),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    listAvds: vi.fn(async () => avds),
  }
  const adb = new AdbWrapper(runner)
  return { adb, set: (next: string[]) => { avds = next } }
}

const VERSIONS: Record<string, string> = { Pixel_8: 'Android 14', Pixel_Tablet: 'Android 15' }

describe('AndroidAgent device list re-read (#1085)', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string
  let agent: AndroidAgent | null = null

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-android-device-list-'))
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

  async function connect(adb: AdbWrapper) {
    agent = new AndroidAgent({
      deviceRereadMs: 40,
      avdFormFactor: (name) => (name.includes('Tablet') ? 'tablet' : 'phone'),
      avdOsVersion: (name) => VERSIONS[name],
    }, adb)
    await agent.connect(`ws://localhost:${port}`)
  }

  it('registers an emulator that is not running with the version its image carries', async () => {
    const { adb } = adbListing(['Pixel_8'])
    await connect(adb)
    expect((await listed())[0]).toMatchObject({ id: 'avd:Pixel_8', status: 'shutdown', osVersion: 'Android 14' })
  })

  it('lists an AVD created on the Mac, and can serve its session', async () => {
    const { adb, set } = adbListing(['Pixel_8'])
    await connect(adb)
    set(['Pixel_8', 'Pixel_Tablet'])
    await vi.waitFor(async () => expect((await listed()).map((d) => d.id).sort()).toEqual(['avd:Pixel_8', 'avd:Pixel_Tablet']), { timeout: 2000 })
    expect((await listed()).find((d) => d.id === 'avd:Pixel_Tablet')).toMatchObject({ formFactor: 'tablet', osVersion: 'Android 15' })
    await vi.waitFor(() => expect(states()).toEqual(['avd:Pixel_8', 'avd:Pixel_Tablet']))
  })

  it('drops an AVD deleted on the Mac', async () => {
    const { adb, set } = adbListing(['Pixel_8', 'Pixel_Tablet'])
    await connect(adb)
    set(['Pixel_8'])
    await vi.waitFor(async () => expect((await listed()).map((d) => d.id)).toEqual(['avd:Pixel_8']), { timeout: 2000 })
    await vi.waitFor(() => expect(states()).toEqual(['avd:Pixel_8']))
  })

  // The serial map is how a boot finds the emulator it launched; a re-read every 30 s must not move it.
  it('reads without syncing the serial map', async () => {
    const { adb } = adbListing(['Pixel_8'])
    const sync = vi.spyOn(adb, 'listDevices')
    await connect(adb)
    const atConnect = sync.mock.calls.length
    adb.setSerial('avd:Pixel_8', 'emulator-5554')
    await new Promise((r) => setTimeout(r, 200))
    expect(sync.mock.calls.length).toBe(atConnect)
    expect(adb.getSerial('avd:Pixel_8')).toBe('emulator-5554')
  })
})
