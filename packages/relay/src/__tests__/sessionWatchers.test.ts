import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import crypto from 'crypto'
import { signJwt, hashPat } from '../middleware/auth'
import { initDb, closeDb, getDb } from '../db'
import { config } from '../lib/config'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type {
  AgentRegistered, AgentsListed, DeviceShutdownError, GenericError, InputError, SessionJoined,
  WatchAction, WatchEnded, WatchRefused,
} from '@tapflowio/protocol'

// Every keyframe-aware sender the relay makes, and every socket each one ever wrote to. The relay's own
// import is wrapped rather than replaced, so frames still flow exactly as in production.
const senders: { sockets: Set<unknown> }[] = []
vi.mock('@tapflowio/agent-core/utils', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@tapflowio/agent-core/utils')>()
  return {
    ...orig,
    createKeyframeAwareSender: () => {
      const inner = orig.createKeyframeAwareSender()
      const record = { sockets: new Set<unknown>() }
      senders.push(record)
      return {
        send: (ws: Parameters<typeof inner.send>[0], ...rest: unknown[]) => {
          record.sockets.add(ws)
          return (inner.send as (...a: unknown[]) => boolean)(ws, ...rest)
        },
      }
    },
  }
})

const { RelayServer } = await import('../RelayServer')
const { writeEnvelopeHeader, CODEC_AUDIO } = await import('@tapflowio/agent-core/utils')

/**
 * **A teammate watches, read-only, the device an AI client is driving.** Each case below is a row of the
 * A1 invariant table: what the watcher sees, and — the half that matters more — that the holder sees no
 * difference at all.
 */
