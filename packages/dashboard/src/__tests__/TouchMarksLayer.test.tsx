import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TouchMarksLayer } from '@/components/touch/TouchMarksLayer'

// The layer is a canvas, which has no DOM to query; it says what it draws and where its mark starts.
describe('TouchMarksLayer', () => {
  const place = (x: number, y: number) => ({ left: 0.1 + x * 0.8, top: 0.05 + y * 0.9 })

  it('places a machine\'s touch through the conversion, in the machine\'s colour, hidden from assistive tech', () => {
    render(<TouchMarksLayer tone="machine" place={place} touch={{ id: 1, at: 0, kind: 'tap', point: { x: 0.5, y: 0.5 } }} />)
    const layer = screen.getByTestId('touch-marks')
    expect(layer.getAttribute('data-anchor')).toBe('50,50')
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
})
