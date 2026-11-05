import { describe, expect, it } from 'vitest'

import type { AndroidChrome, ChromeData } from '../index.js'
import { chromeOrientation, interfaceTurnOf, toFramePoint } from '../screen/index.js'
import { parseInbound } from '../validate/index.js'

const ios = (over: Partial<ChromeData> = {}): ChromeData => ({
  framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
  padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
  screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1, buttons: [], ...over,
})
const android = (over: Partial<AndroidChrome> = {}): AndroidChrome => ({ buttons: [], streamType: 'h264', ...over })

describe('chromeOrientation', () => {
  it('reads an iPhone from streamRotation: upright is portrait, either side landscape', () => {
    expect(chromeOrientation(ios({ streamRotation: 0 }))).toBe('portrait')
    expect(chromeOrientation(ios({ streamRotation: 270 }))).toBe('landscape')
    expect(chromeOrientation(ios({ streamRotation: 90 }))).toBe('landscape')
  })

  // The agents meet `portrait` only upright, so upside down must not read as done, or a flow asking for portrait
  // would leave the device inverted.
  it('reads upside down as neither, and apart from a chrome that cannot say', () => {
    expect(chromeOrientation(ios({ streamRotation: 180 }))).toBe('upside-down')
    expect(chromeOrientation(android({ bodyRotation: 180 }))).toBe('upside-down')
  })

  it('reads Android from the body, never from the capture correction that shares the name', () => {
    expect(chromeOrientation(android({ bodyRotation: 90, streamRotation: 0 }))).toBe('landscape')
    expect(chromeOrientation(android({ bodyRotation: 0, streamRotation: 90 }))).toBe('portrait')
    expect(chromeOrientation(android({ streamRotation: 90 }))).toBeUndefined()
  })

  // A multi-panel device's value includes the lit panel's own turn: the Duo held upright reads 90.
  it('cannot say for a multi-panel device, or with no turn at all', () => {
    expect(chromeOrientation(ios({ streamRotation: 90, scaleBasis: 2000 }))).toBeUndefined()
    expect(chromeOrientation(ios())).toBeUndefined()
  })
})

describe('interfaceTurnOf', () => {
  it('reads the four turns and nothing else', () => {
    for (const t of [0, 90, 180, 270]) expect(interfaceTurnOf(t)).toBe(t)
    for (const bad of [45, '90', null, undefined, -90, 360]) expect(interfaceTurnOf(bad)).toBeUndefined()
  })
})

describe('toFramePoint', () => {
  // Measured on an iPhone 17 Pro simulator: at 270 the app's (u, v) lands at (1 − v, u), at 90 at (v, 1 − u).
  it.each([
    [270, [0.25, 0.1], [0.9, 0.25]],
    [90, [0.25, 0.1], [0.1, 0.75]],
    [180, [0.25, 0.1], [0.75, 0.9]],
    [0, [0.25, 0.1], [0.25, 0.1]],
    [undefined, [0.25, 0.1], [0.25, 0.1]],
  ] as const)('turn %s carries %j to %j', (turn, from, to) => {
    const [x, y] = toFramePoint(turn, [from[0], from[1]])
    expect(x).toBeCloseTo(to[0], 9)
    expect(y).toBeCloseTo(to[1], 9)
  })

  it('keeps every point inside the frame', () => {
    for (const turn of [0, 90, 180, 270] as const) {
      for (const p of [[0, 0], [1, 1], [0, 1], [1, 0], [0.3, 0.7]] as const) {
        for (const c of toFramePoint(turn, [p[0], p[1]])) expect(c >= 0 && c <= 1).toBe(true)
      }
    }
  })
})

describe('ui:tree:response interfaceTurn', () => {
  const frame = (interfaceTurn: unknown) => ({ type: 'ui:tree:response', sessionId: 's', requestId: 'r', elements: [], interfaceTurn })

  it('carries a known turn', () => {
    const r = parseInbound(frame(270))
    expect(r.ok && r.msg).toMatchObject({ interfaceTurn: 270 })
  })

  // One unknown value must cost the field, not the tree: a refused frame leaves the caller waiting out its deadline.
  it('drops an unknown turn and keeps the tree', () => {
    for (const bad of [45, '90', null]) {
      const r = parseInbound(frame(bad))
      expect(r.ok).toBe(true)
      expect(r.ok && (r.msg as { interfaceTurn?: unknown }).interfaceTurn).toBeUndefined()
    }
  })
})
