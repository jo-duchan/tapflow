import { describe, it, expect } from 'vitest'
import type { DeviceSummary, SessionInfo } from '@/lib/types'
import { classifyResume, GIVE_UP_MS, OWN_TAB_SETTLE_MS, type ResumeTarget } from '@/lib/resumeEntry'

const device = (over: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id: 'dev-1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted', sessionId: 's1', busy: false, ...over })
const mac = (...devices: DeviceSummary[]): SessionInfo[] => [{
  agentName: 'mac-a', capabilities: [], admission: { booting: false, overloaded: false, memoryRefuses: [] }, devices,
}]
const target: ResumeTarget = { sessionId: 's1', deviceId: 'dev-1', since: 0 }

describe('classifyResume', () => {
  it('joins a session waiting for this person', () => {
    expect(classifyResume(mac(device({ resumable: true, releasedAgoMs: 500 })), target, 0).kind).toBe('join')
  })

  // A device someone left running is not this person's to come back to, so a URL does not boot or join it unasked.
  it('asks before starting a device that is not waiting for them, on or off', () => {
    expect(classifyResume(mac(device({ status: 'shutdown' })), target, 0).kind).toBe('restart')
    expect(classifyResume(mac(device()), target, 0).kind).toBe('restart')
  })

  it('waits while another tab of theirs still holds it, then joins once that tab has been gone a while', () => {
    const held = classifyResume(mac(device({ busy: true, heldBySelf: true })), target, 0)
    expect(held).toMatchObject({ kind: 'wait', why: 'own-tab' })

    const seen = { ...target, ownTabSince: 0 }
    // Just freed: the tab that dropped may be reconnecting, and it should win.
    expect(classifyResume(mac(device({ resumable: true, releasedAgoMs: OWN_TAB_SETTLE_MS - 1 })), seen, 1_000).kind).toBe('wait')
    expect(classifyResume(mac(device({ resumable: true, releasedAgoMs: OWN_TAB_SETTLE_MS })), seen, 1_000).kind).toBe('join')
  })

  it('gives up on another tab of theirs that never lets go', () => {
    const seen = { ...target, ownTabSince: 0 }
    // Said as theirs: telling them someone else has it would be false.
    expect(classifyResume(mac(device({ busy: true, heldBySelf: true })), seen, GIVE_UP_MS + 1)).toEqual({ kind: 'in-use', agentName: 'mac-a', self: true })
  })

  it('waits while an AI client borrows their session, rather than joining or calling it someone else\'s', () => {
    const borrowed = device({ busy: true, waiting: { user: 'me@x', name: 'Me', aiHolding: true, yours: true } })
    expect(classifyResume(mac(borrowed), target, 0)).toMatchObject({ kind: 'wait', why: 'ai-holding' })
  })

  it('says who took it', () => {
    expect(classifyResume(mac(device({ endedBy: { by: 'bob@x', name: 'Bob', at: 1 } })), target, 0)).toMatchObject({ kind: 'taken', by: 'bob@x' })
  })

  // An old notice must not hide a session this person can resume now.
  it('resumes over an old notice', () => {
    const both = device({ resumable: true, releasedAgoMs: 500, endedBy: { by: 'bob@x', name: 'Bob', at: 1 } })
    expect(classifyResume(mac(both), target, 0).kind).toBe('join')
  })

  it('leaves someone else\'s session alone, held or waiting', () => {
    expect(classifyResume(mac(device({ busy: true })), target, 0).kind).toBe('in-use')
    expect(classifyResume(mac(device({ waiting: { user: 'bob@x', name: 'Bob', remainingMs: 60_000 } })), target, 0).kind).toBe('others')
  })

  describe('a session not in the listing', () => {
    it('waits for a Mac that may be reconnecting', () => {
      expect(classifyResume(mac(), target, GIVE_UP_MS)).toMatchObject({ kind: 'wait', why: 'mac-away' })
    })

    it('stops waiting after a while', () => {
      expect(classifyResume(mac(), target, GIVE_UP_MS + 1).kind).toBe('gone')
    })

    // Back after its agent's window ran out: the same device, under a new session id.
    it('offers to start the same device again when it comes back under a new session', () => {
      expect(classifyResume(mac(device({ sessionId: 's2' })), target, 0)).toMatchObject({ kind: 'restart', device: { sessionId: 's2' } })
    })
  })
})
