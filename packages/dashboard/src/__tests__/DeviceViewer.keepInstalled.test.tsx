import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { AppInstallToRelay, DeviceBoot, BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// #1087. Every install clears the app's data before installing, and a reconnect makes this viewer send one again — so
// a tester whose Wi-Fi dropped for a second came back to an app that had forgotten everything. Once this mount has
// seen its own install land, it asks the relay to skip an install of a build already there.
//
// The messages go in the order a reconnect really produces them: `session:joined`, the relay's replayed
// `device:ready` with no correlator, then the agent's `device:booting` and its correlated ready. The booting in the
// middle clears this viewer's install records, so a test that sends one ready per join would pass a design that
// fails here.
const send = vi.fn<(msg: BrowserToRelay) => void>()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const sent = () => send.mock.calls.map(([m]) => m)
const installs = () => sent().filter((m): m is AppInstallToRelay => m.type === 'app:install')
const lastBootId = (): string => {
  const id = sent().filter((m): m is DeviceBoot => m.type === 'device:boot').at(-1)?.requestId
  expect(id, 'the viewer sent a device:boot with no correlator').toBeTruthy()
  return id!
}

const deliverAll = (...msgs: BrowserInbound[]) => act(() => { for (const m of msgs) deliver!(m) })
const ready = (requestId?: string): BrowserInbound =>
  ({ type: 'device:ready', sessionId: 's1', ...(requestId ? { requestId } : {}), payload: { deviceId: 'dev-1' } })

/** A join as a reconnect produces it, with the replayed ready first when the device was already up. */
function rejoin(deviceWasUp: boolean): void {
  deliverAll({ type: 'session:joined', sessionId: 's1', capabilities: [] })
  if (deviceWasUp) deliverAll(ready())
  deliverAll({ type: 'device:booting', sessionId: 's1' }, ready(lastBootId()))
}

const doneFor = (install: AppInstallToRelay): BrowserInbound => ({ type: 'app:install-done', sessionId: 's1', requestId: install.requestId })

describe('DeviceViewer keeps the app it installed across a reconnect', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('installs cleanly the first time', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(false)

    expect(installs()).toHaveLength(1)
    expect(installs()[0]!.keepIfInstalled).toBeUndefined()
  })

  it('asks to keep the app on every install after its own install landed', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(false)
    deliverAll(doneFor(installs()[0]!))
    send.mockClear()

    rejoin(true)

    // Two readies, two installs — and the booting between them did not turn the request back into a clean install.
    expect(installs()).toHaveLength(2)
    expect(installs().every((i) => i.keepIfInstalled === true)).toBe(true)
  })

  // A device someone else left running: the first cycle gets the replayed ready, then the real one. Neither install
  // has landed, so neither may ask to keep — the second must not be folded into the first, which runs during the boot.
  it('keeps both installs of its first cycle clean, before anything has landed', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(true)

    expect(installs()).toHaveLength(2)
    expect(installs().some((i) => i.keepIfInstalled !== undefined)).toBe(false)
  })

  it('does not count an install another client asked for', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(false)
    deliverAll({ type: 'app:install-done', sessionId: 's1', requestId: 'someone-elses' })
    send.mockClear()

    rejoin(true)

    expect(installs()).toHaveLength(2)
    expect(installs().some((i) => i.keepIfInstalled !== undefined)).toBe(false)
  })

  it('does not count an install that failed', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(false)
    deliverAll({ type: 'app:install-error', sessionId: 's1', requestId: installs()[0]!.requestId, message: 'no space' })
    send.mockClear()

    rejoin(true)

    expect(installs()).toHaveLength(2)
    expect(installs().some((i) => i.keepIfInstalled !== undefined)).toBe(false)
  })

  // A mount entered as a return to the tester's own session keeps the app from its very first install.
  it('asks to keep the app from the first install when the mount is a resume', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} resume />)
    rejoin(true)

    expect(installs()).toHaveLength(2)
    expect(installs().every((i) => i.keepIfInstalled === true)).toBe(true)
  })

  it('starts clean again in a new mount', () => {
    const first = render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(false)
    deliverAll(doneFor(installs()[0]!))
    first.unmount()
    send.mockClear()

    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    rejoin(true)

    expect(installs()).toHaveLength(2)
    expect(installs().some((i) => i.keepIfInstalled !== undefined)).toBe(false)
  })
})
