import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TapMarks } from '@/components/watch/TapMarks'
import { actionText, placeOnIosFrame } from '@/lib/watchActions'

// A2: a tap is drawn where the agent tapped, through the platform's placement; a swipe as its line.
describe('TapMarks', () => {
  const place = (x: number, y: number) => ({ left: 0.1 + x * 0.8, top: 0.05 + y * 0.9 })

  it('keeps a cursor where the agent last tapped, placed through the conversion', () => {
    render(<TapMarks place={place} marks={{ cursor: { x: 0.5, y: 0.5 }, trails: [] }} />)
    const cursor = screen.getByTestId('tap-cursor')
    expect([cursor.style.left, cursor.style.top]).toEqual(['50%', '50%'])
    expect(screen.getByTestId('tap-marks').getAttribute('aria-hidden')).toBe('true')
  })

  it('draws a tap\'s path from the previous cursor and a swipe\'s stroke, each with a ripple where it lands', () => {
    render(<TapMarks place={place} marks={{
      cursor: { x: 0.5, y: 0 },
      trails: [
        { id: 1, kind: 'tap', from: [0, 0], to: [1, 1] },
        { id: 2, kind: 'swipe', from: [0.5, 1], to: [0.5, 0] },
      ],
    }} />)
    const lines = screen.getAllByTestId('trail').map((svg) => svg.querySelector('line')!)
    expect(lines.map((l) => [l.getAttribute('x1'), l.getAttribute('y1'), l.getAttribute('x2'), l.getAttribute('y2')])).toEqual([
      ['10%', '5%', '90%', '95%'], ['50%', '95%', '50%', '5%'],
    ])
    expect(screen.getAllByTestId('ripple')).toHaveLength(2)
    // A swipe is the shared stroke: dashed, strengthening toward where the finger lifted.
    expect(lines[1]!.getAttribute('stroke-dasharray')).toBe('1 9')
    expect(lines[1]!.getAttribute('stroke')).toMatch(/^url\(#swipe-/)
  })

  it('draws no path for the first tap, which has nowhere to come from', () => {
    render(<TapMarks place={place} marks={{ cursor: { x: 0.2, y: 0.2 }, trails: [{ id: 1, kind: 'tap', from: null, to: [0.2, 0.2] }] }} />)
    expect(screen.queryByTestId('trail')).toBeNull()
    expect(screen.getAllByTestId('ripple')).toHaveLength(1)
  })
})

describe('actionText', () => {
  it('says what happened without what was typed or opened', () => {
    expect(actionText({ kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] })).toBe('Swipe up')
    expect(actionText({ kind: 'type', chars: 1 })).toBe('Typed 1 character')
    expect(actionText({ kind: 'key', key: 'character' })).toBe('Key (a character)')
    expect(actionText({ kind: 'open-url' })).toBe('Opened a link')
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
