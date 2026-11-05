import { describe, it, expect, vi, afterEach } from 'vitest'
import { FoldableInput, EDGE_FRACTION } from '../FoldableInput.js'
import type { GuestHelper } from '../GuestHelper.js'

// The parts of GuestHelper FoldableInput uses, as a scripted fake. Its own lifecycle is GuestHelper's tests'.
function fakeGuest(state: 'ready' | 'starting' | 'unavailable' = 'ready') {
  let owns = false
  const guest = {
    state,
    inputState: vi.fn(() => guest.state),
    ownsGesture: vi.fn(() => owns),
    touch: vi.fn((_s: string, phase: string, _x: number, _y: number, _edge: boolean) => {
      if (guest.state !== 'ready') return false
      if (phase === 'd') owns = true
      return phase === 'd' || owns
    }),
    pinch: vi.fn((_s: string, phase: string, _x1: number, _y1: number, _x2: number, _y2: number) => {
      if (guest.state !== 'ready') return false
      if (phase === 'd') owns = true
      return phase === 'd' || owns
    }),
    key: vi.fn(async () => true),
    keyDown: vi.fn(async () => true),
    keyUp: vi.fn(async () => true),
    stop: vi.fn(),
    loseGesture: () => { owns = false },
  }
  return guest
}

function make(opts: { state?: 'ready' | 'starting' | 'unavailable'; lit?: string | null; minContactMs?: number } = {}) {
  const guest = fakeGuest(opts.state)
  let lit: string | null = opts.lit === undefined ? 'COVER' : opts.lit
  const input = new FoldableInput({
    guest: () => guest as unknown as GuestHelper,
    litScreen: () => lit,
    minContactMs: opts.minContactMs ?? 0,
  })
  return { input, guest, setLit: (s: string | null) => { lit = s } }
}

afterEach(() => vi.useRealTimers())

// The guest helper has no cancel, so a cancelled touch is lifted with an up — never left down (#1115) — and only a
// single-finger touch: an up sent into an open pinch would lift one of its fingers.
describe('FoldableInput.touchCancel', () => {
  it('lifts an open touch with an up, and the end after it sends nothing', async () => {
    const { input, guest } = make()
    input.touchStart(0.4, 0.5)
    expect(input.touchCancel()).toBe(true)
    await expect(input.touchEndAfterMinContact()).resolves.toBe(false)
    expect(guest.touch.mock.calls.map((c) => c[1])).toEqual(['d', 'u'])
  })

  it('leaves an open pinch alone', () => {
    const { input, guest } = make()
    input.pinchStart(0.4, 0.5, 0.6, 0.5)
    expect(input.touchCancel()).toBe(false)
    expect(guest.touch).not.toHaveBeenCalled()
  })

  it('sends a held-back up at once', async () => {
    const { input, guest } = make({ minContactMs: 1000 })
    input.touchStart(0.4, 0.5)
    const held = input.touchEndAfterMinContact()
    expect(input.touchCancel()).toBe(true)
    await expect(held).resolves.toBe(true)
    expect(guest.touch.mock.calls.map((c) => c[1])).toEqual(['d', 'u'])
  })
})

