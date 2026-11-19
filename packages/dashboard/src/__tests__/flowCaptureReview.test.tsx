import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import { EditScreen, MatchScreen } from '@/components/flow-capture/screens'
import { ReleaseAccordion } from '@/components/app-center/ReleaseAccordion'
import { canGoTo, initialState, isRunning, matchEnded, reduce, reviewedCapture, reviewTaps, type CaptureState } from '@/lib/flowCapture/machine'

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

  it('waits for the review only when the app ignored some taps', () => {
    expect(matchEnded(steps, matched).type).toBe('match-reviewed')
    expect(matchEnded(steps, [matched[1]!])).toMatchObject({ type: 'match-finished' })
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

  // User (P2c): the recorded picture is 160 px wide; the replay's own, of the same screen, is drawn instead.
  it('shows the replay\'s picture of a card\'s screen where it has one, the recording\'s where not', () => {
    let state = matching
    state = reduce(state, { type: 'step-matched', step: matched[0]!, screenshot: 'blob:replay-title' })
    state = reduce(state, { type: 'step-matched', step: matched[1]! })
    state = reduce(state, { type: 'step-matched', step: matched[2]! })
    state = reduce(state, { type: 'match-reviewed', review: { matched, taps: reviewTaps(steps, matched) } })
    render(<MatchScreen {...props(state)} />)
    fireEvent.click(screen.getByRole('button', { name: /will be left out/ }))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:replay-title')
    expect(screen.getByText('#1 on the replay')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('checkbox', { name: /#3 tapOn/ }))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:plus')
    expect(screen.getByText('#3 as you recorded it')).toBeInTheDocument()
  })

  // CodeRabbit on #1171: a turned picture at a fixed height in a narrow column was squeezed.
  it('fills by height only while the picture is upright', () => {
    let state = matching
    for (const m of matched) state = reduce(state, { type: 'step-matched', step: m, screenshot: 'blob:wide' })
    state = reduce(state, { type: 'match-reviewed', review: { matched, taps: reviewTaps(steps, matched) } })
    render(<MatchScreen {...props(state)} />)
    fireEvent.click(screen.getByRole('button', { name: /will be left out/ }))
    const img = screen.getByRole('img')
    expect(img.className).toContain('h-[var(--picture-max,60vh)]')
    Object.defineProperty(img, 'naturalWidth', { value: 1600 })
    Object.defineProperty(img, 'naturalHeight', { value: 900 })
    fireEvent.load(img)
    expect(img.className).not.toContain(' h-[var(--picture-max,60vh)]')
    expect(img.className).toContain('h-auto')
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

// User decision (2026-11-15): a tap the review left out can be put back in Edit, without another Match.
describe('putting a left-out tap back in Edit', () => {
  const edit = reduce(reviewing, { type: 'review-continued' })

  it('continues to Edit with the review kept, and puts a tap back in its place, asking for Verify again', () => {
    expect(edit.phase).toBe('edit')
    expect(edit.review).toBeUndefined()
    expect(edit.captured!.steps.map((s) => s.skipped ?? s.step?.type)).toEqual(['no-response', 'tapOn', 'no-response'])
    const verified = { ...edit, reached: 4, verify: { status: 'passed' as const, done: 3, live: [] } }
    const back = reduce(verified, { type: 'put-back', step: 2 })
    expect(back.captured!.steps.map((s) => s.skipped ?? s.step?.type)).toEqual(['no-response', 'tapOn', 'tapOn'])
    expect(back.kept).toEqual([2])
    expect(back.verify).toBeNull()
    // A replay forgets the review it came from.
    expect(reduce(back, { type: 'match-started', total: 3 }).reviewed).toBeUndefined()
  })

  it('offers put back on a left-out row, in place of remove', () => {
    const dispatch = vi.fn()
    render(<EditScreen state={edit} dispatch={dispatch} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />)
    const back = screen.getAllByRole('button', { name: /back in the flow/ })
    expect(back).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
    fireEvent.click(back[1]!)
    expect(dispatch).toHaveBeenCalledWith({ type: 'put-back', step: 2 })
  })
})

// Pre-PR review of P2c.
describe('the review, as reviewed', () => {
  it('does not offer, from what matched so far, a tap Match saw change the screen', () => {
    let state = matching
    for (const m of matched) state = reduce(state, { type: 'step-matched', step: m })
    state = reduce(state, { type: 'step-observed', index: 0, observed: { appear: [{ text: 'Menu' }] } })
    const ended = matchEnded(steps, state.matched)
    expect(ended.type === 'match-reviewed' && ended.review.taps.map((t) => t.step)).toEqual([2])
  })

  it('keeps no stop message at a review: the stop is what took Match as far as it got', () => {
    expect(reduce(reviewing, { type: 'match-failed', error: 'The replay stopped.' }).error).toBeNull()
  })

  it('names the open list by its summary', () => {
    render(<MatchScreen state={reviewing} tap={{ surface: () => null } as never} marks={{ cursor: null, trails: [] }} onStop={vi.fn()} onRestart={vi.fn()}
      onTakeWhatMatched={vi.fn()} onBackToRange={vi.fn()} onContinueAnyway={vi.fn()} stopRef={{ current: null }} onContinueToEdit={vi.fn()} onKeep={vi.fn()} thumbnailOf={() => null} />)
    fireEvent.click(screen.getByRole('button', { name: /will be left out/ }))
    expect(screen.getByRole('region', { name: /will be left out/ })).toBeInTheDocument()
  })

  it('draws no region landmark for an open release', () => {
    render(<ReleaseAccordion versionName="1.0" builds={[]} isOpen onToggle={vi.fn()} onNavigate={vi.fn()} onStatusChange={vi.fn()}
      onScheduleDeletion={vi.fn()} onCancelDeletion={vi.fn()} onEdit={vi.fn()} canWrite />)
    expect(screen.getByRole('button', { name: /1\.0/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})
