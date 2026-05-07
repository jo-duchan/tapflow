import { describe, it, expect } from 'vitest'
import { SessionManager } from '../SessionManager'
import type { WebSocket } from 'ws'

const mockSocket = () => ({} as WebSocket)

describe('SessionManager', () => {
  it('creates a session and returns a string id', () => {
    const sm = new SessionManager()
    const id = sm.create(mockSocket())
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('retrieves a created session', () => {
    const sm = new SessionManager()
    const ws = mockSocket()
    const id = sm.create(ws)
    const session = sm.get(id)
    expect(session?.agentSocket).toBe(ws)
    expect(session?.browserSocket).toBeNull()
  })

  it('returns undefined for unknown session id', () => {
    const sm = new SessionManager()
    expect(sm.get('unknown')).toBeUndefined()
  })

  it('joins a browser socket to a session', () => {
    const sm = new SessionManager()
    const browserWs = mockSocket()
    const id = sm.create(mockSocket())
    sm.join(id, browserWs)
    expect(sm.get(id)?.browserSocket).toBe(browserWs)
  })

  it('throws when joining a non-existent session', () => {
    const sm = new SessionManager()
    expect(() => sm.join('bad-id', mockSocket())).toThrow('Session not found: bad-id')
  })

  it('removes a session', () => {
    const sm = new SessionManager()
    const id = sm.create(mockSocket())
    sm.remove(id)
    expect(sm.get(id)).toBeUndefined()
  })

  it('finds a session by agent socket', () => {
    const sm = new SessionManager()
    const ws = mockSocket()
    const id = sm.create(ws)
    expect(sm.getBySocket(ws)?.id).toBe(id)
  })

  it('finds a session by browser socket', () => {
    const sm = new SessionManager()
    const agentWs = mockSocket()
    const browserWs = mockSocket()
    const id = sm.create(agentWs)
    sm.join(id, browserWs)
    expect(sm.getBySocket(browserWs)?.id).toBe(id)
  })

  it('returns undefined when socket is not in any session', () => {
    const sm = new SessionManager()
    expect(sm.getBySocket(mockSocket())).toBeUndefined()
  })
})