describe('FoldableInput touches', () => {
  it('sends a tap to the lit panel, in buffer coordinates as given', async () => {
    const { input, guest } = make()
    expect(input.touchStart(0.4, 0.5)).toBe(true)
    expect(input.touchMove(0.45, 0.55)).toBe(true)
    await expect(input.touchEndAfterMinContact()).resolves.toBe(true)
    expect(guest.touch.mock.calls).toEqual([
      ['COVER', 'd', 0.4, 0.5, false],
      ['COVER', 'm', 0.45, 0.55, false],
      ['COVER', 'u', 0.45, 0.55, false],
    ])
  })

  it('marks a gesture that starts near any edge, for its whole length', () => {
    const { input, guest } = make()
    const near = 1 - EDGE_FRACTION / 2
    input.touchStart(0.5, near)
    input.touchMove(0.5, 0.5)
    input.touchEnd()
    expect(guest.touch.mock.calls.map((c) => c[4])).toEqual([true, true, true])
    for (const [x, y] of [[0.01, 0.5], [0.99, 0.5], [0.5, 0.01]] as const) {
      guest.touch.mockClear()
      input.touchStart(x, y)
      input.touchEnd()
      expect(guest.touch.mock.calls[0][4], `${x},${y}`).toBe(true)
    }
  })

  it('does not mark a gesture that starts away from the edges', () => {
    const { input, guest } = make()
    const inside = EDGE_FRACTION * 1.5
    input.touchStart(inside, 1 - inside)
    input.touchMove(0.5, 0.5)
    input.touchEnd()
    expect(guest.touch.mock.calls.map((c) => c[4])).toEqual([false, false, false])
  })

  it('finishes a gesture on the panel it started on when the lit panel changes mid-gesture', () => {
    const { input, guest, setLit } = make()
    input.touchStart(0.5, 0.5)
    setLit('OPEN')
    input.touchMove(0.6, 0.6)
    input.touchEnd()
    expect(guest.touch.mock.calls.map((c) => c[0])).toEqual(['COVER', 'COVER', 'COVER'])
    input.touchStart(0.5, 0.5)
    expect(guest.touch.mock.calls.at(-1)?.[0]).toBe('OPEN')
  })

  it('refuses a touch when no panel is known to be lit, and says to wait', () => {
    const { input, guest } = make({ lit: null })
    expect(input.inputState()).toBe('starting')
    expect(input.touchStart(0.5, 0.5)).toBe(false)
    expect(guest.touch).not.toHaveBeenCalled()
  })

  it('refuses continuation frames with no gesture open', () => {
    const { input, guest } = make()
    expect(input.touchMove(0.5, 0.5)).toBe(false)
    expect(input.touchEnd()).toBe(false)
    expect(guest.touch).not.toHaveBeenCalled()
  })

  it('reports gesture ownership from the guest, so a replaced helper owns nothing', () => {
    const { input, guest } = make()
    input.touchStart(0.5, 0.5)
    expect(input.ownsGesture()).toBe(true)
    guest.loseGesture()
    expect(input.ownsGesture()).toBe(false)
  })

  it('holds a fast tap until the minimum contact has passed', async () => {
    vi.useFakeTimers()
    const { input, guest } = make({ minContactMs: 50 })
    input.touchStart(0.5, 0.5)
    const end = input.touchEndAfterMinContact()
    expect(guest.touch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    await expect(end).resolves.toBe(true)
    expect(guest.touch.mock.calls.at(-1)?.[1]).toBe('u')
  })

  it('sends a pinch to the lit panel and never marks it as an edge gesture', () => {
    const { input, guest } = make()
    expect(input.pinchStart(0.01, 0.5, 0.6, 0.5)).toBe(true)
    expect(input.pinchMove(0.02, 0.5, 0.7, 0.5)).toBe(true)
    expect(input.pinchEnd()).toBe(true)
    expect(guest.pinch.mock.calls).toEqual([
      ['COVER', 'd', 0.01, 0.5, 0.6, 0.5],
      ['COVER', 'm', 0.02, 0.5, 0.7, 0.5],
      ['COVER', 'u', 0.02, 0.5, 0.7, 0.5],
    ])
  })
})

describe('FoldableInput keys and buttons', () => {
  it('types a key with its modifiers as keyboard-page usages', () => {
    const { input, guest } = make()
    expect(input.sendKey(0x19, 0x08)).toBe(true) // ⌘V
    expect(guest.key).toHaveBeenCalledWith(7, 0x19, expect.any(Number), [[7, 0xe3]])
    input.sendKey(0x04, 0x01 | 0x02 | 0x40)
    expect(guest.key).toHaveBeenLastCalledWith(7, 0x04, expect.any(Number), [[7, 0xe0], [7, 0xe1], [7, 0xe6]])
  })

  it('presses hardware buttons, held and whole', () => {
    const { input, guest } = make()
    expect(input.pressButton(0x0c, 0xe9)).toBe(true)
    expect(guest.key).toHaveBeenLastCalledWith(0x0c, 0xe9, expect.any(Number))
    expect(input.pressButtonDown(0x0c, 0x30)).toBe(true)
    expect(input.pressButtonUp(0x0c, 0x30)).toBe(true)
    expect(guest.keyDown).toHaveBeenCalledWith(0x0c, 0x30)
    expect(guest.keyUp).toHaveBeenCalledWith(0x0c, 0x30)
  })

  it('maps the legacy home and lock buttons to Menu and power', () => {
    const { input, guest } = make()
    expect(input.pressLegacyButton(0)).toBe(true)
    expect(guest.key).toHaveBeenLastCalledWith(0x0c, 0x40, expect.any(Number))
    expect(input.pressLegacyButton(1)).toBe(true)
    expect(guest.key).toHaveBeenLastCalledWith(0x0c, 0x30, expect.any(Number))
  })

  it('refuses keys and buttons when the guest is not ready, writing nothing', () => {
    const { input, guest } = make({ state: 'starting' })
    expect(input.sendKey(0x04)).toBe(false)
    expect(input.pressButton(0x0c, 0xe9)).toBe(false)
    expect(input.pressLegacyButton(0)).toBe(false)
    expect(guest.key).not.toHaveBeenCalled()
  })
})

describe('FoldableInput lifecycle', () => {
  it('passes the guest state through, and is unavailable without a guest', () => {
    const { input, guest } = make({ state: 'starting' })
    expect(input.inputState()).toBe('starting')
    guest.state = 'ready'
    expect(input.inputState()).toBe('ready')
    const orphan = new FoldableInput({ guest: () => null, litScreen: () => 'COVER', minContactMs: 0 })
    expect(orphan.inputState()).toBe('unavailable')
    expect(orphan.touchStart(0.5, 0.5)).toBe(false)
  })

  it('stop() detaches without stopping the guest helper', async () => {
    vi.useFakeTimers()
    const { input, guest } = make({ minContactMs: 50 })
    input.touchStart(0.5, 0.5)
    const held = input.touchEndAfterMinContact()
    input.stop()
    await expect(held).resolves.toBe(false)
    expect(guest.stop).not.toHaveBeenCalled()
    expect(input.touchStart(0.5, 0.5)).toBe(false)
  })
})
