import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForMessage = (ws: WebSocket) =>
  new Promise<RelayMessage>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  )

// Minimal stand-in for a ws socket — only the surface runHeartbeat() touches.
type MockSocket = { readyState: number; ping: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
const makeSock = (readyState: number = WebSocket.OPEN): MockSocket => ({
  readyState,
  ping: vi.fn(),
  terminate: vi.fn(),
})

// Internal surface poked by these tests (mirrors the `as unknown as {...}` idiom in RelayServer.test.ts).
type HeartbeatInternals = {
  wss: WebSocketServer
  wsAlive: WeakMap<object, boolean>
  heartbeatTimer: ReturnType<typeof setInterval> | null
  runHeartbeat: (clients?: Iterable<unknown>) => void
}
const internals = (server: RelayServer) => server as unknown as HeartbeatInternals

const sweep = (server: RelayServer, socks: MockSocket[]) => internals(server).runHeartbeat(socks)
const setAlive = (server: RelayServer, sock: MockSocket, alive: boolean) =>
  internals(server).wsAlive.set(sock, alive)

describe('RelayServer — WebSocket heartbeat (#313)', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-hb-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  describe('runHeartbeat sweep (mock sockets)', () => {
    let server: RelayServer

    beforeEach(async () => {
      server = new RelayServer({ port: 0 })
      await server.start()
    })

    afterEach(async () => {
      await server.stop()
    })

    it('terminates a socket that missed the previous pong window', () => {
      const sock = makeSock()
      setAlive(server, sock, true)

      // 1st sweep: alive → mark dead, ping (probe).
      sweep(server, [sock])
      expect(sock.terminate).not.toHaveBeenCalled()
      expect(sock.ping).toHaveBeenCalledTimes(1)

      // No pong arrived → still marked dead. 2nd sweep: terminate, no further ping.
      sweep(server, [sock])
      expect(sock.terminate).toHaveBeenCalledTimes(1)
      expect(sock.ping).toHaveBeenCalledTimes(1)
    })

    it('keeps a socket that ponged between sweeps', () => {
      const sock = makeSock()
      setAlive(server, sock, true)

      sweep(server, [sock]) // probe 1, marks dead
      setAlive(server, sock, true) // pong handler would do this
      sweep(server, [sock]) // alive again → survives, probe 2

      expect(sock.terminate).not.toHaveBeenCalled()
      expect(sock.ping).toHaveBeenCalledTimes(2)
    })

    it('probes every client regardless of role (agent/browser/stream all in wss.clients)', () => {
      const agent = makeSock()
      const browser = makeSock()
      const stream = makeSock()
      for (const s of [agent, browser, stream]) setAlive(server, s, true)

      sweep(server, [agent, browser, stream])

      for (const s of [agent, browser, stream]) {
        expect(s.terminate).not.toHaveBeenCalled()
        expect(s.ping).toHaveBeenCalledTimes(1)
      }
    })

    it('does not ping a non-OPEN socket (avoids ws throw)', () => {
      const connecting = makeSock(WebSocket.CONNECTING)
      const closing = makeSock(WebSocket.CLOSING)
      setAlive(server, connecting, true)
      setAlive(server, closing, true)

      sweep(server, [connecting, closing])

      expect(connecting.ping).not.toHaveBeenCalled()
      expect(closing.ping).not.toHaveBeenCalled()
    })

    it('does not terminate a freshly-connected socket on its first sweep (unseeded)', () => {
      const fresh = makeSock() // never marked alive (just connected, no entry yet)

      sweep(server, [fresh])

      expect(fresh.terminate).not.toHaveBeenCalled()
      expect(fresh.ping).toHaveBeenCalledTimes(1)
    })
  })

  describe('integration — real sockets', () => {
    let server: RelayServer
    let port: number

    beforeEach(async () => {
      server = new RelayServer({ port: 0 })
      await server.start()
      port = (server.address() as { port: number }).port
    })

    afterEach(async () => {
      await server.stop()
    })

    it('terminates a dead agent socket and evicts its sessions (terminate → existing close cleanup)', async () => {
      const agent = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', agentName: 'DeadMac', devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agent) // agent:registered

      const closed = new Promise<void>((resolve) => agent.on('close', () => resolve()))

      // Force the server-side socket to look dead, then run a real sweep.
      const serverWs = [...internals(server).wss.clients][0]
      internals(server).wsAlive.set(serverWs, false)
      internals(server).runHeartbeat()

      await closed // terminate() fired the close handler

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      await vi.waitFor(async () => {
        observer.send(JSON.stringify({ type: 'agents:list' }))
        const listed = await waitForMessage(observer)
        expect(listed.sessions).toHaveLength(0)
      }, { timeout: 2000 })
      observer.close()
    })

    it('keeps a live agent connected across heartbeats (real auto-pong)', async () => {
      const agent = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', agentName: 'LiveMac', devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agent)

      let closedUnexpectedly = false
      agent.on('close', () => { closedUnexpectedly = true })

      internals(server).runHeartbeat() // probe → marks dead, sends ping
      await new Promise<void>((r) => setTimeout(r, 50)) // client auto-pongs over loopback
      internals(server).runHeartbeat() // pong revived it → survives

      expect(closedUnexpectedly).toBe(false)
      expect(agent.readyState).toBe(WebSocket.OPEN)

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage(observer)
      expect(listed.sessions!.filter((s) => s.agentName === 'LiveMac')).toHaveLength(1)

      agent.close()
      observer.close()
    })
  })

  describe('lifecycle', () => {
    it('stop() clears the heartbeat timer', async () => {
      const server = new RelayServer({ port: 0 })
      await server.start()
      expect(internals(server).heartbeatTimer).not.toBeNull() // started by start()
      await server.stop()
      expect(internals(server).heartbeatTimer).toBeNull()
    })
  })
})
