import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CaptureEntry, CaptureSnapshot } from '@tapflowio/protocol/capture'
import FlowCaptureDialog from '@/components/flow-capture/FlowCaptureDialog'
import { matchRange, type MatchHooks } from '@/lib/flowCapture/runner'
import type { Carried } from '@/lib/flowCapture/remembered'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { withQuery } from './withQuery'

// (c), R6: the dialog remembers what Continue anyway accepted for the next Match of the same capture, and forgets it
// on a Match from another start. The replay itself is stood in for: what is under test is what the dialog hands it.
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
const entry = (at: number, msg: Record<string, unknown>): CaptureEntry => ({ at, kind: 'input', msg: { sessionId: 's1', ...msg } as never })
// Install, launch, tap: the default range starts at the launch (#2), and the tap's picture is kept.
const snapshot: CaptureSnapshot = {
  id: 'snap', takenAt: 0, thinned: false, thumbnails: ['t'],
  entries: [
    entry(0, { type: 'app:install', requestId: 'i', buildId: 7 }),
    entry(100, { type: 'app:launch', requestId: 'l', buildId: 7 }),
    entry(200, { type: 'input:touch:start', payload: { x: 0.4, y: 0.6 } }),
    entry(280, { type: 'input:touch:end', requestId: 't' }),
  ],
}
const SKY = { x: 0, y: 0.1, width: 1, height: 0.2 }
const stop = { diff: 0.2, nowUrl: 'blob:now', masks: [], areas: [SKY], mostly: false, cells: { share: 0.2, cells: new Uint8Array([1]), gridWidth: 1, gridHeight: 1 } }

function relay() {
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/capture/snapshot') && init?.method === 'POST') return new Response(JSON.stringify(snapshot), { status: 200 })
    if (url === '/api/v1/builds/7') return new Response(JSON.stringify({ id: 7, bundle_id: 'com.example.app' }), { status: 200 })
    return new Response('{"ok":true}', { status: 200 })
  })
}

type Run = (steps: Parameters<typeof matchRange>[3], hooks: MatchHooks) => Promise<never>
/** The first Match stops at the tap and fails once the person goes on; the second says what it is told about the tap. */
function twoMatches(): Carried[] {
  const told: Carried[] = []
  const first: Run = async (_steps, hooks) => {
    await hooks.onDiverged!(2, stop)
    throw new Error('stopped for the test')
  }
  const second: Run = async (steps, hooks) => {
    told.push(await hooks.carried!(2, steps[2]!, [], undefined))
    return new Promise<never>(() => {})
  }
  vi.mocked(matchRange)
    .mockImplementationOnce((_t, _c, _l, steps, _r, _b, hooks) => first(steps, hooks))
    .mockImplementationOnce((_t, _c, _l, steps, _r, _b, hooks) => second(steps, hooks))
  return told
}

async function stopAndGoOn() {
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Continue anyway' }))
  await screen.findByText('stopped for the test')
}

describe('the dialog remembering Continue anyway', () => {
  it('tells the next Match from the same start what was accepted', async () => {
    relay()
    const told = twoMatches()
    render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={{ current: null }} onClose={vi.fn()} />))
    await stopAndGoOn()
    await userEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await waitFor(() => expect(told).toHaveLength(1))
    expect(told[0]).toEqual({ areas: [SKY], from: 2 })
  })

  it('forgets it on a Match from another start', async () => {
    relay()
    const told = twoMatches()
    render(withQuery(<FlowCaptureDialog tap={tap} returnFocusRef={{ current: null }} onClose={vi.fn()} />))
    await stopAndGoOn()
    await userEvent.click(screen.getByRole('button', { name: /Range/ }))
    const start = await screen.findByRole('slider', { name: 'Start of the flow' })
    start.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(told).toHaveLength(1))
    expect(told[0]).toBeNull()
  })
})
