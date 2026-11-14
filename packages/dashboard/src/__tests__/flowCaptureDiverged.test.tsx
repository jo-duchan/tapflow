import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RawStep } from '@tapflowio/flow-runner/browser'
import { MatchScreen } from '@/components/flow-capture/screens'
import { initialState, isRunning, reduce, type CaptureState } from '@/lib/flowCapture/machine'

// 1b-3b: Match stops at a step whose screen looks different from its recording, and the person decides.
afterEach(cleanup)

const step = (kind: string, over: Record<string, unknown> = {}): RawStep =>
  ({ at: 0, endAt: 0, outcome: 'landed', messages: [], kind, point: [0.5, 0.5], ...over }) as unknown as RawStep
// No clean start: #1 launch, #2–#3 taps in the app (signing in), #4 launch again — the default start, the last launch —
// and #5–#6 taps.
const steps = [
  step('launch', { buildId: 7 }), step('tap', { onHome: false }), step('tap', { onHome: false }),
  step('launch', { buildId: 7 }), step('tap', { onHome: false }), step('tap', { onHome: false }),
]
const loaded = reduce(initialState, { type: 'loaded', steps, range: { start: 3, end: 6 }, name: 'f' })
const matching = reduce(loaded, { type: 'match-started', total: 3 })
const divergence = { index: 4, diff: 0.2, recordedUrl: '/thumb/r5', nowUrl: 'blob:now', masks: [{ x: 0, y: 0, width: 1, height: 0.055 }] }
const stopped = (state: CaptureState) => reduce(state, { type: 'diverged', ...divergence })

describe('the dialog\'s state at a step that looked different', () => {
  it('waits on Match with what was measured, and goes on when the person does', () => {
    const waiting = stopped(matching)
    expect(waiting.phase).toBe('matching')
    expect(waiting.diverged).toMatchObject({ index: 4, diff: 0.2 })
    // Still a run: the stepper is not for leaving it, the buttons are.
    expect(isRunning(waiting)).toBe(true)
    expect(reduce(waiting, { type: 'went-on' }).diverged).toBeUndefined()
  })

  it('moves a default start back to take in the steps before it, and says so', () => {
    const back = reduce(stopped(matching), { type: 'back-to-range' })
    expect(back.phase).toBe('range')
    expect(loaded.range.start).toBe(3)
    expect(back.range).toEqual({ start: 1, end: 6 })
    expect(back.moved).toEqual([1, 2])
    expect(back.diverged).toBeUndefined()
    // The note is about that move: a range changed again is the person's own.
    expect(reduce(back, { type: 'set-range', range: { start: 2, end: 6 } }).moved).toBeUndefined()
  })

  it('leaves a start the person chose where it is', () => {
    const chosen = reduce(reduce(loaded, { type: 'set-range', range: { start: 4, end: 6 } }), { type: 'match-started', total: 2 })
    const back = reduce(stopped(chosen), { type: 'back-to-range' })
    expect(back.range).toEqual({ start: 4, end: 6 })
    expect(back.moved).toBeUndefined()
  })

  it('does not reach back past the last clean start', () => {
    const cleared = [step('launch', { buildId: 7 }), step('tap', { onHome: false }), step('clearState', { bundleId: 'b' }), step('launch', { buildId: 7 }), step('tap', { onHome: false })]
    const state = reduce(reduce(initialState, { type: 'loaded', steps: cleared, range: { start: 3, end: 5 }, name: 'f' }), { type: 'match-started', total: 2 })
    expect(reduce(stopped(state), { type: 'back-to-range' }).range).toEqual({ start: 3, end: 5 })
  })

  // Review of 1b-3b: a run stopped by Back to Range or Edit what matched answers after the dialog has moved on.
  it('takes no failure from a run the dialog has left', () => {
    const back = reduce(stopped(matching), { type: 'back-to-range' })
    expect(reduce(back, { type: 'match-failed', error: 'The replay stopped.' }).error).toBeNull()
    const edit = reduce(stopped(matching), { type: 'match-finished', captured: { steps: [], secrets: {}, launchAdded: false } })
    expect(reduce(edit, { type: 'match-failed', error: 'The replay stopped.' }).error).toBeNull()
  })

  // Found by the same review, and older than it: Stop, Edit what matched, Verify began as failed.
  it('starts Edit and Verify without the stop\'s message', () => {
    const stoppedRun = reduce(matching, { type: 'match-failed', error: 'The replay stopped.' })
    const edit = reduce(stoppedRun, { type: 'match-finished', captured: { steps: [], secrets: {}, launchAdded: false } })
    expect(edit.error).toBeNull()
    expect(reduce({ ...edit, error: 'left over' }, { type: 'verify-started' }).error).toBeNull()
  })

  it('counts the steps the replay added at the end, which Edit what matched leaves out', () => {
    const matched = { raw: steps[4]!, step: null } as never
    let state = reduce(matching, { type: 'step-matched', step: matched })
    state = reduce(state, { type: 'step-matched', step: matched, inserted: true })
    expect(state.insertedTail).toBe(1)
    expect(state.progress.done).toBe(1)
    expect(reduce(state, { type: 'step-matched', step: matched }).insertedTail).toBe(0)
  })
})

