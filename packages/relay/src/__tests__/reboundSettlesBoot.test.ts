import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type {
  AgentRegistered, DeviceBoot, DeviceBootError, DeviceReady, SessionJoined, SessionRebound,
  SessionTerminated,
} from '@tapflowio/protocol'

// #885. The relay owns settling in-flight boots at rebind, because it is the only layer that knows
// which agent socket each boot was dispatched to. The client cannot tell "issued before the
// rebound" from "delivered to the old agent", so settling client-side on `session:rebound`
// rejected boots the new agent was already handling.
//
// Both sides of that race are pinned here: a boot dispatched to the old agent fails with a
// correlated `device:boot-error` after `session:rebound`, while a boot dispatched to the new
// agent after the rebind completes normally and is never rejected.
describe('a rebind settles only the boots its old agent was supposed to answer (#885)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-rebound-boot-'))
    initDb(path.join(tmpDir, 'test.db'))
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

  const DEV_A = { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }
  const DEV_B = { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'booted' }

  type Device = { id: string; name: string; platform: string; status: string }

  async function register(devices: Device[], agentId = 'mac-1') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      agentId, agentName: 'the-mac', platform: 'ios',
      devices, capabilities: ['keyboard-set', 'run-reset'],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const byDevice = new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId]))
    return { agent, byDevice }
  }

  async function join(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType<SessionJoined>(browser, 'session:joined')
    return browser
  }

  function boot(browser: WebSocket, sessionId: string, requestId: string, deviceId = 'devA') {
    browser.send(JSON.stringify({
      type: 'device:boot', sessionId, requestId, payload: { deviceId },
    }))
  }

  function pendingBootCount() {
    return (server as unknown as { pendingBoots: Map<string, unknown> }).pendingBoots.size
  }

  /** A server whose boot horizon is milliseconds, so expiry is observable without waiting out 180s. */
  async function restartWithShortBootTtl() {
    await server.stop()
    server = new RelayServer({ port: 0, pendingBootTtlMs: 60 })
    await server.start()
    port = (server.address() as { port: number }).port
  }

  it('fails a boot dispatched to the old agent, after session:rebound and with its correlator', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    // Arrival order, recorded independently of the order-proof queue: the synthetic error must
    // come after the rebound, so the client records `needsReboot` before classifying it.
    const seen: string[] = []
    browser.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      try {
        seen.push((JSON.parse(data.toString()) as { type: string }).type)
      } catch { /* ignore malformed */ }
    })

    boot(browser, sessionId, 'rq-old')
    expect((await waitForType<DeviceBoot>(first.agent, 'device:boot')).requestId).toBe('rq-old')

    const second = await register([DEV_A])

    const rebound = await waitForType<SessionRebound>(browser, 'session:rebound')
    expect(rebound.sessionId).toBe(sessionId)
    const err = await waitForType<DeviceBootError>(browser, 'device:boot-error')
    expect(err.sessionId).toBe(sessionId)
    expect(err.requestId).toBe('rq-old')
    expect(err.message).toMatch(/rebound/)
    expect(seen.indexOf('session:rebound')).toBeLessThan(seen.indexOf('device:boot-error'))

    first.agent.close(); second.agent.close(); browser.close()
  })

  // #1139: a replay's run reset and keyboard set are stranded the same way, and the reset's waiter is minutes long.
  it.each([
    ['device:run-reset', { apps: ['com.app'] }, 'device:run-reset-error'],
    ['device:keyboard-set', {}, 'device:keyboard-set-error'],
  ])('fails a %s dispatched to the old agent, with its correlator', async (type, payload, errorType) => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)
    browser.send(JSON.stringify({ type, sessionId, requestId: 'rq-prep', payload }))
    expect((await waitForType<{ type: string; requestId: string }>(first.agent, type)).requestId).toBe('rq-prep')
    const second = await register([DEV_A])
    await waitForType<SessionRebound>(browser, 'session:rebound')
    const err = await waitForType<{ type: string; requestId: string; message: string }>(browser, errorType)
    expect(err.requestId).toBe('rq-prep')
    expect(err.message).toMatch(/rebound/)
    first.agent.close(); second.agent.close(); browser.close()
  })

  it('forgets a run reset its agent answered, so a later rebind answers nothing for it', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)
    browser.send(JSON.stringify({ type: 'device:run-reset', sessionId, requestId: 'rq-done', payload: { apps: [] } }))
    await waitForType(first.agent, 'device:run-reset')
    expect(pendingBootCount()).toBe(1)
    first.agent.send(JSON.stringify({ type: 'device:run-reset-done', sessionId, requestId: 'rq-done', report: { done: [], failed: [] } }))
    await waitForType(browser, 'device:run-reset-done')
    expect(pendingBootCount()).toBe(0)
    first.agent.close(); browser.close()
  })

  it('lets a boot dispatched to the new agent after the rebind complete, unrejected', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-old')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')

    // The rebind runs inside this register. The recovery boot below is sent without consuming
    // `session:rebound` first — that is the race #885 is about.
    const second = await register([DEV_A])
    boot(browser, sessionId, 'rq-new')

    // Dispatched to the new agent, not the old one.
    expect((await waitForType<DeviceBoot>(second.agent, 'device:boot')).requestId).toBe('rq-new')
    second.agent.send(JSON.stringify({
      type: 'device:ready', sessionId, requestId: 'rq-new', payload: { deviceId: 'devA' },
    }))

    // The old boot still fails with its own correlator, and the new one answers normally.
    expect((await waitForType<SessionRebound>(browser, 'session:rebound')).sessionId).toBe(sessionId)
    expect((await waitForType<DeviceBootError>(browser, 'device:boot-error')).requestId).toBe('rq-old')
    expect((await waitForType<DeviceReady>(browser, 'device:ready')).requestId).toBe('rq-new')

    // Nothing further answers the new boot: no synthetic error carries its id.
    await barrier(browser)
    expect(await waitForTypeOrNull(browser, 'device:boot-error', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
  })

  it("leaves another agent's pending boot alone when this agent rebinds", async () => {
    // The `oldSockets` filter in `invalidateBootsFor` is the only thing protecting this:
    // without it, A's rebind fails every tracked boot, including B's.
    const agentA = await register([DEV_A], 'mac-a')
    const agentB = await register([DEV_B], 'mac-b')
    const sessionA = agentA.byDevice.get('devA')!
    const sessionB = agentB.byDevice.get('devB')!
    const browserA = await join(sessionA)
    const browserB = await join(sessionB)

    boot(browserB, sessionB, 'rq-b', 'devB')
    expect((await waitForType<DeviceBoot>(agentB.agent, 'device:boot')).requestId).toBe('rq-b')

    const reboundA = await register([DEV_A], 'mac-a')
    expect((await waitForType<SessionRebound>(browserA, 'session:rebound')).sessionId).toBe(sessionA)

    // B's boot is still pending on the other agent: no synthetic error reaches its browser,
    // and the entry survives A's rebind.
    await barrier(browserB)
    expect(await waitForTypeOrNull(browserB, 'device:boot-error', 0)).toBeNull()
    expect(pendingBootCount()).toBe(1)

    agentA.agent.close(); reboundA.agent.close(); agentB.agent.close(); browserA.close(); browserB.close()
  })

  it('clears a tracked boot when its correlated reply arrives, so a later rebind stays silent', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-done')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    first.agent.send(JSON.stringify({
      type: 'device:ready', sessionId, requestId: 'rq-done', payload: { deviceId: 'devA' },
    }))
    expect((await waitForType<DeviceReady>(browser, 'device:ready')).requestId).toBe('rq-done')

    boot(browser, sessionId, 'rq-fail')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    first.agent.send(JSON.stringify({
      type: 'device:boot-error', sessionId, requestId: 'rq-fail', message: 'simctl could not boot',
    }))
    expect((await waitForType<DeviceBootError>(browser, 'device:boot-error')).requestId).toBe('rq-fail')

    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')
    await barrier(browser)
    expect(await waitForTypeOrNull(browser, 'device:boot-error', 0)).toBeNull()
    expect(pendingBootCount()).toBe(0)

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('clears nothing for an id-less reply, which answers no request', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-x')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')

    // Android reporting a stream that died mid-session: correlated by nothing, forwarded as is.
    first.agent.send(JSON.stringify({ type: 'device:boot-error', sessionId, message: 'stream died' }))
    const stray = await waitForType<DeviceBootError>(browser, 'device:boot-error')
    expect(stray.requestId).toBeUndefined()
    first.agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    await waitForType<DeviceReady>(browser, 'device:ready')

    // The tracked boot survived both id-less frames: the rebind still settles it.
    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')
    expect((await waitForType<DeviceBootError>(browser, 'device:boot-error')).requestId).toBe('rq-x')

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('drops tracked boots when the session ends without an eviction', async () => {
    // Review finding: `session:end`, `session:leave` and the cross-identity removal bypass
    // `evictAgentSocket`, so without a sweep here the entry outlives the session it names.
    // No misfire either way — a late correlated reply still clears via `settleBoot`, and a
    // rebind can never address a removed session — but the map must stay bounded.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-gone')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    expect(pendingBootCount()).toBe(1)

    browser.send(JSON.stringify({ type: 'session:end', sessionId }))
    await barrier(browser)
    expect(pendingBootCount()).toBe(0)

    first.agent.close(); browser.close()
  })

  it('expires an unanswered boot silently at the horizon', async () => {
    // A live agent that never replies pins the entry past every caller that could have waited
    // on it (both clients time out at 180s). Expiry forgets bookkeeping only: it manufactures
    // no `device:boot-error`, because the client timeout owns that failure.
    await restartWithShortBootTtl()

    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-stale')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    expect(pendingBootCount()).toBe(1)

    await new Promise((r) => setTimeout(r, 150))
    expect(pendingBootCount()).toBe(0)
    await barrier(browser)
    expect(await waitForTypeOrNull(browser, 'device:boot-error', 0)).toBeNull()

    first.agent.close(); browser.close()
  })

  it('cancels the expiry timer when a cleanup path settles the boot first', async () => {
    // Deletion alone cannot prove this — an uncleared timer firing later is a no-op delete —
    // so the cleared handle itself is the assertion.
    await restartWithShortBootTtl()

    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-c')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    const timer = (server as unknown as { pendingBoots: Map<string, { timer: unknown }> })
      .pendingBoots.values().next().value!.timer

    const cleared: unknown[] = []
    const realClearTimeout = globalThis.clearTimeout
    const spy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((h: unknown) => { cleared.push(h); return realClearTimeout(h as never) }) as typeof clearTimeout)
    try {
      first.agent.send(JSON.stringify({
        type: 'device:ready', sessionId, requestId: 'rq-c', payload: { deviceId: 'devA' },
      }))
      await waitForType<DeviceReady>(browser, 'device:ready')
    } finally {
      spy.mockRestore()
    }
    expect(cleared).toContain(timer)
    expect(pendingBootCount()).toBe(0)

    first.agent.close(); browser.close()
  })

  it('drops tracked boots when their agent socket is evicted, after telling the browser', async () => {
    await server.stop()
    server = new RelayServer({ port: 0, agentGraceMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    boot(browser, sessionId, 'rq-z')
    await waitForType<DeviceBoot>(first.agent, 'device:boot')
    expect(pendingBootCount()).toBe(1)

    // No rebind coming: the hold expires, the session is removed, and the browser is told the
    // session ended — which settles its waiter with the better diagnosis, so the tracked boot
    // is dropped silently rather than answered twice.
    first.agent.close()
    const ended = await waitForType<SessionTerminated>(browser, 'session:terminated')
    expect(ended.reason).toBe('agent-disconnected')
    expect(pendingBootCount()).toBe(0)

    browser.close()
  })
})
