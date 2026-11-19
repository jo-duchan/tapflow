import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useFollowBottom } from '@/hooks/useFollowBottom'

// Verify's step list and MCP's Agent activity follow the newest line until the reader scrolls up (the user's report:
// a long Verify ran below the dialog's fold). jsdom has no layout, so the box's heights are set by hand.
function Log({ lines }: { lines: string[] }) {
  const follow = useFollowBottom<HTMLOListElement>(lines)
  // Rendered only once there is something to show, as Verify's list is.
  if (lines.length === 0) return null
  return <ol data-testid="log" ref={follow}>{lines.map((l) => <li key={l}>{l}</li>)}</ol>
}

function sized(el: HTMLElement, scrollHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
}

describe('useFollowBottom', () => {
  it('moves to the newest line while the reader is at the bottom', () => {
    const { getByTestId, rerender } = render(<Log lines={['a']} />)
    const box = getByTestId('log')
    sized(box, 500)
    rerender(<Log lines={['a', 'b']} />)
    expect(box.scrollTop).toBe(500)
  })

  it('leaves a reader who scrolled up where they are, and follows again once they are back at the bottom', () => {
    const { getByTestId, rerender } = render(<Log lines={['a']} />)
    const box = getByTestId('log')
    sized(box, 500)
    box.scrollTop = 120
    fireEvent.scroll(box)
    rerender(<Log lines={['a', 'b']} />)
    expect(box.scrollTop).toBe(120)
    box.scrollTop = 400
    fireEvent.scroll(box)
    sized(box, 700)
    rerender(<Log lines={['a', 'b', 'c']} />)
    expect(box.scrollTop).toBe(700)
  })

  it('follows a list that appears only after its first line, and hears the reader on it', () => {
    const { getByTestId, rerender } = render(<Log lines={[]} />)
    rerender(<Log lines={['a']} />)
    const box = getByTestId('log')
    sized(box, 500)
    box.scrollTop = 50
    fireEvent.scroll(box)
    rerender(<Log lines={['a', 'b']} />)
    expect(box.scrollTop).toBe(50)
  })

  it('turns scroll anchoring off, whose own scroll events read as the reader leaving the bottom', () => {
    const { getByTestId } = render(<Log lines={['a']} />)
    expect(getByTestId('log').style.overflowAnchor).toBe('none')
  })
})
