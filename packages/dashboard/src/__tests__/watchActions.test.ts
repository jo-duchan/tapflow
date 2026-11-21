import { describe, it, expect } from 'vitest'
import { actionText, placeOnIosFrame, touchOfAction } from '@/lib/watchActions'

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

describe('placeOnIosFrame', () => {
  it('puts a screen point inside the screen\'s box in the frame, not the frame itself', () => {
    const place = placeOnIosFrame({ screenPctLeft: 5, screenPctTop: 2, screenPctW: 90, screenPctH: 96 })
    expect(place(0, 0)).toEqual({ left: 0.05, top: 0.02 })
    expect(place(1, 1)).toEqual({ left: 0.95, top: 0.98 })
    expect(place(0.5, 0.5)).toEqual({ left: 0.5, top: 0.5 })
  })
})
