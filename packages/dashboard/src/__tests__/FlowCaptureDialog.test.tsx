import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CaptureEntry, CaptureSnapshot } from '@tapflowio/protocol/capture'
import type { CapturedStep } from '@tapflowio/flow-runner/browser'
import FlowCaptureDialog from '@/components/flow-capture/FlowCaptureDialog'
import { EditScreen, ExportScreen, MatchScreen, RangeScreen, VerifyScreen } from '@/components/flow-capture/screens'
import { initialState, reduce } from '@/lib/flowCapture/machine'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { withQuery } from './withQuery'

// Flow Capture's dialog (#1125), found by role and name only: its look is still moving, its order is not.

const tap: CaptureTap = {
  sessionId: 's1', platform: 'ios', buildId: 7,
  send: () => true, subscribe: () => () => {}, onConnectionLost: () => () => {}, connected: () => true,
  chrome: () => null, postures: () => ({ postures: [], currentId: null }), surface: () => null,
}

const entry = (at: number, msg: Record<string, unknown>): CaptureEntry => ({ at, kind: 'input', msg: { sessionId: 's1', ...msg } as never })
const snapshot: CaptureSnapshot = {
  id: 'snap', takenAt: 0, thinned: false,
  entries: [
    entry(0, { type: 'app:install', requestId: 'i', buildId: 7 }),
    entry(100, { type: 'app:launch', requestId: 'l', buildId: 7 }),
    entry(200, { type: 'input:touch:start', payload: { x: 0.4, y: 0.6 } }),
    entry(280, { type: 'input:touch:end', requestId: 't' }),
  ],
}

function relay(over: { snapshot?: CaptureSnapshot | null } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/capture/snapshot') && method === 'POST') {
      const s = over.snapshot === undefined ? snapshot : over.snapshot
      return s ? new Response(JSON.stringify(s), { status: 200 }) : new Response('{}', { status: 404 })
    }
    if (url === '/api/v1/builds/7') return new Response(JSON.stringify({ id: 7, bundle_id: 'com.example.app' }), { status: 200 })
    return new Response('{"ok":true}', { status: 200 })
  })
}

afterEach(() => vi.restoreAllMocks())

function open(onClose = vi.fn()) {
  const returnFocusRef = { current: null as HTMLButtonElement | null }
  render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={returnFocusRef} onClose={onClose} />))
  return onClose
}

