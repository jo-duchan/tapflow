import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CaptureEntry, CaptureSnapshot } from '@tapflowio/protocol/capture'
import type { CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import FlowCaptureDialog from '@/components/flow-capture/FlowCaptureDialog'
import { matchRange } from '@/lib/flowCapture/runner'
import { copy } from '@/lib/flowCapture/copy'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { withQuery } from './withQuery'

// #1170: Match's stop names a tap left out before the replay; Put back and match again replays it in the next Match.
// The replay itself is stood in for: what is under test is the steps the dialog hands it.
vi.mock('@/lib/flowCapture/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flowCapture/runner')>()),
  matchRange: vi.fn(),
}))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const tap: CaptureTap = {
  sessionId: 's1', platform: 'ios', buildId: 7,
  send: () => true, subscribe: () => () => {}, onConnectionLost: () => () => {}, connected: () => true,
  chrome: () => null, postures: () => ({ postures: [], currentId: null }), surface: () => null,
}
type InputMsg = Extract<CaptureEntry, { kind: 'input' }>['msg']
const entry = (at: number, msg: InputMsg): CaptureEntry => ({ at, kind: 'input', msg })
// Install, launch, a tap the app saw land on a list still moving (left out: it only stopped the list, and did nothing),
// then a tap.
const snapshot: CaptureSnapshot = {
  id: 'snap', takenAt: 0, thinned: false, thumbnails: [],
  entries: [
    entry(0, { sessionId: 's1', type: 'app:install', requestId: 'i', buildId: 7 }),
    entry(100, { sessionId: 's1', type: 'app:launch', requestId: 'l', buildId: 7 }),
    entry(200, { sessionId: 's1', type: 'input:touch:start', payload: { x: 0.4, y: 0.6 } }),
    entry(280, { sessionId: 's1', type: 'input:touch:end', requestId: 'a' }),
    { at: 290, kind: 'touched', requestId: 'a', touched: { point: { x: 0.4, y: 0.6 }, moving: true, acted: false, seq: 1 } },
    entry(2000, { sessionId: 's1', type: 'input:touch:start', payload: { x: 0.4, y: 0.3 } }),
    entry(2080, { sessionId: 's1', type: 'input:touch:end', requestId: 'b' }),
    { at: 2090, kind: 'touched', requestId: 'b', touched: { point: { x: 0.4, y: 0.3 }, moving: false, seq: 2 } },
  ],
}
const stop = { diff: 0.2, nowUrl: 'blob:now', masks: [], areas: [], mostly: true, cells: { share: 0.9, cells: new Uint8Array([1]), gridWidth: 1, gridHeight: 1 } }

function relay() {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/capture/snapshot') && init?.method === 'POST') return new Response(JSON.stringify(snapshot), { status: 200 })
    if (url === '/api/v1/builds/7') return new Response(JSON.stringify({ id: 7, bundle_id: 'com.example.app' }), { status: 200 })
    return new Response('{"ok":true}', { status: 200 })
  })
}

describe('Put back and match again', () => {
  it('starts the next Match with the steps it named replayed', async () => {
    relay()
    const handed: RawStep[][] = []
    vi.mocked(matchRange)
      .mockImplementationOnce((_t, _c, _l, steps, _r, _b, hooks) => {
        handed.push(steps)
        return hooks.onDiverged!(3, stop).then(() => new Promise<never>(() => {}))
      })
      .mockImplementationOnce((_t, _c, _l, steps) => {
        handed.push(steps)
        return new Promise<never>(() => {})
      })
    render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={{ current: null }} onClose={vi.fn()} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Put back and match again' }))
    await waitFor(() => expect(handed).toHaveLength(2))
    expect(handed[0]![2]!.dropped).toBe('stopped-scroll')
    expect(handed[1]![2]!.dropped).toBeUndefined()
  })

  // Review of CodeRabbit's #1228 follow-up: the app did nothing with it when recorded, but the person asked for it back,
  // so Match's end does not offer to leave it out again: straight to Edit, with it in the flow.
  it('goes on to Edit without offering the tap put back to leave out', async () => {
    relay()
    vi.mocked(matchRange)
      .mockImplementationOnce((_t, _c, _l, _s, _r, _b, hooks) => hooks.onDiverged!(3, stop).then(() => new Promise<never>(() => {})))
      .mockImplementationOnce(async (_t, _c, _l, steps, range) =>
        steps.slice(range.start, range.end).map((raw, i) => ({ raw, step: raw.kind === 'launch' ? { type: 'launchApp' } : { type: 'tapOn', selector: { text: `Item ${i}` } } }) as CapturedStep))
    render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={{ current: null }} onClose={vi.fn()} />))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Put back and match again' }))
    await screen.findByRole('button', { name: copy.verifyAndExport })
    expect(screen.queryByText(copy.reviewHint)).toBeNull()
  })
})
