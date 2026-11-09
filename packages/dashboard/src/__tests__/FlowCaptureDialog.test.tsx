import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CaptureEntry, CaptureSnapshot } from '@tapflowio/protocol/capture'
import type { CapturedStep } from '@tapflowio/flow-runner/browser'
import FlowCaptureDialog from '@/components/flow-capture/FlowCaptureDialog'
import { EditScreen, ExportScreen } from '@/components/flow-capture/screens'
import { initialState } from '@/lib/flowCapture/machine'
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

  // Review of #1125: the session ended under an open dialog and the viewer unmounted it; nothing gave the relay back
  // its recording, and the pause lease went on renewing from this tab.
  it('cleans up once when it is taken away without being closed, as when it is closed', async () => {
    const fetch = relay()
    const returnFocusRef = { current: null as HTMLButtonElement | null }
    const onClose = vi.fn()
    const { unmount } = render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={returnFocusRef} onClose={onClose} />))
    await screen.findByRole('dialog', { name: 'Capture flow' })
    unmount()
    const drops = () => fetch.mock.calls.filter(([u, i]) => String(u).endsWith('/capture/snapshot') && i?.method === 'DELETE')
    await waitFor(() => expect(drops()).toHaveLength(1))
    expect(onClose).not.toHaveBeenCalled()
  })

  // StrictMode runs an effect's cleanup once at mount. Ending the dialog there gave the relay back its recording and
  // dropped the snapshot while the dialog was still open, and every later step answered nothing.
  it('stays open under StrictMode, and still cleans up once when taken away', async () => {
    const fetch = relay()
    const returnFocusRef = { current: null as HTMLButtonElement | null }
    const { unmount } = render(<StrictMode>{withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={returnFocusRef} onClose={vi.fn()} />)}</StrictMode>)
    const dialog = await screen.findByRole('dialog', { name: 'Capture flow' })
    expect(await within(dialog).findByText('2 steps · #2 – #3')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 10))
    const drops = () => fetch.mock.calls.filter(([u, i]) => String(u).endsWith('/capture/snapshot') && i?.method === 'DELETE')
    expect(drops()).toHaveLength(0)
    unmount()
    await waitFor(() => expect(drops()).toHaveLength(1))
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

  it('gives the relay back its recording and drops the copy on Cancel', async () => {
    const fetchMock = relay()
    const onClose = open()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${String(u)}`)
      expect(calls).toContain('DELETE /api/v1/sessions/s1/capture/pause')
      expect(calls).toContain('DELETE /api/v1/sessions/s1/capture/snapshot')
    })
  })
})

describe('EditScreen', () => {
  const step = (over: Partial<CapturedStep>): CapturedStep => ({
    raw: { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'network', offline: true }, step: null, skipped: 'network', ...over,
  })
  const edit = (steps: CapturedStep[], removed: number[] = []) => render(
    <EditScreen state={{ ...initialState, phase: 'edit', captured: { steps, launchAdded: false, secrets: {} }, removed }}
      dispatch={vi.fn()} flow={null} renameError={() => null} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />,
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

describe('ExportScreen', () => {
  const flow = { name: 'Sign in', appId: 'com.example.app', steps: [{ type: 'clearState' as const }, { type: 'launchApp' as const }, { type: 'inputSecret' as const, name: 'PASSWORD' }] }

  it('shows the file, the YAML to copy by hand on a page with no clipboard, and the secret to set', async () => {
    const onDone = vi.fn()
    render(<ExportScreen flow={flow} bundleId="com.example.app" onDone={onDone} doneRef={{ current: null }} />)
    expect(screen.getByLabelText('File')).toHaveValue('flows/sign-in.yaml')
    const yaml = screen.getByLabelText('Flow YAML')
    expect(yaml).toHaveAttribute('readonly')
    expect((yaml as HTMLTextAreaElement).value).toContain('secret: PASSWORD')
    expect(screen.getByText(/--secret PASSWORD/)).toBeInTheDocument()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await userEvent.click(screen.getByRole('button', { name: 'Copy YAML' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Select the YAML and copy it/)
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalled()
  })
})
