import { describe, it, expect } from 'vitest'
import { SessionManager } from '../SessionManager'
import type { WebSocket } from 'ws'

const mockSocket = () => ({} as WebSocket)
const OPEN = 1

describe('SessionManager', () => {
  describe('create()', () => {
    it('returns an empty array when no devices given', () => {
      const sm = new SessionManager()
      const ids = sm.create(mockSocket(), [])
      expect(ids).toEqual([])
    })

    it('creates one session per device and returns sessionIds', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const devices = [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ]
      const ids = sm.create(ws, devices)
      expect(ids).toHaveLength(2)
      expect(typeof ids[0]).toBe('string')
      expect(typeof ids[1]).toBe('string')
      expect(ids[0]).not.toBe(ids[1])
    })

    it('each session stores the correct deviceId', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const devices = [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ]
      const [idA, idB] = sm.create(ws, devices)
      expect(sm.get(idA)?.deviceId).toBe('devA')
      expect(sm.get(idB)?.deviceId).toBe('devB')
    })

    it('sessions share the same agentSocket', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [idA, idB] = sm.create(ws, [
        { id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' },
      ])
      expect(sm.get(idA)?.agentSocket).toBe(ws)
      expect(sm.get(idB)?.agentSocket).toBe(ws)
    })

    it('new sessions start with null browserSocket and streamSocket', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const s = sm.get(id)!
      expect(s.browserSocket).toBeNull()
      expect(s.streamSocket).toBeNull()
    })
  })

  describe('get()', () => {
    it('returns undefined for unknown sessionId', () => {
      const sm = new SessionManager()
      expect(sm.get('unknown')).toBeUndefined()
    })

    it('retrieves a created session', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [id] = sm.create(ws, [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      expect(sm.get(id)?.agentSocket).toBe(ws)
    })
  })

  describe('getAllByAgentSocket()', () => {
    it('returns all sessions for a given agent socket', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const ids = sm.create(ws, [
        { id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' },
      ])
      const found = sm.getAllByAgentSocket(ws)
      expect(found).toHaveLength(2)
      expect(found.map((s) => s.id).sort()).toEqual(ids.sort())
    })

    it('returns empty array for an unknown socket', () => {
      const sm = new SessionManager()
      expect(sm.getAllByAgentSocket(mockSocket())).toEqual([])
    })

    it('does not return sessions from other agents', () => {
      const sm = new SessionManager()
      const wsA = mockSocket()
      const wsB = mockSocket()
      sm.create(wsA, [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }])
      sm.create(wsB, [{ id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' }])
      expect(sm.getAllByAgentSocket(wsA)).toHaveLength(1)
      expect(sm.getAllByAgentSocket(wsB)).toHaveLength(1)
    })
  })

  describe('getByStreamSocket()', () => {
    it('returns undefined when no stream socket registered', () => {
      const sm = new SessionManager()
      expect(sm.getByStreamSocket(mockSocket())).toBeUndefined()
    })

    it('returns the session after setStreamSocket()', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const streamWs = mockSocket()
      sm.setStreamSocket(id, streamWs)
      expect(sm.getByStreamSocket(streamWs)?.id).toBe(id)
    })
  })

  describe('join()', () => {
    it('sets browserSocket on the session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const browserWs = mockSocket()
      sm.join(id, browserWs)
      expect(sm.get(id)?.browserSocket).toBe(browserWs)
    })

    it('throws when session is not found', () => {
      const sm = new SessionManager()
      expect(() => sm.join('bad-id', mockSocket())).toThrow('Session not found: bad-id')
    })

    it('throws when session is busy (browserSocket is OPEN)', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const busyWs = { readyState: OPEN } as WebSocket
      sm.join(id, busyWs)
      expect(() => sm.join(id, mockSocket())).toThrow('Session busy')
    })
  })

  describe('remove()', () => {
    it('removes a session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.remove(id)
      expect(sm.get(id)).toBeUndefined()
    })
  })

  describe('clearBrowser()', () => {
    it('sets browserSocket to null', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      sm.clearBrowser(id)
      expect(sm.get(id)?.browserSocket).toBeNull()
    })
  })

  describe('updateDeviceStatus()', () => {
    it('updates deviceStatus on the session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.updateDeviceStatus(id, 'booted')
      expect(sm.get(id)?.deviceStatus).toBe('booted')
    })
  })

  describe('list()', () => {
    it('returns empty array when no sessions', () => {
      const sm = new SessionManager()
      expect(sm.list()).toEqual([])
    })

    it('groups devices by agent into one SessionInfo', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ], 'MyMac')
      const listed = sm.list()
      expect(listed).toHaveLength(1)
      expect(listed[0].agentName).toBe('MyMac')
      expect(listed[0].devices).toHaveLength(2)
    })

    it('includes sessionId on each device', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [idA] = sm.create(ws, [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }])
      const listed = sm.list()
      expect(listed[0].devices[0].sessionId).toBe(idA)
    })

    it('reflects busy=true when browserSocket is set', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      expect(sm.list()[0].devices[0].busy).toBe(true)
    })

    it('reflects busy=false when browserSocket is null', () => {
      const sm = new SessionManager()
      sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      expect(sm.list()[0].devices[0].busy).toBe(false)
    })

    it('separates sessions from different agents', () => {
      const sm = new SessionManager()
      sm.create(mockSocket(), [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }], 'Mac1')
      sm.create(mockSocket(), [{ id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' }], 'Mac2')
      const listed = sm.list()
      expect(listed).toHaveLength(2)
    })
  })
})
