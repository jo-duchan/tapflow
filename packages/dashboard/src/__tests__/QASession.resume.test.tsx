import { StrictMode, useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { BreadcrumbProvider, useBreadcrumb } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, DeviceSummary, SessionInfo } from '@/lib/types'
import { withQuery } from './withQuery'

// #1087: coming back to a session through its URL, and the device list around a dropped session. The socket and the
// viewer are stand-ins, as in `QASession.aiHolder.test.tsx`; what is under test is what the page decides from each
// listing, and what it sends.
const { send, toast } = vi.hoisted(() => ({
  send: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
let deliver: ((msg: BrowserInbound) => void) | null = null
vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
const { BUILD } = vi.hoisted(() => ({
  BUILD: { id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null, version_name: '1.0', build_number: '1' },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
let viewer: { sessionId: string; resume?: boolean; resetMode?: string; onSessionEnded?: (r: string) => void } | null = null
vi.mock('@/components/DeviceViewer', () => ({
  DeviceViewer: (props: NonNullable<typeof viewer>) => { viewer = props; return <div data-testid="viewer" /> },
}))
vi.mock('sonner', () => ({ toast }))

const { QASession } = await import('../pages/QASession')

let location = ''
function Probe() {
  const { search } = useLocation()
  useEffect(() => { location = search }, [search])
  return null
}
/** What `DashboardLayout` does with the page's breadcrumb, which is where going back lives. */
function Crumbs() { return <nav>{useBreadcrumb().node}</nav> }

const device = (over: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id: 'dev-a', name: 'iPhone 17 Pro', platform: 'ios', status: 'booted', osVersion: 'iOS 26', sessionId: 'sess-a', busy: false, ...over })
const listing = (...devices: DeviceSummary[]): SessionInfo[] => [{
  agentName: 'studio-mac', platform: 'ios', capabilities: ['full-reset'], admission: { booting: false, overloaded: false, memoryRefuses: [] }, devices,
}]
const listed = (...devices: DeviceSummary[]) => act(async () => { deliver!({ type: 'agents:listed', sessions: listing(...devices) }) })

async function open(search: string) {
  render(withQuery(
    <StrictMode>
      <MemoryRouter initialEntries={[`/app-center/build${search}`]}>
        <BreadcrumbProvider><Crumbs /><QASession /><Probe /></BreadcrumbProvider>
      </MemoryRouter>
    </StrictMode>,
  ))
  await vi.waitFor(() => expect(deliver).not.toBeNull())
}

const sent = (type: string) => send.mock.calls.map(([m]) => m).filter((m: { type: string }) => m.type === type)
const params = () => new URLSearchParams(location)

beforeEach(() => {
  send.mockClear(); viewer = null; deliver = null; location = ''
  for (const f of Object.values(toast)) f.mockClear()
})

describe('QASession — coming back through a session URL', () => {
  const URL = '?id=7&session=sess-a&device=dev-a'

  it('joins a session waiting for this tester, keeping the app, and powers nothing off on the way', async () => {
    await open(URL)
    expect(sent('device:shutdown')).toHaveLength(0)
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))

    expect(viewer?.sessionId).toBe('sess-a')
    expect(viewer?.resume).toBe(true)
    expect(viewer?.resetMode).toBe('app-only')
    expect(sent('device:shutdown')).toHaveLength(0)
  })

  // An old link to a device that is off, or on for nobody in particular: asked, never booted.
  it('asks before starting a device that is no longer waiting for this tester', async () => {
    await open(URL)
    await listed(device({ status: 'shutdown' }))

    expect(viewer).toBeNull()
    expect(await screen.findByRole('alertdialog', { name: 'Start iPhone 17 Pro again?' })).toBeTruthy()
    expect(params().get('session')).toBeNull()
  })

  it('waits while another tab of this tester holds it, and takes it once that tab has been gone a while', async () => {
    await open(URL)
    await listed(device({ busy: true, heldBySelf: true }))
    expect(screen.getByRole('status').textContent).toMatch(/Returning to your session on iPhone 17 Pro/)
    expect(viewer).toBeNull()

    await listed(device({ resumable: true, releasedAgoMs: 2_000, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))
    expect(viewer).toBeNull()

    await listed(device({ resumable: true, releasedAgoMs: 11_000, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))
    expect(viewer?.resume).toBe(true)
  })

  it('says who took it, once, and shows the list', async () => {
    await open(URL)
    const taken = device({ endedBy: { by: 'bob@x', name: 'Bob', at: 42 } })
    await listed(taken)
    await listed(taken)

    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(toast.info.mock.calls[0]![0]).toMatch(/^Bob is using/)
    expect(viewer).toBeNull()
    expect(params().get('session')).toBeNull()
    expect(screen.getByRole('button', { name: /iPhone 17 Pro/ })).toBeTruthy()
  })

  it('waits for a Mac that is away, and asks once its device is back under a new session', async () => {
    await open(URL)
    await listed()
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for the Mac/)

    await listed(device({ sessionId: 'sess-new' }))
    expect(await screen.findByRole('alertdialog', { name: 'Start iPhone 17 Pro again?' })).toBeTruthy()
  })

  it('stops waiting when the tester cancels, and keeps focus on the list', async () => {
    const user = userEvent.setup()
    await open(URL)
    await listed(device({ busy: true, heldBySelf: true }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Search devices'))
    await listed(device({ resumable: true, releasedAgoMs: 60_000, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))

    expect(viewer).toBeNull()
    expect(params().get('session')).toBeNull()
  })

  it('stops waiting when the tester picks another device', async () => {
    const user = userEvent.setup()
    await open(URL)
    const other = device({ id: 'dev-b', name: 'iPhone SE', sessionId: 'sess-b' })
    await listed(device({ busy: true, heldBySelf: true }), other)
    await user.click(screen.getByRole('button', { name: /iPhone SE/ }))
    expect(viewer?.sessionId).toBe('sess-b')

    await listed(device({ resumable: true, releasedAgoMs: 60_000, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }), other)
    expect(viewer?.sessionId).toBe('sess-b')
  })

  // Their own tab that never lets go is theirs, not someone else's.
  it('says the session is open in another of their tabs when that tab never lets go', async () => {
    await open(URL)
    const start = Date.now()
    await listed(device({ busy: true, heldBySelf: true }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 46_000)
    try {
      await listed(device({ busy: true, heldBySelf: true }))
    } finally { clock.mockRestore() }

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0]![0]).toMatch(/another of your tabs/)
  })

  // A viewer that ends on its own (here the agent going away) must not leave an old target behind for the next listing
  // to act on: the tester moved on when they picked another device.
  it('forgets the session it was waiting for once the tester picks another, even if that one ends', async () => {
    const user = userEvent.setup()
    await open(URL)
    const other = device({ id: 'dev-b', name: 'iPhone SE', sessionId: 'sess-b' })
    await listed(device({ busy: true, heldBySelf: true }), other)
    await user.click(screen.getByRole('button', { name: /iPhone SE/ }))
    await act(async () => { viewer!.onSessionEnded!('agent-disconnected') })
    viewer = null

    await listed(device({ resumable: true, releasedAgoMs: 60_000, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }), other)
    expect(viewer).toBeNull()
  })

  // The relay can still refuse the join it just listed as free. That is the own-tab wait, not an ended session.
  it('goes back to waiting when its join meets the session still held', async () => {
    await open(URL)
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))
    await act(async () => { viewer!.onSessionEnded!('busy-elsewhere') })
    await listed(device({ busy: true, heldBySelf: true }))

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toMatch(/Returning to your session/)
  })
})

describe('QASession — the device list', () => {
  async function onList(...devices: DeviceSummary[]) {
    const user = userEvent.setup()
    await open('?id=7')
    await listed(...devices)
    await user.click(await screen.findByText('studio-mac'))
    return user
  }

  it('starts a picked device cleanly and puts the session in the URL; going back takes it out', async () => {
    const user = await onList(device())
    await user.click(screen.getByRole('button', { name: /iPhone 17 Pro/ }))

    expect(viewer?.resume).toBe(false)
    expect(params().get('session')).toBe('sess-a')
    expect(params().get('device')).toBe('dev-a')

    await user.click(screen.getByRole('button', { name: 'studio-mac' }))
    expect(viewer).not.toBeNull() // the stand-in keeps its last props; what matters is the URL and the shutdown
    expect(params().get('session')).toBeNull()
    expect(sent('device:shutdown')).toHaveLength(1)
  })

  it('names whose dropped session a device is waiting for, and asks before taking it', async () => {
    const user = await onList(device({ waiting: { user: 'bob@x', name: 'Bob', remainingMs: 150_000 } }))
    const card = screen.getByRole('button', { name: /iPhone 17 Pro/ })
    expect(card.textContent).toContain('Waiting for Bob to return · about 3 min')
    // Who exactly, by email, on hover.
    await user.hover(card)
    expect((await screen.findByRole('tooltip')).textContent).toBe('bob@x')

    await user.click(card)
    const dialog = await screen.findByRole('alertdialog', { name: "Take over Bob's device?" })
    expect(dialog.textContent).toMatch(/app state they were testing is lost/)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(viewer).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /iPhone 17 Pro/ }))

    await user.click(screen.getByRole('button', { name: /iPhone 17 Pro/ }))
    await user.click(await screen.findByRole('button', { name: 'Take over' }))
    expect(viewer?.resume).toBe(false)
  })

  it('resumes the tester\'s own waiting session without asking', async () => {
    const user = await onList(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }))
    const card = screen.getByRole('button', { name: /iPhone 17 Pro.*Your session is waiting/ })
    await user.click(card)

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(viewer?.resume).toBe(true)
  })

  // Full reset is armed for one fresh pick and stays as the last applied mode. Carried into a resume it would erase the
  // device the tester came back to.
  it('never erases a device the tester is coming back to, whatever reset was used last', async () => {
    const user = await onList(
      device(),
      device({ id: 'dev-b', name: 'iPhone SE', sessionId: 'sess-b', resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true } }),
    )
    await user.click(screen.getByRole('switch', { name: 'Full reset' }))
    await user.click(screen.getByRole('button', { name: /iPhone 17 Pro/ }))
    expect(viewer?.resetMode).toBe('full-erase')
    await user.click(screen.getByRole('button', { name: 'studio-mac' }))

    await user.click(screen.getByRole('button', { name: /iPhone SE.*Your session is waiting/ }))
    expect(viewer?.sessionId).toBe('sess-b')
    expect(viewer?.resetMode).toBe('app-only')
  })

  it('offers the tester\'s interrupted session above the list, and ends it on request without losing focus', async () => {
    const user = userEvent.setup()
    await open('?id=7')
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true, buildId: 7 } }))

    expect(screen.getByText(/Your session on iPhone 17 Pro was interrupted/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'End your session on iPhone 17 Pro' }))
    expect(sent('device:shutdown')).toEqual([{ type: 'device:shutdown', sessionId: 'sess-a', payload: { deviceId: 'dev-a' } }])
    // Off the row that the next listing removes.
    expect(document.activeElement?.closest('ul[aria-label="Interrupted sessions"]')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('resumes the interrupted session of this build here, keeping the app', async () => {
    const user = userEvent.setup()
    await open('?id=7')
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true, buildId: 7 } }))
    await user.click(screen.getByRole('button', { name: 'Resume your session on iPhone 17 Pro' }))

    expect(viewer?.sessionId).toBe('sess-a')
    expect(viewer?.resume).toBe(true)
  })

  // Resumed here, it would install this page's build over the one the session was testing.
  it('takes another build\'s interrupted session to that build\'s page', async () => {
    const user = userEvent.setup()
    await open('?id=7')
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true, buildId: 9 } }))
    await user.click(screen.getByRole('button', { name: 'Resume your session on iPhone 17 Pro' }))

    expect(viewer).toBeNull()
    expect(params().get('id')).toBe('9')
    expect(params().get('session')).toBe('sess-a')
    // The page mounts again for that build and reads the link as an entry.
    await vi.waitFor(() => expect(deliver).not.toBeNull())
    await listed(device({ resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true, buildId: 9 } }))
    expect(viewer?.resume).toBe(true)
  })

  it('does not offer a session on another platform', async () => {
    await open('?id=7')
    await listed(device({ platform: 'android', resumable: true, releasedAgoMs: 500, waiting: { user: 'me@x', name: 'Me', remainingMs: 200_000, yours: true, buildId: 3 } }))

    expect(screen.queryByText(/was interrupted/)).toBeNull()
  })
})