describe('session watchers', () => {
  let server: InstanceType<typeof RelayServer>
  let port: number
  let tmpDir: string
  const GRACE = 150

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-watchers-'))
    initDb(path.join(tmpDir, 'test.db'))
    for (const id of [1, 2]) {
      getDb().prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'QA', 'x')").run(id, `u${id}@example.test`)
    }
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })

  beforeEach(async () => {
    senders.length = 0
    server = new RelayServer({ port: 0, agentGraceMs: GRACE })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  /** `name` must differ between agents in one test: the same name re-registering is a restart, and the
   *  relay rebinds the first agent's session to it. */
  async function registerAgent(name = 'mac', capabilities?: string[]) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name, ...(capabilities ? { capabilities } : {}),
      devices: [{ id: 'dev0', name: 'iPhone', platform: 'ios', status: 'shutdown' }],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions[0]!.sessionId
    const stream = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(stream)
    stream.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForType(stream, 'stream:registered')
    const fromAgent: Record<string, unknown>[] = []
    agent.on('message', (d, isBinary) => { if (!isBinary) fromAgent.push(JSON.parse(d.toString())) })
    return { agent, stream, sessionId, fromAgent }
  }

  /** `userId` signs a cookie — the credential that may watch. Without one this is a loopback socket with
   *  no credential, which is what a local MCP server is. */
  async function socket(client?: string, userId?: number) {
    const url = new URL(`ws://localhost:${port}`)
    if (client) url.searchParams.set('client', client)
    const headers = userId === undefined
      ? undefined
      : { cookie: `tapflow_token=${signJwt({ userId, email: `u${userId}@example.test`, role: 'QA' })}` }
    const ws = new WebSocket(url.toString(), { headers })
    const binary: Buffer[] = []
    ws.on('message', (d, isBinary) => { if (isBinary) binary.push(d as Buffer) })
    await waitForOpen(ws)
    return Object.assign(ws, { binary })
  }

  async function join(ws: WebSocket, sessionId: string, clientKind?: 'mcp' | 'flow-runner' | 'dashboard') {
    ws.send(JSON.stringify({ type: 'session:start', sessionId, ...(clientKind ? { clientKind } : {}) }))
    return waitForType<SessionJoined>(ws, 'session:joined')
  }

  async function watch(ws: WebSocket, sessionId: string) {
    ws.send(JSON.stringify({ type: 'watch:start', sessionId }))
    const started = waitForType(ws, 'watch:started')
    const refused = waitForType<WatchRefused>(ws, 'watch:refused')
    return Promise.race([started.then(() => null), refused])
  }

  const jpeg = () => writeEnvelopeHeader(Buffer.from([0xff, 0xd8]), Date.now())

  /** Send a frame, and wait until it has reached `first`. The relay writes one frame to every recipient
   *  in the same turn, so after that a round-trip on any other recipient (`settle`) proves its copy — or
   *  the absence of one — has already been decided. */
  async function frame(stream: WebSocket, buf: Buffer, first: WebSocket & { binary: Buffer[] }) {
    const before = first.binary.length
    stream.send(buf)
    const deadline = Date.now() + 2000
    while (first.binary.length === before) {
      if (Date.now() > deadline) throw new Error('frame never reached the first recipient')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  async function settle(...sockets: WebSocket[]) { for (const s of sockets) await barrier(s) }

  it('streams to a signed-in watcher of an MCP session, and to the holder as before', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    expect(await watch(viewer, sessionId)).toBeNull()

    await frame(stream, jpeg(), mcp)
    await settle(viewer)
    expect(mcp.binary).toHaveLength(1)
    expect(viewer.binary).toHaveLength(1)
  })

  // Mutation: reuse the session's sender for watchers. A slow watcher would then put the holder into
  // drop-to-keyframe too. Pinned as the invariant itself — no sender writes to two sockets — because
  // `bufferedAmount` cannot be driven from a test.
  it('gives every recipient its own sender', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const a = await socket(undefined, 1)
    const b = await socket(undefined, 2)
    await watch(a, sessionId)
    await watch(b, sessionId)
    await frame(stream, jpeg(), mcp)
    await settle(a, b)
    expect(senders.length).toBeGreaterThanOrEqual(3)
    for (const s of senders) expect(s.sockets.size).toBeLessThanOrEqual(1)
  })

  it('keeps audio for the holder alone', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    await frame(stream, writeEnvelopeHeader(Buffer.alloc(64), Date.now(), { codec: CODEC_AUDIO }), mcp)
    await settle(viewer)
    expect(mcp.binary).toHaveLength(1)
    expect(viewer.binary).toHaveLength(0)
  })

  // X1: a holder that does not read the stream asks for none (`stream: false`), and watchers are unaffected.
  async function joinWithoutStream(ws: WebSocket, sessionId: string, clientKind: 'mcp' | 'flow-runner' = 'mcp') {
    ws.send(JSON.stringify({ type: 'session:start', sessionId, clientKind, stream: false }))
    return waitForType<SessionJoined>(ws, 'session:joined')
  }

  it('sends a holder that asked for no stream neither video nor audio, and its watcher both as before', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    await frame(stream, jpeg(), viewer)
    stream.send(writeEnvelopeHeader(Buffer.alloc(64), Date.now(), { codec: CODEC_AUDIO }))
    await barrier(stream)
    await settle(mcp, viewer)
    expect(mcp.binary).toHaveLength(0)
    expect(viewer.binary).toHaveLength(1)
  })

  it('sends the stream again once the holder re-joins without the flag', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    await join(mcp, sessionId, 'mcp')
    await frame(stream, jpeg(), mcp)
    expect(mcp.binary).toHaveLength(1)
  })

  it('keeps the holder off the stream across an agent restart', async () => {
    const first = await registerAgent()
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, first.sessionId)
    const viewer = await socket(undefined, 1)
    await watch(viewer, first.sessionId)
    first.agent.close()
    await waitForType(mcp, 'session:agent-away')
    const second = await registerAgent()
    expect(second.sessionId).toBe(first.sessionId)
    await frame(second.stream, jpeg(), viewer)
    await settle(mcp)
    expect(mcp.binary).toHaveLength(0)
  })

  it('asks the agent for no keyframe when a holder that takes no stream joins a live device', async () => {
    const { agent, sessionId, fromAgent } = await registerAgent()
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await barrier(agent)
    const mcp = await socket('mcp1')
    await joinWithoutStream(mcp, sessionId)
    await barrier(mcp)
    await barrier(agent)
    expect(fromAgent.filter((m) => m['type'] === 'stream:request-idr')).toHaveLength(0)
    const other = await socket('mcp2')
    mcp.close()
    await new Promise((r) => mcp.once('close', r))
    await join(other, sessionId, 'mcp')
    await barrier(agent)
    expect(fromAgent.filter((m) => m['type'] === 'stream:request-idr').length).toBeGreaterThan(0)
  })

  // ── A2: what the holder does, told to its watchers ──────────────────────────────────────────────────
  /** A watched MCP session, and every frame its watcher receives, raw. */
  async function watched(capabilities?: string[]) {
    const { sessionId, agent, fromAgent } = await registerAgent('mac', capabilities)
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    const raw: string[] = []
    viewer.on('message', (d, isBinary) => { if (!isBinary) raw.push(d.toString()) })
    const actions = () => raw.map((r) => JSON.parse(r) as { type: string }).filter((m): m is WatchAction => m.type === 'watch:action').map((m) => m.action)
    const send = (msg: Record<string, unknown>) => mcp.send(JSON.stringify({ sessionId, ...msg }))
    const settled = async () => { await barrier(mcp); await barrier(agent); await barrier(viewer) }
    return { sessionId, agent, fromAgent, mcp, viewer, raw, actions, send, settled }
  }

  it('tells a watcher the holder tapped, and where', async () => {
    const w = await watched()
    w.send({ type: 'input:touch:start', payload: { x: 0.5, y: 0.8 } })
    w.send({ type: 'input:touch:end', requestId: 'r1', payload: { x: 0.505, y: 0.8 } })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'tap', x: 0.5, y: 0.8 }])
  })

  // A client leaving mid-gesture sends a cancel, then an end (#1115). An agent that cancels injects nothing for that
  // end, so the watcher is told nothing; one that predates the cancel completes the gesture with it, a real tap.
  it('tells nothing for a touch the holder cancelled, where the agent cancels', async () => {
    const w = await watched(['touch-cancel'])
    w.send({ type: 'input:touch:start', payload: { x: 0.5, y: 0.8 } })
    w.send({ type: 'input:touch:cancel' })
    w.send({ type: 'input:touch:end', requestId: 'r1', payload: { x: 0.5, y: 0.8 } })
    await w.settled()
    expect(w.actions()).toEqual([])
    expect(w.fromAgent.map((m) => m['type'])).toContain('input:touch:cancel')
  })

  it('tells the tap an agent without cancel made of a cancelled touch', async () => {
    const w = await watched()
    w.send({ type: 'input:touch:start', payload: { x: 0.5, y: 0.8 } })
    w.send({ type: 'input:touch:cancel' })
    w.send({ type: 'input:touch:end', requestId: 'r1', payload: { x: 0.5, y: 0.8 } })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'tap', x: 0.5, y: 0.8 }])
  })

  it('tells a drag as one swipe at its end, not a frame per move', async () => {
    const w = await watched()
    w.send({ type: 'input:touch:start', payload: { x: 0.5, y: 0.8 } })
    for (const y of [0.75, 0.7, 0.6, 0.5, 0.4, 0.3]) w.send({ type: 'input:touch:move', payload: { x: 0.5, y } })
    w.send({ type: 'input:touch:end', requestId: 'r1' })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.3] }])
  })

  it('tells typing as a count, and never puts the text on a watcher\'s wire', async () => {
    const w = await watched()
    w.send({ type: 'input:type', requestId: 'r1', payload: { text: 'hunter2🔑' } })
    await w.settled()
    // The action arrived — so its absence below is the text's, not the frame's.
    expect(w.actions()).toEqual([{ kind: 'type', chars: 8 }])
    expect(w.raw.join('\n')).not.toContain('hunter2')
  })

  it('names a key unless it types a character, and a button once per press', async () => {
    const w = await watched()
    w.send({ type: 'input:key', requestId: 'r1', payload: { code: 'Enter' } })
    w.send({ type: 'input:key', requestId: 'r2', payload: { code: 'KeyP' } })
    w.send({ type: 'input:button', requestId: 'r3', payload: { name: 'home', phase: 'down' } })
    w.send({ type: 'input:button', requestId: 'r4', payload: { name: 'home', phase: 'up' } })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'key', key: 'Enter' }, { kind: 'key', key: 'character' }, { kind: 'button', button: 'home' }])
    expect(w.raw.join('\n')).not.toContain('KeyP')
  })

  it('tells an opened URL without the URL', async () => {
    const w = await watched()
    w.send({ type: 'open-url', requestId: 'r1', payload: { url: 'myapp://reset?token=s3cret' } })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'open-url' }])
    expect(w.raw.join('\n')).not.toContain('s3cret')
  })

  it('passes the holder\'s own label on, and nobody else\'s', async () => {
    const w = await watched()
    w.send({ type: 'session:activity', label: '  step 3: tapOn("Sign in")  ' })
    const other = await socket('mcp2')
    other.send(JSON.stringify({ type: 'session:activity', sessionId: w.sessionId, label: 'not mine' }))
    await barrier(other)
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'label', label: 'step 3: tapOn("Sign in")' }])
  })

  it('tells a watcher nothing about an input the relay did not pass on', async () => {
    const w = await watched()
    const other = await socket('mcp2')
    other.send(JSON.stringify({ type: 'input:touch:start', sessionId: w.sessionId, payload: { x: 0.1, y: 0.1 } }))
    other.send(JSON.stringify({ type: 'input:touch:end', sessionId: w.sessionId, requestId: 'x1', payload: { x: 0.1, y: 0.1 } }))
    await waitForType(other, 'input:error')
    await w.settled()
    expect(w.actions()).toEqual([])
  })

  it('names no character a numpad or punctuation key types', async () => {
    const w = await watched()
    const codes = ['NumpadComma', 'NumpadEqual', 'NumpadParenLeft', 'NumpadParenRight', 'NumpadHash', 'NumpadStar', 'Digit7', 'Period']
    for (const [i, code] of codes.entries()) {
      w.send({ type: 'input:key', requestId: `k${i}`, payload: { code } })
    }
    await w.settled()
    expect(w.actions()).toEqual(Array(codes.length).fill({ kind: 'key', key: 'character' }))
  })

  it('does not end a touch the holder began before it joined again', async () => {
    const w = await watched()
    w.send({ type: 'input:touch:start', payload: { x: 0.1, y: 0.1 } })
    await join(w.mcp, w.sessionId, 'mcp')
    w.send({ type: 'input:touch:end', requestId: 'r1', payload: { x: 0.9, y: 0.9 } })
    await w.settled()
    expect(w.actions()).toEqual([{ kind: 'tap', x: 0.9, y: 0.9 }])
  })

  it('remembers a touch that began before anyone watched', async () => {
    const { sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    mcp.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 0.2, y: 0.9 } }))
    await barrier(mcp)
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    const action = waitForType<WatchAction>(viewer, 'watch:action')
    mcp.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'r1', payload: { x: 0.2, y: 0.3 } }))
    expect((await action).action).toEqual({ kind: 'swipe', from: [0.2, 0.9], to: [0.2, 0.3] })
  })

  it('refuses a watcher\'s input, and nothing reaches the agent', async () => {
    const { sessionId, agent, fromAgent } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    viewer.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'r1' }))
    const err = await waitForType<InputError>(viewer, 'input:error')
    expect(err.reason).toBe('not-session-owner')
    await settle(agent)
    expect(fromAgent.filter((m) => String(m['type']).startsWith('input:'))).toEqual([])
  })

  it('describes the device to watchers, and keeps the holder\'s replies to the holder', async () => {
    const { sessionId, agent } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    agent.send(JSON.stringify({ type: 'device:booting', sessionId }))
    agent.send(JSON.stringify({ type: 'input:done', sessionId, requestId: 'r1' }))
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(viewer, 'device:booting')
    await waitForType(viewer, 'device:ready')
    await waitForType(mcp, 'input:done')
    expect(await waitForTypeOrNull(viewer, 'input:done', 100)).toBeNull()
  })

  // The holder's reconnect grace: the session is unheld, `mayShutDown` would pass anyone, and a watch page
  // that sent `session:start` would take the device.
  it('refuses a watcher\'s shutdown and join while the holder is away, and the holder comes back', async () => {
    const { sessionId, agent, fromAgent } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    mcp.close()
    await waitForType(viewer, 'watch:holder-left')

    viewer.send(JSON.stringify({ type: 'device:shutdown', sessionId, requestId: 'r1', payload: { deviceId: 'dev0' } }))
    expect((await waitForType<DeviceShutdownError>(viewer, 'device:shutdown-error')).requestId).toBe('r1')
    viewer.send(JSON.stringify({ type: 'session:start', sessionId }))
    expect((await waitForType<GenericError>(viewer, 'error')).reason).toBe('session-busy')
    await settle(agent)
    expect(fromAgent.filter((m) => m['type'] === 'device:shutdown')).toEqual([])

    const back = await socket('mcp1')
    await join(back, sessionId, 'mcp')
    expect(await waitForTypeOrNull(viewer, 'watch:ended', 100)).toBeNull()
  })

  // Mutation: gate forwarding on the holder again. The watcher's picture would freeze for every blip of
  // the agent's socket, which is when a teammate most wants to see what is happening.
  it('keeps streaming to watchers while the holder is away', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    mcp.close()
    await waitForType(viewer, 'watch:holder-left')
    await frame(stream, jpeg(), viewer)
    expect(viewer.binary).toHaveLength(1)
  })

  // A watch is admitted against one client's session. Another client binding it is a different session as
  // far as the watcher is concerned — a person's manual one, here.
  it('ends the watch when a different client takes the session', async () => {
    const { sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    mcp.close()
    await waitForType(viewer, 'watch:holder-left')
    const tester = await socket('tab', 2)
    await join(tester, sessionId, 'dashboard')
    expect((await waitForType<WatchEnded>(viewer, 'watch:ended')).reason).toBe('holder-changed')
  })

  // The same client, re-joining as something that is not an AI client, is no longer a session that may be
  // watched — the kind is what admitted the watch, not only the client.
  it('ends the watch when the holder re-joins as a non-AI client', async () => {
    const { sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    await join(mcp, sessionId, 'dashboard')
    expect((await waitForType<WatchEnded>(viewer, 'watch:ended')).reason).toBe('holder-changed')
  })

  // A flow run finishing, an MCP `disconnect_device`: the holder is done, not dropped. Mutation: send
  // `watch:holder-left` here again — every finished CI run then leaves its watcher waiting forever.
  it('ends the watch when the holder leaves on purpose', async () => {
    const { sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    mcp.send(JSON.stringify({ type: 'session:leave', sessionId }))
    expect((await waitForType<WatchEnded>(viewer, 'watch:ended')).reason).toBe('session-ended')
  })

  it('ends the watch when the session ends', async () => {
    const { sessionId, agent } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const viewer = await socket(undefined, 1)
    await watch(viewer, sessionId)
    agent.close()
    await waitForType(viewer, 'session:agent-away')
    expect((await waitForType<WatchEnded>(viewer, 'watch:ended')).reason).toBe('session-ended')
  })

  it('leaves the holder and the other watchers alone when one watcher goes', async () => {
    const { stream, sessionId } = await registerAgent()
    const mcp = await socket('mcp1')
    await join(mcp, sessionId, 'mcp')
    const a = await socket(undefined, 1)
    const b = await socket(undefined, 2)
    await watch(a, sessionId)
    await watch(b, sessionId)
    a.close()
    await new Promise((r) => a.once('close', r))
    await frame(stream, jpeg(), mcp)
    await settle(b)
    expect(mcp.binary).toHaveLength(1)
    expect(b.binary).toHaveLength(1)
    mcp.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'r2' }))
    expect(await waitForTypeOrNull(mcp, 'input:error', 100)).toBeNull()
  })

  describe('who may watch what', () => {
    it('refuses a person\'s session', async () => {
      const { sessionId } = await registerAgent()
      const tester = await socket('tab', 2)
      await join(tester, sessionId, 'dashboard')
      expect((await watch(await socket(undefined, 1), sessionId))?.reason).toBe('not-watchable')
    })

    it('refuses a holder that declared nothing — an older client', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('old'), sessionId)
      expect((await watch(await socket(undefined, 1), sessionId))?.reason).toBe('not-watchable')
    })

    // A page in any browser on the relay's Mac reaches loopback with no credential.
    it('refuses an unauthenticated loopback socket', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('mcp1'), sessionId, 'mcp')
      expect((await watch(await socket(), sessionId))?.reason).toBe('not-permitted')
    })

    // The other credential that may watch. Every socket above is loopback, so this is the one path through
    // `mayWatch` that reads the PAT — dropping that disjunct, or its `view` check, survived the suite without it.
    it('admits a remote socket on a view token', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('mcp1'), sessionId, 'mcp')
      const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
      getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
        .run(1, 'watch', hashPat(raw), 'view')
      const remote = vi.spyOn(server as unknown as { remoteAddressOf: () => string }, 'remoteAddressOf')
        .mockReturnValue('192.168.0.99')
      const ws = new WebSocket(`ws://localhost:${port}`, { headers: { authorization: `Bearer ${raw}` } })
      await waitForOpen(ws)
      remote.mockRestore()
      expect(await watch(ws, sessionId)).toBeNull()
    })

    // A holder that could otherwise watch — signed in — so the refusal is about holding, not about the credential.
    it('refuses the holder watching its own session', async () => {
      const { sessionId } = await registerAgent()
      const mcp = await socket('mcp1', 1)
      await join(mcp, sessionId, 'mcp')
      expect((await watch(mcp, sessionId))?.reason).toBe('not-watchable')
    })

    it('refuses an unknown session', async () => {
      expect((await watch(await socket(undefined, 1), 'nope'))?.reason).toBe('session-not-found')
    })

    it('caps the watchers of one session', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('mcp1'), sessionId, 'mcp')
      for (let i = 0; i < 4; i++) expect(await watch(await socket(undefined, 1), sessionId)).toBeNull()
      expect((await watch(await socket(undefined, 1), sessionId))?.reason).toBe('watchers-full')
    })
  })

  describe('what the holder and the device list are told', () => {
    it('hands an AI holder the watch page at the team\'s address, and a person none', async () => {
      const was = config.relay.url
      config.relay.url = 'https://relay.example.test'
      try {
        const { sessionId } = await registerAgent()
        const joined = await join(await socket('mcp1'), sessionId, 'mcp')
        expect(joined.watchUrl).toBe(`https://relay.example.test/automation/sessions/${sessionId}`)
        const other = await registerAgent('other-mac')
        expect((await join(await socket('tab', 2), other.sessionId, 'dashboard')).watchUrl).toBeUndefined()
      } finally {
        config.relay.url = was
      }
    })

    // The invite rule: localhost is not an address a teammate can open, so the relay says nothing and the
    // client builds the link from the address it dialled. Mutation: drop the `forTeammates` gate.
    it('leaves the link out when it knows no address a teammate can open', async () => {
      const was = config.relay.url
      config.relay.url = 'ws://localhost:4000'
      try {
        const { sessionId } = await registerAgent()
        expect((await join(await socket('mcp1'), sessionId, 'mcp')).watchUrl).toBeUndefined()
      } finally {
        config.relay.url = was
      }
    })

    // The holder's owner key is `<user>:<client>`, and a local socket that learned the client half could
    // claim it and drive the device. The list says who, never which client.
    it('names an AI holder in the device list without its client id', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('secret-client-id'), sessionId, 'mcp')
      const asker = await socket(undefined, 1)
      asker.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType<AgentsListed>(asker, 'agents:listed')
      const device = listed.sessions.flatMap((s) => s.devices).find((d) => d.sessionId === sessionId)
      expect(device?.holder).toEqual({ kind: 'mcp', user: 'local' })
      expect(JSON.stringify(listed)).not.toContain('secret-client-id')
    })

    it('names nobody for a person\'s session', async () => {
      const { sessionId } = await registerAgent()
      await join(await socket('tab', 2), sessionId, 'dashboard')
      const asker = await socket(undefined, 1)
      asker.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType<AgentsListed>(asker, 'agents:listed')
      expect(listed.sessions.flatMap((s) => s.devices).find((d) => d.sessionId === sessionId)?.holder).toBeUndefined()
    })
  })
})
