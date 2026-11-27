import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TouchMarksLayer } from '@/components/touch/TouchMarksLayer'
import { layerPoint } from '@/lib/touchMarks'

// The layer is a canvas, which has no DOM to query; it says what it draws and where its mark starts.
describe('TouchMarksLayer', () => {
  const place = (x: number, y: number) => ({ left: 0.1 + x * 0.8, top: 0.05 + y * 0.9 })

  it('places a machine\'s touch through the conversion, in the machine\'s colour, hidden from assistive tech', () => {
    render(<TouchMarksLayer tone="machine" place={place} touch={{ id: 1, at: 0, kind: 'tap', point: { x: 0.25, y: 0 } }} />)
    const layer = screen.getByTestId('touch-marks')
    expect(layer.getAttribute('data-anchor')).toBe('30,5')
    expect(layer.getAttribute('data-tone')).toBe('machine')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
  })

  it('anchors a swipe where the finger went down, and a still mark the same way', () => {
    render(<TouchMarksLayer tone="machine" place={place} still={{ kind: 'swipe', from: { x: 0, y: 1 }, to: { x: 1, y: 0 } }} />)
    expect(screen.getByTestId('touch-marks').getAttribute('data-anchor')).toBe('10,95')
  })

  it('draws nothing to anchor before a machine\'s first touch', () => {
    render(<TouchMarksLayer tone="person" place={place} touch={null} />)
    expect(screen.getByTestId('touch-marks').hasAttribute('data-anchor')).toBe(false)
  })

  // What the drawing itself uses: the box sits 40 px inside the canvas on every side, so a mark at the box's corner is
  // drawn there and not at the canvas's. Mutation: drop the bleed, and every mark lands 40 px up and left.
  it('draws a point in the box, inset by the canvas\'s bleed', () => {
    const toPx = layerPoint((x, y) => ({ left: x, top: y }), 280, 480)
    expect(toPx({ x: 0, y: 0 })).toEqual({ x: 40, y: 40 })
    expect(toPx({ x: 1, y: 1 })).toEqual({ x: 240, y: 440 })
    expect(layerPoint(place, 280, 480)({ x: 0.5, y: 0.5 })).toEqual({ x: 140, y: 240 })
  })
})
