import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, DeviceShutdown, DeviceShutdownDone, DeviceShutdownError } from '@tapflowio/protocol'

// #567 and #455. The agent's answer to a `device:shutdown` goes to the session's `browserSocket`, so a
// caller that asked without holding the session — permitted by `mayShutDown` when nobody holds it — heard
// nothing and waited out its own deadline, for a shutdown that had happened. And the agent now answers a
// failure too, which the relay has to forward.
describe('device:shutdown answers reach whoever asked', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-shutdown-requester-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  async function start(options: { agentGraceMs?: number } = {}) {
    server = new RelayServer({ port: 0, ...options })
    await server.start()
    port = (server.address() as { port: number }).port
  }

  beforeEach(async () => { await start() })
  afterEach(async () => { await server.stop() })

  async function registerAgent(devices = ['devA']) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'shutdownRequester-1',
      devices: devices.map((id) => ({ id, name: id, platform: 'ios', status: 'booted' })),
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionOf = (deviceId: string) => reply.registeredSessions.find((s) => s.deviceId === deviceId)!.sessionId
    return { agent, sessionId: sessionOf(devices[0]!), sessionOf }
  }

  async function socket() {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    return ws
  }

  async function joinAs(sessionId: string) {
    const ws = await socket()
    ws.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(ws, 'session:joined')
    return ws
  }

  /** A caller that never joins, and the shutdown it sends — delivered to the agent before this returns. */
  async function askWithoutJoining(agent: WebSocket, sessionId: string, requestId?: string) {
    const caller = await socket()
    const forwarded = waitForType<DeviceShutdown>(agent, 'device:shutdown')
    caller.send(JSON.stringify({
      type: 'device:shutdown', sessionId, ...(requestId === undefined ? {} : { requestId }),
      payload: { deviceId: 'devA' },
    }))
    await forwarded
    return caller
  }

  it('hands the done to a caller that never joined the session (#567)', async () => {
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId, 'rq-567')

    const done = waitForType<DeviceShutdownDone>(caller, 'device:shutdown-done')
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, requestId: 'rq-567', payload: { deviceId: 'devA' } }))
    expect((await done).requestId).toBe('rq-567')

    agent.close(); caller.close()
  })

  it("forwards the agent's shutdown-error to the holder and to a caller that never joined (#455)", async () => {
    const { agent, sessionId } = await registerAgent()
    const holder = await joinAs(sessionId)
    // The holder's own client is the one `mayShutDown` lets through; the caller here is a second socket
    // of an unidentified client, which the gate treats as the same principal on localhost.
    const caller = await askWithoutJoining(agent, sessionId, 'rq-455')

    const atHolder = waitForType<DeviceShutdownError>(holder, 'device:shutdown-error')
    const atCaller = waitForType<DeviceShutdownError>(caller, 'device:shutdown-error')
    agent.send(JSON.stringify({ type: 'device:shutdown-error', sessionId, requestId: 'rq-455', message: 'simctl exploded' }))
    expect((await atHolder).message).toBe('simctl exploded')
    expect((await atCaller).requestId).toBe('rq-455')

    agent.close(); holder.close(); caller.close()
  })

  it('sends a holder that asked the answer once, not twice', async () => {
    const { agent, sessionId } = await registerAgent()
    const holder = await joinAs(sessionId)
    const forwarded = waitForType<DeviceShutdown>(agent, 'device:shutdown')
    holder.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId: 'rq-once', payload: { deviceId: 'devA' } }))
    await forwarded

    const seen: string[] = []
    holder.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string }
      if (m.type === 'device:shutdown-done') seen.push(m.type)
    })
    const done = waitForType(holder, 'device:shutdown-done')
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, requestId: 'rq-once', payload: { deviceId: 'devA' } }))
    await done
    // A second frame would already be in flight behind the first; one round trip is enough to see it.
    await waitForTypeOrNull(holder, 'never', 100)
    expect(seen).toHaveLength(1)

    agent.close(); holder.close()
  })

  it("does not hand one session's answer to another session's caller with the same id", async () => {
    // The id is the client's to choose, so it cannot be the key on its own.
    const { agent, sessionOf } = await registerAgent(['devA', 'devB'])
    const caller = await askWithoutJoining(agent, sessionOf('devA'), 'rq-same')

    const leaked = waitForTypeOrNull(caller, 'device:shutdown-done', 300)
    agent.send(JSON.stringify({
      type: 'device:shutdown-done', sessionId: sessionOf('devB'), requestId: 'rq-same', payload: { deviceId: 'devB' },
    }))
    expect(await leaked).toBeNull()

    agent.close(); caller.close()
  })

  it('does not route an uncorrelated shutdown back to its sender', async () => {
    // The idle timer and the dashboard's teardown send these, and nobody waits on either.
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId)

    const leaked = waitForTypeOrNull(caller, 'device:shutdown-done', 300)
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, payload: { deviceId: 'devA' } }))
    expect(await leaked).toBeNull()

    agent.close(); caller.close()
  })

  it('still delivers after the agent reconnects inside the grace window', async () => {
    // The case that decides where these settle. Both agents reconnect without restarting, so a shutdown
    // in flight across the reconnect is answered on the new socket — failing it at agent-away or at the
    // rebind would tell the caller it failed for a device that then powered off.
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId, 'rq-rebind')

    const early = waitForTypeOrNull(caller, 'device:shutdown-error', 300)
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    const { agent: back } = await registerAgent()
    expect(await early, 'neither the hold nor the rebind may answer for the agent').toBeNull()

    const done = waitForType<DeviceShutdownDone>(caller, 'device:shutdown-done')
    back.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, requestId: 'rq-rebind', payload: { deviceId: 'devA' } }))
    expect((await done).requestId).toBe('rq-rebind')

    back.close(); caller.close()
  })

  it('tells a caller that never joined when the session ends with its shutdown unanswered', async () => {
    await server.stop()
    await start({ agentGraceMs: 50 })
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId, 'rq-lost')

    const err = waitForType<DeviceShutdownError>(caller, 'device:shutdown-error')
    agent.close()
    const msg = await err
    expect(msg.requestId).toBe('rq-lost')
    // Not "failed": the shutdown may well have happened. The message has to say it does not know.
    expect(msg.message).toContain('unknown')

    caller.close()
  })

  it('tells a caller that never joined when its agent comes back unable to take the session', async () => {
    // The other place a session is removed with a shutdown in flight: the device is back under an agent
    // whose identity changed — often the upgrade that starts sending an `agentId` — so the session cannot
    // be rebound and is ended.
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId, 'rq-renamed')
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    const err = waitForType<DeviceShutdownError>(caller, 'device:shutdown-error')
    const renamed = await socket()
    renamed.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentId: 'mac-renamed', agentName: 'shutdownRequester-2',
      devices: [{ id: 'devA', name: 'devA', platform: 'ios', status: 'booted' }],
    }))
    const msg = await err
    expect(msg.requestId).toBe('rq-renamed')
    expect(msg.message).toContain('unknown')

    renamed.close(); caller.close()
  })

  it('stays silent to a caller when the holder ends the session', async () => {
    // The shutdown may still complete on the device, so saying it failed would be a guess. The twin that
    // proves the same caller is told when the session is lost is the eviction test above.
    const { agent, sessionId } = await registerAgent()
    const holder = await joinAs(sessionId)
    const caller = await askWithoutJoining(agent, sessionId, 'rq-ended')

    const err = waitForTypeOrNull(caller, 'device:shutdown-error', 500)
    holder.send(JSON.stringify({ type: 'session:end', sessionId }))
    expect(await err).toBeNull()

    agent.close(); holder.close(); caller.close()
  })

  it('does not tell an uncorrelated caller about a session that ended', async () => {
    // Nobody waits on an id-less shutdown, so the relay keeps no record of who sent one — which is what
    // keeps this error from reaching a socket that asked for nothing it could match.
    await server.stop()
    await start({ agentGraceMs: 50 })
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId)

    const err = waitForTypeOrNull(caller, 'device:shutdown-error', 500)
    agent.close()
    expect(await err).toBeNull()

    caller.close()
  })

  // Not a guard on the close cleanup itself: that only frees memory, and the TTL bounds it anyway — an
  // entry left behind by a closed caller answers nothing, because a closed socket is not sent to.
  it('keeps routing after a caller that asked has gone', async () => {
    const { agent, sessionId } = await registerAgent()
    const caller = await askWithoutJoining(agent, sessionId, 'rq-gone')
    const closed = new Promise<void>((r) => caller.on('close', () => r()))
    caller.close()
    await closed

    // The relay must carry on routing: a holder joining now still gets the id-less answer it is owed.
    const holder = await joinAs(sessionId)
    const done = waitForType<DeviceShutdownDone>(holder, 'device:shutdown-done')
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, requestId: 'rq-gone', payload: { deviceId: 'devA' } }))
    expect((await done).requestId).toBe('rq-gone')

    agent.close(); holder.close()
  })

  async function barrier(ws: WebSocket): Promise<void> {
    const listed = waitForType(ws, 'agents:listed')
    ws.send(JSON.stringify({ type: 'agents:list' }))
    await listed
  }

  it.each([{ label: 'no ID', requestId: undefined }, { label: 'supplied ID', requestId: 'rq-malformed' }])('refuses malformed shutdowns ($label) without delivering them', async ({ requestId }) => {
    const { agent, sessionId } = await registerAgent()
    const caller = await joinAs(sessionId)
    const forwarded: string[] = []
    agent.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string }
      if (frame.type === 'device:shutdown') forwarded.push(frame.type)
    })
    try {
      for (const payload of [{}, { deviceId: 7 }, null, undefined]) {
        caller.send(JSON.stringify({
          type: 'device:shutdown', sessionId,
          ...(requestId === undefined ? {} : { requestId }),
          ...(payload === undefined ? {} : { payload }),
        }))
        await barrier(caller)
        expect(await waitForTypeOrNull<DeviceShutdownError>(caller, 'device:shutdown-error', 0)).toEqual({
          type: 'device:shutdown-error', sessionId, message: 'malformed device:shutdown payload',
          ...(requestId === undefined ? {} : { requestId }),
        })
        await barrier(agent)
        expect(forwarded).toHaveLength(0)
      }

      const delivered = waitForType<DeviceShutdown>(agent, 'device:shutdown')
      caller.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId: 'rq-valid-after-refusal', payload: { deviceId: 'devA' } }))
      expect((await delivered).requestId).toBe('rq-valid-after-refusal')
      const completed = waitForType<DeviceShutdownDone>(caller, 'device:shutdown-done')
      agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, requestId: 'rq-valid-after-refusal', payload: { deviceId: 'devA' } }))
      expect((await completed).requestId).toBe('rq-valid-after-refusal')
      expect(forwarded).toHaveLength(1)
    } finally {
      agent.close(); caller.close()
    }
  })

  it.each(['', null, 7])('drops malformed shutdown envelopes with invalid requestId %p', async (requestId) => {
    const { agent, sessionId } = await registerAgent()
    const caller = await socket()
    const replies: string[] = []
    const forwarded: string[] = []
    caller.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string }
      if (['error', 'device:shutdown-error', 'device:shutdown-done'].includes(frame.type)) replies.push(frame.type)
    })
    agent.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string }
      if (frame.type === 'device:shutdown') forwarded.push(frame.type)
    })
    try {
      caller.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId, payload: {} }))
      await barrier(caller)
      await barrier(agent)
      expect(replies).toHaveLength(0)
      expect(forwarded).toHaveLength(0)

      const delivered = waitForType<DeviceShutdown>(agent, 'device:shutdown')
      caller.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId: 'rq-after-invalid', payload: { deviceId: 'devA' } }))
      expect((await delivered).requestId).toBe('rq-after-invalid')
    } finally {
      agent.close(); caller.close()
    }
  })
})
