import { describe, it, expect } from 'vitest'
import { fieldResponseOf, keyboardStateOf, toFrameRect } from '../keyboard'

const screen = { width: 1000, height: 2000 }

describe('toFrameRect', () => {
  // `AndroidAgent.fromFrame` turns a frame point onto the screen with `toNaturalPoint(turn)`; this is its inverse, so a
  // frame point inside the frame rect lands inside the screen rect.
  const toScreen = (turn: 0 | 90 | 180 | 270, x: number, y: number) => {
    switch (turn) {
      case 0: return { x, y }
      case 90: return { x: 1 - y, y: x }
      case 180: return { x: 1 - x, y: 1 - y }
      case 270: return { x: y, y: 1 - x }
    }
  }
  const keyboard = { x: 0, y: 0.6, width: 1, height: 0.4 }

  it.each([0, 90, 180, 270] as const)('is the inverse of fromFrame\'s turn %i', (turn) => {
    const frame = toFrameRect(keyboard, turn)
    const centre = toScreen(turn, frame.x + frame.width / 2, frame.y + frame.height / 2)
    expect(centre.x).toBeCloseTo(0.5)
    expect(centre.y).toBeCloseTo(0.8)
    expect(frame.width * frame.height).toBeCloseTo(0.4)
  })

  it('is the same rect with no turn', () => {
    expect(toFrameRect(keyboard, 0)).toBe(keyboard)
  })
})

describe('keyboardStateOf', () => {
  it('is unknown, not hidden, when the window could not be read', () => {
    expect(keyboardStateOf(null, screen, 0)).toEqual({ shown: null })
  })

  it('says the home screen was in front when the keyboard would type into the launcher', () => {
    const launcher = 'com.google.android.apps.nexuslauncher'
    expect(keyboardStateOf({ shown: false, target: launcher }, screen, 0, launcher)).toEqual({ shown: false, onHome: true })
    expect(keyboardStateOf({ shown: false, target: 'com.android.settings' }, screen, 0, launcher)).toEqual({ shown: false, onHome: false })
  })

  it('says nothing of the home screen when either side is unknown', () => {
    expect(keyboardStateOf({ shown: false }, screen, 0, 'com.google.android.apps.nexuslauncher')).toEqual({ shown: false })
    expect(keyboardStateOf({ shown: false, target: 'com.android.settings' }, screen, 0, null)).toEqual({ shown: false })
  })

  it('is shown with no rect when the screen size is unknown', () => {
    expect(keyboardStateOf({ shown: true, rect: { x: 0, y: 1200, width: 1000, height: 800 } }, null, 0)).toEqual({ shown: true })
  })

  it('normalises the rect by the screen Android draws', () => {
    expect(keyboardStateOf({ shown: true, rect: { x: 0, y: 1200, width: 1000, height: 800 } }, screen, 90)).toEqual({
      shown: true, rect: { x: 0, y: 0.6, width: 1, height: 0.4 }, frameRect: toFrameRect({ x: 0, y: 0.6, width: 1, height: 0.4 }, 90),
    })
  })
})

describe('fieldResponseOf', () => {
  it('drops a password\'s value, whatever the jar printed', () => {
    const r = fieldResponseOf({ identifier: 'p', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: true, value: 'x' }, screen, 0)
    expect(r.field).toEqual({ identifier: 'p', placeholder: '', frame: { x: 0, y: 0, width: 0.01, height: 0.005 }, secure: true })
    expect(r.reason).toBe('secure')
  })

  it('states no keyboard when the jar saw no keyboard window: unknown, not hidden', () => {
    const r = fieldResponseOf({ identifier: 'e', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, value: '' }, screen, 0)
    expect(r).not.toHaveProperty('keyboard')
    expect(r).not.toHaveProperty('language')
  })

  it('keeps the keyboard and its language beside a field that is not focused', () => {
    const r = fieldResponseOf({ reason: 'no-focus', keyboard: { x: 0, y: 1000, width: 1000, height: 1000 }, language: 'Español' }, screen, 0)
    expect(r).toMatchObject({ field: null, reason: 'no-focus', keyboard: { shown: true }, language: 'Español' })
  })

  it('reads an unknown reason as failed', () => {
    expect(fieldResponseOf({ reason: 'java.lang.Oops' }, screen, 0)).toEqual({ field: null, reason: 'failed' })
  })

  it('is failed with no read or no screen', () => {
    expect(fieldResponseOf(null, screen, 0)).toEqual({ field: null, reason: 'failed' })
    expect(fieldResponseOf({ identifier: 'e', frame: { x: 0, y: 0, width: 1, height: 1 }, value: 'v' }, null, 0)).toEqual({ field: null, reason: 'failed' })
  })
})
