import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RangeScreen } from '@/components/flow-capture/screens'
import { initialState, reduce, type CaptureState } from '@/lib/flowCapture/machine'
import { copy } from '@/lib/flowCapture/copy'

// #1227: the strip's tiles, and the tooltip each has (its full name, why it has no picture), reached by the keyboard.
// Agreed order: start handle, end handle, the strip as one stop, the Put back / Leave out buttons in step order, Name.
afterEach(cleanup)

const base = { at: 0, endAt: 0, outcome: 'landed', messages: [] }
const tap = (extra: object = {}) => ({ ...base, kind: 'tap', point: [0.5, 0.5], ...extra })
// Five taps, the range #2–#4; #1 and #5 are left out before the replay, so each has a button, before and after the range.
const loaded = reduce(initialState, {
  type: 'loaded', range: { start: 1, end: 4 }, name: 'f',
  steps: [tap({ dropped: 'retried' }), tap(), tap({ thumbnailKey: 'gone' }), tap(), tap({ dropped: 'stopped-scroll' })] as never,
})

const draw = (state: CaptureState = loaded) => render(
  <RangeScreen state={state} dispatch={vi.fn()} bundleId="com.example" platform="ios" onContinue={vi.fn()} onCancel={vi.fn()} continueRef={{ current: null }}
    thumbnailOf={() => null} noPictureWhy={(s) => (s.thumbnailKey === 'gone' ? copy.noPicture.keyboard : null)} />,
)
const tiles = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('ol[aria-label] > li')]

describe('the Range strip by keyboard', () => {
  it('is one stop between the handles and the buttons, which come in step order before Name', async () => {
    const { container } = draw()
    screen.getByRole('button', { name: copy.dropLast }).focus()
    const order: Array<Element | null> = []
    for (let i = 0; i < 5; i++) { await userEvent.tab(); order.push(document.activeElement) }
    expect(order).toEqual([
      screen.getByRole('slider', { name: copy.rangeStart }),
      screen.getByRole('slider', { name: copy.rangeEnd }),
      tiles(container)[1],
      screen.getByRole('button', { name: copy.putBackTile(1) }),
      screen.getByRole('button', { name: copy.putBackTile(5) }),
    ])
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByLabelText(copy.nameLabel))
  })

  it('moves between tiles with the arrows, Home and End, with one tile tabbable', () => {
    const { container } = draw()
    const t = tiles(container)
    expect(t.map((li) => li.tabIndex)).toEqual([-1, 0, -1, -1, -1])
    t[1]!.focus()
    fireEvent.keyDown(t[1]!, { key: 'ArrowRight' })
    expect(t[2]).toHaveFocus()
    fireEvent.keyDown(t[2]!, { key: 'End' })
    expect(t[4]).toHaveFocus()
    fireEvent.keyDown(t[4]!, { key: 'ArrowRight' })
    expect(t[4]).toHaveFocus()
    fireEvent.keyDown(t[4]!, { key: 'Home' })
    expect(t[0]).toHaveFocus()
    fireEvent.keyDown(t[0]!, { key: 'ArrowLeft' })
    expect(t[0]).toHaveFocus()
    fireEvent.keyDown(t[0]!, { key: 'ArrowRight' })
    expect(tiles(container).map((li) => li.tabIndex)).toEqual([-1, 0, -1, -1, -1])
  })

  it('comes back to the tile it left', async () => {
    const { container } = draw()
    const t = tiles(container)
    t[1]!.focus()
    fireEvent.keyDown(t[1]!, { key: 'ArrowRight' })
    fireEvent.keyDown(t[2]!, { key: 'ArrowRight' })
    await userEvent.tab()
    await userEvent.tab({ shift: true })
    expect(t[3]).toHaveFocus()
  })

  it('opens the tile’s tooltip on focus: its full name, and why it has no picture', async () => {
    const { container } = draw()
    const t = tiles(container)
    t[1]!.focus()
    fireEvent.keyDown(t[1]!, { key: 'ArrowRight' })
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain(copy.noPicture.keyboard)
  })

  // The user's (2026-11-23): the ring sits inside the frame's padding and overlaps nothing — the frame, a button, the tooltip.
  it('draws the ring inside the tile, which holds no button, at full strength', () => {
    const { container } = draw()
    const t = tiles(container)
    // An outline drawn 2 px inside the tile's own box, which ends above the button row.
    expect(t[1]!.className).toContain('focus-visible:outline-offset-[-4px]')
    // #1 has a Put back button, and it is not in the tile.
    expect(t[0]!.querySelector('button')).toBeNull()
    expect(screen.getByRole('button', { name: copy.putBackTile(1) })).toBeInTheDocument()
    // Out of the range and dimmed, the ring is not: the content is. #1 is both out of the range and left out, as before.
    expect(t[0]!.className).not.toMatch(/\bopacity-/)
    expect(t[0]!.querySelector('.opacity-25')).not.toBeNull()
    expect(t[1]!.querySelector('.opacity-50, .opacity-25')).toBeNull()
  })

  it('places each button under its own tile', () => {
    const { container } = draw()
    const button = screen.getByRole('button', { name: copy.putBackTile(5) })
    expect(button.closest<HTMLElement>('[data-under]')!.style.left).toBe(tiles(container)[4]!.style.left)
  })
})
