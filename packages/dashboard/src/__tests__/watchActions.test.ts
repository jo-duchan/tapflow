import { describe, it, expect } from 'vitest'
import { actionText, isMark, placeOnIosFrame, touchOfAction } from '@/lib/watchActions'

describe('actionText', () => {
  it('says what happened without what was typed or opened', () => {
    expect(actionText({ kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] })).toBe('Swipe up')
    expect(actionText({ kind: 'type', chars: 1 })).toBe('Typed 1 character')
    expect(actionText({ kind: 'key', key: 'character' })).toBe('Key (a character)')
    expect(actionText({ kind: 'open-url' })).toBe('Opened a link')
  })
})

describe('touchOfAction', () => {
  // A2: the agent's tap or swipe, played from when the page learned of it.
  it('turns a watched tap or swipe into a touch to play from the page\'s clock', () => {
    expect(touchOfAction(3, { kind: 'tap', x: 0.2, y: 0.4 }, 500)).toEqual({ id: 3, at: 500, kind: 'tap', point: { x: 0.2, y: 0.4 } })
    expect(touchOfAction(4, { kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] }, 600))
      .toEqual({ id: 4, at: 600, kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 } })
  })
})

describe('a pinch, a long press, and the frame\'s points', () => {
  const pinch = { kind: 'pinch' as const, from: [[0.4, 0.45], [0.6, 0.55]] as [[number, number], [number, number]], to: [[0.2, 0.35], [0.8, 0.65]] as [[number, number], [number, number]], durationMs: 300, space: 'frame' as const }

  // An older relay's pinch has no fingers: a row, not a mark. Mutation: accept every pinch.
  it('draws a pinch only when its fingers came with it', () => {
    expect(isMark(pinch)).toBe(true)
    expect(isMark({ kind: 'pinch' })).toBe(false)
    expect(isMark({ kind: 'pinch', from: pinch.from })).toBe(false)
  })

  // Mutations: swap a finger, drop the hold, drop the space.
  it('turns them into a touch with both fingers, the hold and the space kept', () => {
    expect(touchOfAction(5, pinch, 700)).toEqual({
      id: 5, at: 700, space: 'frame', kind: 'pinch', from: [{ x: 0.4, y: 0.45 }, { x: 0.6, y: 0.55 }], to: [{ x: 0.2, y: 0.35 }, { x: 0.8, y: 0.65 }], durationMs: 300,
    })
    expect(touchOfAction(7, { kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 950 }, 0))
      .toEqual({ id: 7, at: 0, kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 950 })
    expect(touchOfAction(6, { kind: 'tap', x: 0.2, y: 0.4, holdMs: 900, space: 'frame' }, 0))
      .toEqual({ id: 6, at: 0, kind: 'tap', point: { x: 0.2, y: 0.4 }, holdMs: 900, space: 'frame' })
  })
})

describe('placeOnIosFrame', () => {
  it('puts a screen point inside the screen\'s box in the frame, not the frame itself', () => {
    const place = placeOnIosFrame({ screenPctLeft: 5, screenPctTop: 2, screenPctW: 90, screenPctH: 96 })
    expect(place(0, 0)).toEqual({ left: 0.05, top: 0.02 })
    expect(place(1, 1)).toEqual({ left: 0.95, top: 0.98 })
    expect(place(0.5, 0.5)).toEqual({ left: 0.5, top: 0.5 })
  })
})
