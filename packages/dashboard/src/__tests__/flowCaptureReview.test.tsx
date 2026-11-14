import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import { MatchScreen } from '@/components/flow-capture/screens'
import { canGoTo, initialState, isRunning, reduce, reviewedCapture, reviewTaps, type CaptureState } from '@/lib/flowCapture/machine'

// P2c: taps the app did not respond to when recorded wait at Match's end, to be kept or (by default) left out.
const tap = (label: string, touched?: { acted?: boolean; tapCount?: number }): RawStep => ({
  kind: 'tap', point: [0.5, 0.5], messages: [], at: 0, onHome: false,
  ...(touched ? { touched: { point: { x: 0.5, y: 0.5 }, moving: false, ...touched } } : {}),
  label,
}) as unknown as RawStep
const named = (raw: RawStep): CapturedStep => ({ raw, step: { type: 'tapOn', selector: { label: (raw as unknown as { label: string }).label } } })

const steps = [tap('Title', { acted: false }), tap('Buy', { acted: true }), tap('Plus', { acted: false, tapCount: 2 })]
const matched = steps.map(named)
const loaded = reduce(initialState, { type: 'loaded', steps, range: { start: 0, end: 3 }, name: 'f' })
const matching = reduce(loaded, { type: 'match-started', total: 3 })
const reviewing = reduce(matching, { type: 'match-reviewed', review: { matched, taps: reviewTaps(steps, matched) } })

describe('the review state', () => {
  it('offers the taps the app did not respond to, by their step in the recording', () => {
    expect(reviewTaps(steps, matched)).toEqual([{ index: 0, step: 0, repeat: false }, { index: 2, step: 2, repeat: true }])
    // A matched step that is not the recording's own (made by the replay) is not offered.
    expect(reviewTaps(steps, [named(tap('Copy', { acted: false }))])).toEqual([])
  })

  // Design review of P2c: the review kept phase `matching`, which read as a run still going.
  it('is not a run: the stepper leads back to Range, and a replay clears it but keeps what was kept', () => {
    expect(isRunning(matching)).toBe(true)
    expect(isRunning(reviewing)).toBe(false)
    expect(canGoTo(reviewing, 0)).toBe(true)
    const kept = reduce(reviewing, { type: 'set-kept', step: 2, kept: true })
    const again = reduce(kept, { type: 'match-started', total: 3 })
    expect(again.review).toBeUndefined()
    expect(again.kept).toEqual([2])
    expect(reduce(reviewing, { type: 'back-to-range' }).review).toBeUndefined()
  })

  it('leaves out what was not kept, and only that', () => {
    const kept = reduce(reviewing, { type: 'set-kept', step: 2, kept: true })
    const captured = reviewedCapture(kept.review!, kept.kept)
    expect(captured.steps.map((s) => s.skipped ?? s.step?.type)).toEqual(['no-response', 'tapOn', 'tapOn'])
    const unkept = reduce(kept, { type: 'set-kept', step: 2, kept: false })
    expect(reviewedCapture(unkept.review!, unkept.kept).steps.map((s) => s.skipped ?? s.step?.type)).toEqual(['no-response', 'tapOn', 'no-response'])
  })

  it('goes to Edit on match-finished, without the review', () => {
    const edit = reduce(reviewing, { type: 'match-finished', captured: reviewedCapture(reviewing.review!, []) })
    expect(edit.phase).toBe('edit')
    expect(edit.review).toBeUndefined()
  })
})

describe('the review screen', () => {
  const props = (state: CaptureState) => ({
    state, tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, onStop: vi.fn(), onRestart: vi.fn(),
    onTakeWhatMatched: vi.fn(), onBackToRange: vi.fn(), onContinueAnyway: vi.fn(), stopRef: { current: null },
    onContinueToEdit: vi.fn(), onKeep: vi.fn(), thumbnailOf: (s: RawStep) => (s === steps[2] ? 'blob:plus' : 'blob:title'),
  })

  it('says in one line what will be left out, and Continue alone accepts it', () => {
    const p = props(reviewing)
    render(<MatchScreen {...p} />)
    expect(screen.getByRole('status')).toHaveTextContent('Done')
    expect(screen.getByRole('button', { name: '2 taps the app didn’t respond to will be left out.' })).toHaveAttribute('aria-expanded', 'false')
    // Closed, nothing to check is in the page.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Edit' }))
    expect(p.onContinueToEdit).toHaveBeenCalled()
  })

  it('opens onto one card per tap, a repeat tagged, and keeps one when checked', () => {
    const p = props(reviewing)
    render(<MatchScreen {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /will be left out/ }))
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(screen.getByRole('checkbox', { name: /#3 tapOn\(label="Plus"\)/ })).toBeInTheDocument()
    expect(screen.getAllByText('again')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: /#3 tapOn\(label="Plus"\)/ }))
    expect(p.onKeep).toHaveBeenCalledWith(2, true)
  })

  it('shows the screen a card was tapped on, and counts what is kept', () => {
    const kept = reduce(reviewing, { type: 'set-kept', step: 2, kept: true })
    render(<MatchScreen {...props(kept)} />)
    fireEvent.click(screen.getByRole('button', { name: '1 of 2 taps the app didn’t respond to will be left out.' }))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:title')
    fireEvent.focus(screen.getByRole('checkbox', { name: /#3 tapOn\(label="Plus"\)/ }))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:plus')
    expect(screen.getByText('#3 as you recorded it')).toBeInTheDocument()
  })
})