describe('FlowCaptureDialog', () => {
  it('opens on Range with the steps since the launch, the app it will clear, and where it stands', async () => {
    relay()
    open()
    const dialog = await screen.findByRole('dialog', { name: 'Capture flow' })
    const progress = await within(dialog).findByRole('list', { name: 'Progress' })
    expect(within(progress).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step')
    // Install, launch, tap: the range starts at the launch.
    expect(await within(dialog).findByText('2 steps · #2 – #3')).toBeInTheDocument()
    expect(within(within(dialog).getByRole('list', { name: 'Steps' })).getAllByRole('listitem')).toHaveLength(3)
    expect(within(dialog).getByRole('slider', { name: 'Start of the flow' })).toHaveAttribute('aria-valuenow', '2')
    expect(within(dialog).getByRole('slider', { name: 'End of the flow' })).toHaveAttribute('aria-valuetext', expect.stringMatching(/^#3, tapOn 40%, 60%/))
    expect(await within(dialog).findByText('com.example.app')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  const calls = (fetch: ReturnType<typeof relay>, method: string, path: string) =>
    fetch.mock.calls.filter(([u, i]) => String(u).endsWith(path) && (i?.method ?? 'GET') === method)

  // Review of #1125: the session ended under an open dialog and the viewer unmounted it; nothing gave the relay back
  // its recording, and the pause lease went on renewing from this tab.
  it('gives the relay back its recording once when it is taken away mid-replay', async () => {
    const fetch = relay()
    const returnFocusRef = { current: null as HTMLButtonElement | null }
    const { unmount } = render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={returnFocusRef} onClose={vi.fn()} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(calls(fetch, 'PUT', '/capture/pause')).toHaveLength(1))
    unmount()
    await waitFor(() => expect(calls(fetch, 'DELETE', '/capture/pause')).toHaveLength(1))
  })

  // Another tab of the same person may hold the pause; a dialog that never asked for it does not give it back.
  it('gives nothing back when it never replayed', async () => {
    const fetch = relay()
    const returnFocusRef = { current: null as HTMLButtonElement | null }
    const { unmount } = render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={returnFocusRef} onClose={vi.fn()} />))
    await screen.findByRole('button', { name: 'Continue' })
    unmount()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls(fetch, 'DELETE', '/capture/pause')).toHaveLength(0)
  })

  // StrictMode runs an effect's cleanup once at mount. Made during render and ended in that cleanup, the dialog's
  // channel was closed before the person pressed anything, and the replay failed on it.
  it('replays under StrictMode, and gives the relay back its recording once when taken away', async () => {
    const fetch = relay()
    // Listening to the viewer is what a closed channel stops doing: every answer the replay waits for comes this way.
    const listeners = new Set<unknown>()
    const listened: CaptureTap = { ...tap, subscribe: (h) => { listeners.add(h); return () => listeners.delete(h) } }
    const returnFocusRef = { current: null as HTMLButtonElement | null }
    const { unmount } = render(<StrictMode>{withQuery(<FlowCaptureDialog tap={listened} returnFocusRef={returnFocusRef} onClose={vi.fn()} />)}</StrictMode>)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await waitFor(() => expect(calls(fetch, 'PUT', '/capture/pause')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByText(/closed/)).toBeNull()
    expect(calls(fetch, 'DELETE', '/capture/pause')).toHaveLength(0)
    expect(listeners.size).toBe(1)
    unmount()
    await waitFor(() => expect(calls(fetch, 'DELETE', '/capture/pause')).toHaveLength(1))
    expect(listeners.size).toBe(0)
  })

  it('says nothing was captured when the capture holds no step, only a turn of the device', async () => {
    relay({ snapshot: { id: 'snap', takenAt: 0, thinned: false, entries: [{ at: 0, kind: 'chrome', chrome: { bodyRotation: 90 } }] } })
    open()
    expect(await screen.findByText(/No steps have been captured/)).toHaveAttribute('role', 'status')
  })

  it('says so when nothing was captured', async () => {
    relay({ snapshot: null })
    open()
    expect(await screen.findByText(/No steps have been captured/)).toHaveAttribute('role', 'status')
  })

  it('moves an edge a step per arrow, and stops a step short of the other edge', async () => {
    relay()
    open()
    const start = await screen.findByRole('slider', { name: 'Start of the flow' })
    start.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByText('3 steps · #1 – #3')).toBeInTheDocument()
    await userEvent.keyboard('{End}')
    expect(screen.getByText('1 step · #3 – #3')).toBeInTheDocument()
    const end = screen.getByRole('slider', { name: 'End of the flow' })
    end.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByText('1 step · #3 – #3')).toBeInTheDocument()
  })

  it('names the step at a handle while it is focused, and while it is dragged', async () => {
    relay()
    open()
    const start = await screen.findByRole('slider', { name: 'Start of the flow' })
    start.focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('#2, launch')
    start.blur()
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // A press closes a Radix tooltip; a drag is when the name is wanted most.
    fireEvent.pointerDown(start, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 40 })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('#1, install')
    fireEvent.pointerUp(start, { pointerId: 1, clientX: 40 })
  })

  it('moves an edge to the boundary nearest where its handle is dragged', async () => {
    relay()
    open()
    const start = await screen.findByRole('slider', { name: 'Start of the flow' })
    // Tiles are 96 px, 104 apart from 12 px in, and the range's frame moves the steps after each edge 26 px along:
    // with #1 outside the range its middle is at 60, so 40 is nearest the boundary before it.
    fireEvent.pointerDown(start, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 40 })
    expect(screen.getByText('3 steps · #1 – #3')).toBeInTheDocument()
    // Judged where #1 is drawn now, not where it was: taken in, it moved along, so 70 is still left of its middle.
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 70 })
    expect(screen.getByText('3 steps · #1 – #3')).toBeInTheDocument()
    // #1 now sits inside the frame, its middle at 86: just past it, the nearest boundary is the one after #1.
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 100 })
    expect(screen.getByText('2 steps · #2 – #3')).toBeInTheDocument()
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 40 })
    fireEvent.pointerUp(start, { pointerId: 1, clientX: 40 })
    // Released, a move no longer drags.
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 300 })
    expect(screen.getByText('3 steps · #1 – #3')).toBeInTheDocument()
  })

  // The dialog only asks to be closed; what it opened ends when the viewer takes it away (above), and the copy of the
  // steps is the viewer's to drop (DeviceViewer.inputError.test.tsx).
  it('asks to be closed on Cancel', async () => {
    relay()
    const onClose = open()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('EditScreen — Verify', () => {
  const step = (over: Partial<CapturedStep>): CapturedStep => ({
    raw: { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'network', offline: true }, step: null, skipped: 'network', ...over,
  })
  const edit = (steps: CapturedStep[], removed: number[] = []) => render(
    <EditScreen state={{ ...initialState, phase: 'edit', captured: { steps, launchAdded: false, secrets: {} }, removed }}
      dispatch={vi.fn()} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />,
  )

  it('cannot verify a flow left with no step a flow can say', () => {
    const tapStep = step({ raw: { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'tap', point: [0.4, 0.6] }, step: { type: 'tapPoint', at: [0.4, 0.6] }, skipped: undefined })
    edit([step({}), tapStep])
    expect(screen.getByRole('button', { name: 'Verify and export' })).toBeEnabled()
    cleanup()
    edit([step({}), tapStep], [1])
    expect(screen.getByRole('button', { name: 'Verify and export' })).toBeDisabled()
  })
})

// #1140: a password typed on the soft keyboard is the person's to give, before Match replays it.
describe('RangeScreen', () => {
  const base = { at: 0, endAt: 0, outcome: 'landed', messages: [] }
  const steps = [
    { ...base, kind: 'launch', buildId: 7 },
    { ...base, kind: 'text', text: '', replace: true, fieldRead: 'secure', askValue: true },
  ] as never
  const loaded = reduce(initialState, { type: 'loaded', steps, range: { start: 0, end: 2 }, name: 'login' })
  const draw = (state = loaded, dispatch = vi.fn()) => render(
    <RangeScreen state={state} dispatch={dispatch} bundleId="com.example" platform="ios" onContinue={vi.fn()} onCancel={vi.fn()} continueRef={{ current: null }} />,
  )

  // 1b-3b: the screen each step began on, and a mark where none is kept on purpose.
  it('draws the screen a step began on, and marks a key on the soft keyboard as kept without one', () => {
    const pictured = reduce(initialState, {
      type: 'loaded', range: { start: 0, end: 5 }, name: 'login',
      steps: [
        { ...base, kind: 'launch', buildId: 7, thumbnailKey: 'l' },
        { ...base, kind: 'tap', point: [0.5, 0.5], thumbnailKey: 't' },
        { ...base, kind: 'keyboardKey', point: [0.3, 0.8], thumbnailKey: 'k' },
        { ...base, kind: 'text', text: 'hi', thumbnailKey: 'h', messages: [{ at: 0, msg: { type: 'input:touch:end', sessionId: 's', requestId: 'h', payload: { x: 0.6, y: 0.8 } } }] },
        { ...base, kind: 'text', text: 'hi', thumbnailKey: 'c' },
      ] as never,
    })
    const { container } = render(
      <RangeScreen state={pictured} dispatch={vi.fn()} bundleId="com.example" platform="ios" onContinue={vi.fn()} onCancel={vi.fn()} continueRef={{ current: null }}
        thumbnailOf={(step) => (step.thumbnailKey === 't' ? '/pic/t' : null)} />,
    )
    const pictures = container.querySelectorAll('img')
    expect([...pictures].map((img) => img.getAttribute('src'))).toEqual(['/pic/t'])
    expect(pictures[0]).toHaveAttribute('alt', '')
    // A key, and a run typed with keys on it; not a run typed on the computer's keyboard.
    expect(screen.getAllByText('On-screen keyboard')).toHaveLength(2)
  })

  it('asks for the password, hidden, and holds Continue until it is given', async () => {
    const dispatch = vi.fn()
    draw(loaded, dispatch)
    const field = screen.getByLabelText('Password for step 2')
    expect(field).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await userEvent.type(field, 'x')
    expect(dispatch).toHaveBeenCalledWith({ type: 'set-asked', index: 1, value: 'x' })
  })

  it('says a password filled in from the computer\'s keyboard was filled in', () => {
    const typed = reduce(initialState, {
      type: 'loaded', range: { start: 0, end: 2 }, name: 'login',
      steps: [steps[0], { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'text', text: 'abc', replace: true, fieldRead: 'secure', askValue: true, field: 'form.password' }] as never,
    })
    draw(typed)
    expect(screen.getByLabelText('Password for step 2 form.password')).toHaveValue('abc')
    expect(screen.getByText(/Filled in from what you typed on your computer/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('lets Continue go once it is given', () => {
    draw(reduce(loaded, { type: 'set-asked', index: 1, value: 's3cret' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })
})

describe('EditScreen', () => {
  const raw = { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'tap', point: [0.3, 0.4] }
  const state = {
    ...initialState, phase: 'edit' as const, reached: 2,
    captured: { steps: [{ raw, step: { type: 'tapOn', selector: { text: 'Login' } } }], secrets: {}, launchAdded: false },
    screenshots: ['blob:shot'],
  } as never
  const draw = () => render(
    <EditScreen state={state} dispatch={vi.fn()} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />,
  )

  it('draws where the step touched on its picture', () => {
    draw()
    expect(screen.getByTestId('step-mark')).toBeInTheDocument()
  })

  it('draws a swipe as a dashed trail that strengthens toward where the finger lifted', () => {
    const swipe = { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'swipe', from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 200 }
    const swiped = { ...(state as object), captured: { steps: [{ raw: swipe, step: { type: 'tapOn', selector: { text: 'Login' } } }], secrets: {}, launchAdded: false } } as never
    render(<EditScreen state={swiped} dispatch={vi.fn()} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />)
    const mark = screen.getByTestId('step-mark')
    const line = mark.querySelector('line')!
    expect(line.getAttribute('stroke-dasharray')).toBe('1 9')
    expect(line.getAttribute('stroke')).toBe(`url(#${mark.querySelector('linearGradient')!.id})`)
    expect(mark.querySelector('linearGradient')!.getAttribute('y1')).toBe('70%')
  })

  // The YAML takes the picture's place, so the buttons stay where they are.
  it('shows the YAML in place of the picture, and the picture again when it is hidden', async () => {
    draw()
    await userEvent.click(screen.getByRole('button', { name: 'Show YAML' }))
    expect(screen.getByLabelText('Flow YAML')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide YAML' }))
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  // Review: on plain HTTP (no clipboard API) the copy icon did nothing; it selects the YAML for the keyboard instead.
  it('selects the YAML when the copy icon cannot copy, and names the block as a region', async () => {
    draw()
    await userEvent.click(screen.getByRole('button', { name: 'Show YAML' }))
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const yaml = screen.getByRole('region', { name: 'Flow YAML' })
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(document.activeElement).toBe(yaml))
    expect(window.getSelection()?.toString().length).toBeGreaterThan(0)
  })
})

describe('VerifyScreen', () => {
  // The count said the step it was on twice ("2 of 2") until the result came, and moved the line as it grew.
  it('counts through the flow\'s own steps, in the room of the widest count', () => {
    const running = { ...initialState, phase: 'verifying' as const, verify: { status: 'running' as const, done: 2, live: [] } }
    render(<VerifyScreen state={running} tap={{ surface: () => null } as never} marks={{ cursor: null, trails: [] }} total={15}
      onExport={vi.fn()} onBack={vi.fn()} primaryRef={{ current: null }} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Running step 3 of 15')
    expect(status.querySelector('[aria-hidden="true"].invisible')).toHaveTextContent('Running step 15 of 15')
  })

  // A Verify that threw (the device went away) has no result: its button, which held focus while it ran, goes back to
  // Edit rather than staying an unavailable "Export anyway".
  it('turns its button into Back to Edit, in place, when the run threw', async () => {
    const running = { ...initialState, phase: 'verifying' as const, verify: { status: 'running' as const, done: 1, live: [] } }
    const onBack = vi.fn()
    const props = { tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, total: 3, onExport: vi.fn(), onBack, primaryRef: { current: null } }
    const { rerender } = render(<VerifyScreen state={running} {...props} />)
    const button = screen.getByRole('button', { name: 'Continue' })
    button.focus()
    rerender(<VerifyScreen state={{ ...running, error: 'the connection to the relay closed' }} {...props} />)
    expect(screen.getAllByRole('button', { name: 'Back to Edit' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Export anyway' })).toBeNull()
    expect(button).toHaveFocus()
    expect(button).not.toHaveAttribute('aria-disabled')
    await userEvent.click(button)
    expect(onBack).toHaveBeenCalled()
  })

  // Drawn as MCP's Agent activity draws a run: the steps as they go, then the one that failed opened onto why.
  it('shows the steps as they run, and opens the failed one onto its reason and what to select instead', () => {
    const live = { ...initialState, phase: 'verifying' as const, verify: { status: 'running' as const, done: 1, live: [
      { index: 0, name: 'launchApp', status: 'passed' as const, startedAt: 0, durationMs: 1200 },
      { index: 1, name: 'tapOn("Row 23")', status: 'running' as const, startedAt: 1200 },
    ] } }
    const props = { tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, total: 3, onExport: vi.fn(), onBack: vi.fn(), primaryRef: { current: null } }
    const { rerender } = render(<VerifyScreen state={live} {...props} />)
    const list = screen.getByRole('list', { name: 'Verify' })
    expect(within(list).getByText('launchApp')).toBeInTheDocument()
    expect(within(list).getByText('1.2s')).toBeInTheDocument()
    expect(within(list).getByText(/, running/)).toBeInTheDocument()
    const failed = { ...live, verify: { ...live.verify, status: 'failed' as const, result: { status: 'failed', steps: [
      { index: 0, name: 'launchApp', status: 'passed', durationMs: 1200 },
      { index: 1, name: 'tapOn("Row 23")', status: 'failed', durationMs: 10000, message: 'no element matched "Row 23" within 10s',
        suggestions: [{ yaml: 'tapOn: "Row 22"', element: { role: 'button', label: 'Row 22' } }] },
      { index: 2, name: 'tapOn("Submit")', status: 'skipped', durationMs: 0 },
    ] } as never } }
    rerender(<VerifyScreen state={failed} {...props} />)
    const why = screen.getByRole('button', { name: /tapOn\("Row 23"\)/ })
    expect(why).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('tapOn: "Row 22"')).toBeInTheDocument()
    expect(screen.getByText(/, not run/)).toBeInTheDocument()
  })

  // #1125: a passed step whose touch the device could not judge opens onto why, since a covered row passed that way.
  it('opens a passed step onto a touch that was not checked to land on its element', () => {
    const props = { tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, total: 1, onExport: vi.fn(), onBack: vi.fn(), primaryRef: { current: null } }
    const passed = { ...initialState, phase: 'verifying' as const, verify: { status: 'passed' as const, done: 1, live: [], result: { status: 'passed', steps: [
      { index: 0, name: 'tapOn("Row 13")', status: 'passed', durationMs: 900, reach: 'unchecked', reachNote: 'old agent' },
      { index: 1, name: 'tapOn("Save")', status: 'passed', durationMs: 900, reach: 'verified' },
    ] } as never } }
    render(<VerifyScreen state={passed} {...props} />)
    expect(screen.getByRole('button', { name: /tapOn\("Row 13"\)/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Not checked to land on its element \(old agent\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /tapOn\("Save"\)/ })).toBeNull()
  })

  // #1125: an overlay the tree does not show takes a touch and the step still passes, so a touch that changed nothing
  // says so, and one that changed something says what a run will look for.
  it('says a touch changed nothing, open, and what a run checks after one that did, closed', () => {
    const props = { tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, total: 1, onExport: vi.fn(), onBack: vi.fn(), primaryRef: { current: null } }
    const passed = { ...initialState, phase: 'verifying' as const, verify: { status: 'passed' as const, done: 2, live: [], result: { status: 'passed', steps: [
      { index: 0, name: 'tapOn("Row 13")', status: 'passed', durationMs: 900, reach: 'verified', observed: null },
      { index: 1, name: 'tapOn("Save")', status: 'passed', durationMs: 900, reach: 'verified', observed: { appear: [{ text: 'Saved', role: 'text' }], gone: [{ id: 'save' }] } },
    ] } as never } }
    render(<VerifyScreen state={passed} {...props} />)
    expect(screen.getByRole('button', { name: /tapOn\("Row 13"\)/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Nothing on the screen changed after this touch/)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: /tapOn\("Save"\)/ })
    expect(save).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(save)
    expect(screen.getByText('A run checks that "Saved" appears, save goes after this touch.')).toBeInTheDocument()
  })
})

// #1139: Match and Verify start from a run's reset, and say what it did.
describe('the device reset', () => {
  const props = { tap: { surface: () => null } as never, marks: { cursor: null, trails: [] }, onStop: vi.fn(), onRestart: vi.fn(), onTakeWhatMatched: vi.fn(), onBackToRange: vi.fn(), onContinueAnyway: vi.fn(), stopRef: { current: null } }
  const matching = reduce({ ...initialState, phase: 'range' as const }, { type: 'match-started', total: 2 })

  it('says what was reset, by name, once the agent has answered', () => {
    const { rerender } = render(<MatchScreen state={matching} {...props} />)
    expect(screen.queryByText(/Reset before the replay/)).not.toBeInTheDocument()
    // The seconds the reset takes are not step 1 (pre-PR review of #1139).
    expect(screen.getByRole('status')).toHaveTextContent('Resetting the device…')
    rerender(<MatchScreen state={reduce(matching, { type: 'device-reset', report: { done: ['app-reinstall', 'keychain', 'pasteboard'], failed: [] } })} {...props} />)
    expect(screen.getByText('Reset before the replay: app reinstall, keychain, clipboard.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Step 1 of 2')
  })

  it('warns about what could not be reset, and about an agent that cannot reset at all', () => {
    const { rerender } = render(<MatchScreen state={reduce(matching, { type: 'device-reset', report: { done: [], failed: ['keychain'] } })} {...props} />)
    expect(screen.getByText(/Could not reset: keychain\./)).toBeInTheDocument()
    rerender(<MatchScreen state={reduce(matching, { type: 'device-reset', report: null })} {...props} />)
    expect(screen.getByText(/cannot reset it the way a run does/)).toBeInTheDocument()
  })

  // A report belongs to the replay it came before: Verify's own reset replaces Match's, not adds to it.
  it('forgets the last replay\'s report when the next starts', () => {
    const reported = reduce(matching, { type: 'device-reset', report: { done: ['keychain'], failed: [] } })
    expect(reduce(reported, { type: 'verify-started' }).reset).toBeUndefined()
    expect(reduce(reported, { type: 'match-started', total: 2 }).reset).toBeUndefined()
  })

  it('tells the person before Continue what the reset takes, for their platform', () => {
    const steps = [{ at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'tap', point: [0.5, 0.5] }] as never
    const loaded = reduce(initialState, { type: 'loaded', steps, range: { start: 0, end: 1 }, name: 'f' })
    const draw = (platform: string) => render(
      <RangeScreen state={loaded} dispatch={vi.fn()} bundleId="com.example" platform={platform} onContinue={vi.fn()} onCancel={vi.fn()} continueRef={{ current: null }} />,
    )
    draw('ios')
    expect(screen.getByText(/other apps are signed out too/)).toBeInTheDocument()
    cleanup()
    draw('android')
    expect(screen.getByText(/The app’s data is cleared and the device goes back online/)).toBeInTheDocument()
  })
})

describe('focus through a run', () => {
  const marks = { cursor: null, trails: [] }
  const tapStub = { surface: () => null } as never

  // Review of #1125: Stop's button was swapped for Start again's, and the focus of the one pressed fell to the page.
  it('keeps focus on the button pressed when Stop becomes Start again', () => {
    const running = { ...initialState, phase: 'matching' as const, progress: { done: 1, total: 3 } }
    const props = { tap: tapStub, marks, onStop: vi.fn(), onRestart: vi.fn(), onTakeWhatMatched: vi.fn(), onBackToRange: vi.fn(), onContinueAnyway: vi.fn(), stopRef: { current: null } }
    const { rerender } = render(<MatchScreen state={running} {...props} />)
    const stop = screen.getByRole('button', { name: 'Stop' })
    stop.focus()
    rerender(<MatchScreen state={{ ...running, error: 'The replay stopped.' }} {...props} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start again' }))
  })

  // With nothing to hold, focus fell to the page when Verify began and stayed there after it finished.
  it('has its primary button there, busy, while Verify runs', () => {
    const running = { ...initialState, phase: 'verifying' as const, verify: { status: 'running' as const, done: 0, live: [] } }
    render(<VerifyScreen state={running} tap={tapStub} marks={marks} total={3} onExport={vi.fn()} onBack={vi.fn()} primaryRef={{ current: null }} />)
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('ExportScreen', () => {
  const flow = { name: 'Sign in', appId: 'com.example.app', steps: [{ type: 'clearState' as const }, { type: 'launchApp' as const }, { type: 'inputSecret' as const, name: 'PASSWORD' }] }

  it('shows the file, the YAML to copy by hand on a page with no clipboard, and the secret to set', async () => {
    const onDone = vi.fn()
    render(<ExportScreen flow={flow} bundleId="com.example.app" onDone={onDone} doneRef={{ current: null }} />)
    expect(screen.getByLabelText('File')).toHaveValue('flows/sign-in.yaml')
    const yaml = screen.getByLabelText('Flow YAML')
    expect(yaml).toHaveAttribute('tabindex', '0')
    expect(yaml.textContent).toContain('secret: PASSWORD')
    expect(screen.getByText(/--secret PASSWORD/)).toBeInTheDocument()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await userEvent.click(screen.getByRole('button', { name: 'Copy YAML' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/The YAML is selected/)
    // Only the YAML is selected, and it has focus, so the keyboard copies it.
    expect(document.activeElement).toBe(yaml)
    expect(window.getSelection()?.toString()).toContain('secret: PASSWORD')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalled()
  })
})
