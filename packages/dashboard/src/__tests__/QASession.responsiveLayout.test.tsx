import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'

// #679 — the simulator viewer forced horizontal scroll on narrow (mobile) viewports. These pin the
// layout-level changes that actually stop it: the root splits into a column below `lg`
// (`SessionPanel` moves from beside the viewer to below it), the viewer wrapper no longer forces
// `min-w-max`, and the wrapper's measured width actually reaches `DeviceViewer` as `widthBudget`.
// The scale math itself (does the device actually get smaller) is covered separately in
// coordinate-transform.test.ts and DeviceViewer.responsiveWidth.test.tsx.
const { send, widthBudgets } = vi.hoisted(() => ({ send: vi.fn(), widthBudgets: [] as Array<number | undefined> }))
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
const { BUILD } = vi.hoisted(() => ({
  BUILD: {
    id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null,
    version_name: '1.0', build_number: '1',
  },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div data-testid="session-panel" /> }))
vi.mock('@/components/DeviceViewer', () => ({
  DeviceViewer: ({ widthBudget }: { widthBudget?: number }) => {
    widthBudgets.push(widthBudget)
    return <div data-testid="device-viewer" />
  },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

// The real ResizeObserver wiring (QASession.tsx's inline ref+effect), not bypassed the way
// DeviceViewer.responsiveWidth.test.tsx bypasses it by passing widthBudget as a direct prop.
let observedCallback: ((entries: { contentRect: { width: number } }[]) => void) | null = null

class MockResizeObserver {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) { observedCallback = cb }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { QASession } = await import('../pages/QASession')

const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac',
  platform: 'ios',
  capabilities: ['clipboard'],
  devices: [{ id: 'dev-a', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3', sessionId: 'sess-1', busy: false }],
}]

async function openActiveSession(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemoryRouter initialEntries={['/qa?id=7']}>
      <BreadcrumbProvider><QASession /></BreadcrumbProvider>
    </MemoryRouter>,
  )
  await vi.waitFor(() => expect(deliver).not.toBeNull())
  await act(async () => { deliver!({ type: 'agents:listed', sessions: AGENTS }) })
  await user.click(await screen.findByText('studio-mac'))
  await user.click(await screen.findByText('iPhone 15'))
  await screen.findByTestId('device-viewer')
}

describe('QASession responsive layout (#679)', () => {
  beforeEach(() => {
    deliver = null
    observedCallback = null
    widthBudgets.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stacks the root into a column below `lg`, row at `lg` and up', async () => {
    const user = userEvent.setup()
    await openActiveSession(user)
    const root = screen.getByTestId('qa-session-root')
    expect(root.className).toMatch(/\bflex-col\b/)
    expect(root.className).toMatch(/\blg:flex-row\b/)
  })

  it('the session panel is full-width below `lg`, fixed 80 at `lg` and up', async () => {
    const user = userEvent.setup()
    await openActiveSession(user)
    const panelWrapper = screen.getByTestId('session-panel').parentElement!
    expect(panelWrapper.className).toMatch(/\bw-full\b/)
    expect(panelWrapper.className).toMatch(/\blg:w-80\b/)
  })

  it('the viewer wrapper no longer forces min-w-max (can shrink below content width)', async () => {
    const user = userEvent.setup()
    await openActiveSession(user)
    const viewerWrapper = screen.getByTestId('device-viewer').parentElement!
    expect(viewerWrapper.className).not.toMatch(/\bmin-w-max\b/)
  })

  it('a real ResizeObserver resize on the wrapper reaches DeviceViewer as widthBudget', async () => {
    const user = userEvent.setup()
    await openActiveSession(user)
    expect(widthBudgets.at(-1)).toBe(0) // unmeasured until the observer first fires

    await act(async () => { observedCallback!([{ contentRect: { width: 343 } }]) })
    expect(widthBudgets.at(-1)).toBe(343)
  })
})
