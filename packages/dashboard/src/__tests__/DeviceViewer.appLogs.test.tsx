import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

const send = vi.fn()
let deliver: ((message: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (message: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({
  usePerfMode: () => ({ perfMode: false, visible: false }),
}))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=',
  bezelWidth: 10,
  bezelHeight: 10,
  compositeWidth: 100,
  compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0,
  logicalWidth: 50,
  logicalHeight: 100,
  buttons: [],
}

describe('DeviceViewer app log feed', () => {
  beforeEach(() => {
    send.mockClear()
    deliver = null
  })

  it('renders only its current launch logs for its own session in arrival order', () => {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" buildId={7} />)
    act(() => {
      deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs'] })
    })
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } })
    })
    const install = send.mock.calls.map(([message]) => message).findLast((message) => message.type === 'app:install')!
    act(() => {
      deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: install.requestId })
    })
    act(() => {
      deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME })
    })
    act(() => { screen.getByLabelText('Launch app').click() })
    const launch = send.mock.calls.map(([message]) => message).findLast((message) => message.type === 'app:launch')!
    act(() => {
      deliver!({ type: 'app:launch-done', sessionId: 'mine', requestId: launch.requestId })
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'other', launchId: launch.requestId, text: 'foreign log' })
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: 'older-launch', text: 'stale log' })
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: launch.requestId, text: 'first\n' })
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: launch.requestId, text: 'second\t🚀' })
    })

    const log = screen.getByRole('log', { name: 'App log output' })
    expect(log.textContent).toBe('first\nsecond\t🚀')
  })

  it('clears the previous app output when launching again or starting a new boot', () => {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" buildId={7} />)
    act(() => {
      deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs'] })
    })
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } })
    })
    const install = send.mock.calls.map(([message]) => message).findLast((message) => message.type === 'app:install')!
    act(() => {
      deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: install.requestId })
      deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME })
    })
    act(() => {
      screen.getByLabelText('Launch app').click()
    })
    const launch = send.mock.calls.map(([message]) => message).findLast((message) => message.type === 'app:launch')!
    act(() => {
      deliver!({ type: 'app:launch-done', sessionId: 'mine', requestId: launch.requestId })
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: launch.requestId, text: 'previous app output' })
    })
    expect(screen.getByRole('log', { name: 'App log output' }).textContent).toBe('previous app output')

    act(() => {
      screen.getByLabelText('Launch app').click()
    })
    const nextLaunch = send.mock.calls.map(([message]) => message).findLast((message) => message.type === 'app:launch')!
    expect(screen.getByRole('log', { name: 'App log output' }).textContent).toMatch(/Waiting for app logs/)

    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: launch.requestId, text: 'late previous app output' })
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: nextLaunch.requestId, text: 'new app output' })
      deliver!({ type: 'device:booting', sessionId: 'mine' })
    })
    expect(screen.getByRole('log', { name: 'App log output' }).textContent).toMatch(/Waiting for app logs/)
  })
})