describe('Match stopped at a step that looked different', () => {
  const handlers = () => ({
    tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, onStop: vi.fn(), onRestart: vi.fn(),
    onTakeWhatMatched: vi.fn(), onBackToRange: vi.fn(), onContinueAnyway: vi.fn(), stopRef: { current: null },
  })

  it('shows both pictures, the facts, and the three buttons in their places', () => {
    const one = reduce(matching, { type: 'step-matched', step: { raw: steps[3]!, step: null } as never })
    const props = handlers()
    render(<MatchScreen state={stopped(one)} {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent('Step 2 of 3 doesn’t look like it did when you recorded it')
    expect(screen.getByText(/#2–#3 come before the range: Back to Range starts it there\. 1 step before it matched\./)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'When you recorded #5' })).toHaveAttribute('src', '/thumb/r5')
    expect(screen.getByRole('img', { name: 'Now, on the replay' })).toHaveAttribute('src', 'blob:now')
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit what matched', 'Back to Range', 'Continue anyway'])
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    expect(props.onContinueAnyway).toHaveBeenCalled()
  })

  // E2E of 1b-3b: "Back to Range starts it there" was said of a start the person had chosen, which it leaves.
  it('promises the move only for a start still at its default', () => {
    const chosen = reduce(reduce(loaded, { type: 'set-range', range: { start: 4, end: 6 } }), { type: 'match-started', total: 2 })
    render(<MatchScreen state={reduce(chosen, { type: 'diverged', ...divergence, index: 5 })} {...handlers()} />)
    expect(screen.getByText(/#2–#3 come before the range\. Compare/)).toBeInTheDocument()
    expect(screen.queryByText(/starts it there/)).not.toBeInTheDocument()
  })

  // Record-time observation: a tap left out before the replay is the first suspect for the step after it.
  it('names a tap left out for stopping a moving list, before the step that differs', () => {
    const withDrop = [...steps.slice(0, 4), step('tap', { onHome: false, dropped: 'stopped-scroll' }), step('tap', { onHome: false })]
    const state = reduce(reduce(initialState, { type: 'loaded', steps: withDrop, range: { start: 3, end: 6 }, name: 'f' }), { type: 'match-started', total: 3 })
    render(<MatchScreen state={reduce(state, { type: 'diverged', ...divergence, index: 5 })} {...handlers()} />)
    expect(screen.getByText(/#5 was not replayed: tapped while a list was still moving, which only stops it\./)).toBeInTheDocument()
  })

  it('offers Edit what matched only when something matched, moving nothing else', () => {
    render(<MatchScreen state={stopped(matching)} {...handlers()} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Back to Range', 'Continue anyway'])
  })
})
