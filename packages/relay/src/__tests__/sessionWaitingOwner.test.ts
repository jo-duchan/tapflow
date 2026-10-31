import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../SessionManager'
import type { WebSocket } from 'ws'
import type { DeviceSummary } from '@tapflowio/protocol'

/**
 * **A person whose connection dropped is remembered for as long as the device waits for them** (#1087).
 *
 * The relay already kept the device up for `IDLE_TIMEOUT_MS` after a holder's socket went, but forgot who that was:
 * the owner fields are cleared on release, so the person coming back from another browser looked like anyone else,
 * and a teammate picking the device had no way to know it was someone's. These tests hold what the listing says to
 * each asker, and when the memory ends.
 */
const OPEN = 1
const IDLE = 60_000
const sock = () => ({ readyState: OPEN } as WebSocket)
const IDLE_MAC = () => ({ booting: false, overloaded: false, memoryRefuses: [] })

/** `<user>:<client>` like the relay's owner key; the user half is what a person is across browsers. */
const client = (user: string, tab: string) => ({ key: `${user}:${tab}`, user, minted: false })
const person = (label: string) => ({ kind: 'dashboard' as const, label, name: label.split('@')[0]! })
const mcp = (label: string) => ({ kind: 'mcp' as const, label })

function setup() {
  const sm = new SessionManager({ idleTimeoutMs: IDLE })
  const [id] = sm.create(sock(), [{ id: 'd1', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted' }])
  const device = (asker: { key: string; user: string }, alive = true): DeviceSummary =>
    sm.list(asker.key, () => alive, IDLE_MAC, asker.user)[0]!.devices[0]!
  /** A holder whose socket closed: what the relay's close handler does for every session that socket held. */
  const drop = () => sm.clearBrowser(id!, () => {})
  return { sm, id: id!, device, drop }
}

const alice = client('1', 'tab-a')
const aliceElsewhere = client('1', 'laptop')
const bob = client('2', 'tab-b')

describe('the device remembers who it is waiting for', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('tells the person who dropped that they can resume, from any browser', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    drop()
    vi.advanceTimersByTime(3_000)

    const mine = device(aliceElsewhere)
    expect(mine.resumable).toBe(true)
    expect(mine.waiting).toEqual({ user: 'alice@example.com', name: 'alice', remainingMs: IDLE - 3_000, yours: true })
    expect(mine.releasedAgoMs).toBe(3_000)
  })

  it('tells everyone else whose it is, and not that they can resume it', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    drop()

    const theirs = device(bob)
    expect(theirs.waiting).toEqual({ user: 'alice@example.com', name: 'alice', remainingMs: IDLE })
    expect(theirs.resumable).toBeUndefined()
    expect(theirs.releasedAgoMs).toBeUndefined()
  })

  it('names the build it was on, to the owner only', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    sm.get(id)!.installed = { buildId: 7, filePath: '/uploads/builds/a.app.zip' }
    drop()

    expect(device(aliceElsewhere).waiting?.buildId).toBe(7)
    expect(device(bob).waiting?.buildId).toBeUndefined()
  })

  it('remembers nobody when the device is not waiting', () => {
    const { sm, id, device } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    // A leave with no countdown keeps the device up and waits for no one.
    sm.clearBrowser(id)

    expect(device(alice).waiting).toBeUndefined()
    expect(device(alice).resumable).toBeUndefined()
  })

  it('remembers nobody for an AI client that left its own session', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, mcp('alice@example.com'))
    drop()

    expect(device(alice).waiting).toBeUndefined()
  })

  it('forgets when the countdown runs out', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    drop()
    vi.advanceTimersByTime(IDLE)

    expect(device(alice).waiting).toBeUndefined()
    expect(device(alice).resumable).toBeUndefined()
  })

  it('forgets when its owner comes back, and says nothing about who ended it', () => {
    const { sm, id, device, drop } = setup()
    sm.join(id, sock(), alice, () => true, person('alice@example.com'))
    drop()
    sm.join(id, sock(), aliceElsewhere, () => true, person('alice@example.com'))

    expect(device(alice).waiting).toBeUndefined()
    expect(device(alice).endedBy).toBeUndefined()
  })

  describe('when someone else takes it', () => {
    it('tells the owner who, and only the owner', () => {
      const { sm, id, device, drop } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      drop()
      sm.join(id, sock(), bob, () => true, person('bob@example.com'))

      expect(device(aliceElsewhere).endedBy).toEqual({ by: 'bob@example.com', name: 'bob', at: expect.any(Number) })
      expect(device(bob).endedBy).toBeUndefined()
      expect(device(bob).waiting).toBeUndefined()
    })

    // Read by every tab that polls, so it cannot be "shown once": one that draws no banner would use it up.
    it('keeps telling the owner on every listing until it expires', () => {
      const { sm, id, device, drop } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      drop()
      sm.join(id, sock(), bob, () => true, person('bob@example.com'))

      device(alice); device(alice)
      expect(device(aliceElsewhere).endedBy).toBeDefined()
      vi.advanceTimersByTime(IDLE)
      expect(device(aliceElsewhere).endedBy).toBeUndefined()
    })

    // Otherwise an old notice hides a session the owner can resume right now.
    it('forgets the notice once the owner holds the device again', () => {
      const { sm, id, device, drop } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      drop()
      sm.join(id, sock(), bob, () => true, person('bob@example.com'))
      sm.clearBrowser(id)
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))

      expect(device(aliceElsewhere).endedBy).toBeUndefined()
    })
  })

  describe('an AI client borrowing the device while it waits', () => {
    function borrowed() {
      const s = setup()
      s.sm.join(s.id, sock(), alice, () => true, person('alice@example.com'))
      s.drop()
      const agent = sock()
      s.sm.join(s.id, agent, client('2', 'mcp'), () => true, mcp('bob@example.com'))
      return s
    }

    it('keeps the owner, says an AI client has it, and offers no resume while it does', () => {
      const { device } = borrowed()

      const mine = device(alice)
      expect(mine.waiting).toEqual({ user: 'alice@example.com', name: 'alice', aiHolding: true, yours: true })
      expect(mine.resumable).toBeUndefined()
      expect(mine.endedBy).toBeUndefined()
    })

    it('waits for the owner again, from the start, when the AI client leaves', () => {
      const { sm, id, device } = borrowed()
      vi.advanceTimersByTime(10_000)
      // An AI client that stopped a person's countdown by joining starts it again by leaving (`idleResumeOnLeave`).
      sm.clearBrowser(id, () => {})

      const mine = device(alice)
      expect(mine.resumable).toBe(true)
      expect(mine.waiting).toEqual({ user: 'alice@example.com', name: 'alice', remainingMs: IDLE, yours: true })
    })

    // The owner's own MCP is the same user. Telling them their old connection is still clearing would be false, and
    // the dashboard's retry would keep losing to a holder that is not going away.
    it('does not read as the owner holding it, when the AI client runs as the owner', () => {
      const s = setup()
      s.sm.join(s.id, sock(), alice, () => true, person('alice@example.com'))
      s.drop()
      s.sm.join(s.id, sock(), client('1', 'mcp'), () => true, mcp('alice@example.com'))

      const mine = s.device(alice)
      expect(mine.heldBySelf).toBeUndefined()
      expect(mine.resumable).toBeUndefined()
      expect(mine.waiting?.aiHolding).toBe(true)
    })
  })

  describe('a person still holding it from another tab', () => {
    it('reads as theirs to the same person in a new tab', () => {
      const { sm, id, device } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))

      expect(device(aliceElsewhere).heldBySelf).toBe(true)
      expect(device(alice).heldBySelf).toBeUndefined()
      expect(device(bob).heldBySelf).toBeUndefined()
    })

    it('not once that tab has stopped answering', () => {
      const { sm, id, device } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))

      expect(device(aliceElsewhere, false).heldBySelf).toBeUndefined()
    })
  })

  describe('a shutdown', () => {
    it('by someone else ends the wait and tells the owner who', () => {
      const { sm, id, device, drop } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      drop()
      sm.noteShutdown(id, { user: '2', label: 'bob@example.com', name: 'bob' })

      expect(device(bob).waiting).toBeUndefined()
      expect(device(alice).endedBy).toEqual({ by: 'bob@example.com', name: 'bob', at: expect.any(Number) })
    })

    it('by the owner ends the wait and tells nobody anything', () => {
      const { sm, id, device, drop } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      drop()
      sm.noteShutdown(id, { user: '1', label: 'alice@example.com', name: 'alice' })

      expect(device(alice).waiting).toBeUndefined()
      expect(device(alice).endedBy).toBeUndefined()
    })

    // A done answers the shutdown that was sent, not whatever happened since. Picked up again and dropped again before
    // the agent reported back, the device has a new wait and a new countdown, and they are not this done's to end.
    it('leaves a wait alone that started after a boot went out behind the shutdown', () => {
      const onTimeout = vi.fn()
      const { sm, id } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      sm.clearBrowser(id, () => {})
      sm.noteShutdown(id, { user: '1', label: 'alice@example.com', name: 'alice' })
      sm.join(id, sock(), aliceElsewhere, () => true, person('alice@example.com'))
      sm.noteBootSent(id)
      sm.clearBrowser(id, onTimeout)
      sm.settleShutdown(id)

      expect(sm.list(alice.key, () => true, IDLE_MAC, alice.user)[0]!.devices[0]!.resumable).toBe(true)
      vi.advanceTimersByTime(IDLE)
      expect(onTimeout).toHaveBeenCalledTimes(1)
    })

    describe('that the agent could not carry out', () => {
      const robot = client('3', 'mcp-1')
      const bobShutsDown = () => {
        const t = setup()
        t.sm.join(t.id, sock(), alice, () => true, person('alice@example.com'))
        t.drop()
        t.sm.noteShutdown(t.id, { user: '2', label: 'bob@example.com', name: 'bob' })
        return t
      }

      it('puts the wait back, and takes back who ended it', () => {
        const { sm, id, device } = bobShutsDown()
        sm.undoShutdown(id)
        expect(device(aliceElsewhere).resumable).toBe(true)
        expect(device(aliceElsewhere).endedBy).toBeUndefined()
      })

      it('leaves it ended once someone holds the device', () => {
        const { sm, id, device } = bobShutsDown()
        sm.join(id, sock(), bob, () => true, person('bob@example.com'))
        sm.undoShutdown(id)
        expect(device(aliceElsewhere).waiting).toBeUndefined()
      })

      // An AI client leaves no wait of its own, so only the boot says the device was picked up since.
      it('leaves it ended once a boot went out after it', () => {
        const { sm, id, device } = bobShutsDown()
        sm.join(id, sock(), robot, () => true, mcp('agent'))
        sm.noteBootSent(id)
        sm.clearBrowser(id, () => {})
        sm.undoShutdown(id)
        expect(device(aliceElsewhere).waiting).toBeUndefined()
      })

      it('leaves it ended once the countdown has run out', () => {
        const { sm, id, device } = bobShutsDown()
        vi.advanceTimersByTime(IDLE)
        sm.undoShutdown(id)
        expect(device(aliceElsewhere).waiting).toBeUndefined()
      })

      // Only the latest shutdown's failure can put anything back, and a later one that found no wait has nothing to.
      it('does not put back a wait an earlier, unanswered shutdown ended', () => {
        const { sm, id, device } = bobShutsDown()
        sm.join(id, sock(), robot, () => true, mcp('agent'))
        sm.noteShutdown(id, { user: '3', label: 'agent', name: 'agent' })
        sm.clearBrowser(id, () => {})
        sm.undoShutdown(id)
        expect(device(aliceElsewhere).waiting).toBeUndefined()
      })
    })

    // Cancelled when the device is off, not when the shutdown was sent: one that fails keeps the timer as its backstop.
    it('cancels the countdown only once the device is down', () => {
      const onTimeout = vi.fn()
      const { sm, id } = setup()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      sm.clearBrowser(id, onTimeout)
      sm.noteShutdown(id, { user: '1', label: 'alice@example.com', name: 'alice' })
      vi.advanceTimersByTime(IDLE)
      expect(onTimeout).toHaveBeenCalledTimes(1)

      onTimeout.mockClear()
      sm.join(id, sock(), alice, () => true, person('alice@example.com'))
      sm.clearBrowser(id, onTimeout)
      sm.settleShutdown(id)
      vi.advanceTimersByTime(IDLE)
      expect(onTimeout).not.toHaveBeenCalled()
    })
  })
})
