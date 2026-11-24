import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'
import { fakeAppLogLayout } from './appLogLayout'
import { loadAppLogRows } from '@/components/device/shared/appLogRowsChunk'

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
let frames: FrameRequestCallback[] = []
let layout: ReturnType<typeof fakeAppLogLayout>

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
  // The log's rows are a lazy chunk; loaded up front so a test can read them in the same frame.
  beforeAll(() => loadAppLogRows())
  beforeEach(() => {
    send.mockClear()
    deliver = null
    frames = []
    layout = fakeAppLogLayout()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    layout.restore()
  })
  const flushFrames = () => act(() => frames.splice(0).forEach((callback) => callback(0)))
  const sent = (type: string) => send.mock.calls.map(([message]) => message).findLast((message) => message.type === type)!
  const output = () => screen.queryByRole('region', { name: 'App log output' })
  const lines = () => Array.from(output()!.querySelectorAll('[data-log-line]'), (line) => line.textContent)

  /** A joined, booted, installed session with its frame, ready for Launch. */
  function installed() {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" buildId={7} />)
    act(() => {
      deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs'] })
    })
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } })
    })
    act(() => {
      deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: sent('app:install').requestId })
      deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME })
    })
  }
  function launch(): string {
    act(() => { screen.getByLabelText('Launch app').click() })
    return sent('app:launch').requestId
  }
  function launched(): string {
    installed()
    const requestId = launch()
    act(() => {
      deliver!({ type: 'app:launch-done', sessionId: 'mine', requestId })
    })
    return requestId
  }

  it('renders only its current launch logs for its own session, one row per line, in arrival order', () => {
    const launchId = launched()
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'other', launchId, text: 'foreign log' })
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: 'older-launch', text: 'stale log' })
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId, text: 'first\n' })
      deliver!({ type: 'app:log', sessionId: 'mine', launchId, text: 'second\t🚀' })
    })

    flushFrames()
    expect(lines()).toEqual(['first', 'second\t🚀'])
    expect(screen.getByText('2 lines')).toBeTruthy()
  })

  // Shown only between a launch and what ends that app: "waiting" anywhere else promises output that is not coming.
  it('is not shown before a launch, and waits for output once launched', () => {
    installed()
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
    launch()
    expect(output()!.textContent).toMatch(/Waiting for app logs/)
  })

  it('goes away when the launch fails', () => {
    installed()
    const requestId = launch()
    act(() => {
      deliver!({ type: 'app:launch-error', sessionId: 'mine', requestId, message: 'not installed' })
    })
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
  })

  it('clears the previous app output when launching again', () => {
    const first = launched()
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: first, text: 'previous app output' })
    })
    flushFrames()
    expect(lines()).toEqual(['previous app output'])

    const next = launch()
    flushFrames()
    expect(output()!.textContent).toMatch(/Waiting for app logs/)
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: first, text: 'late previous app output' })
      deliver!({ type: 'app:log', sessionId: 'mine', launchId: next, text: 'new app output' })
    })
    flushFrames()
    expect(lines()).toEqual(['new app output'])
  })

  // Each of these ends the app the logs came from, and a chunk still on its way for that launch is dropped after it.
  // A new boot, the agent going away and a rebound are not here: each drops the frame, which unmounts the whole viewer,
  // so a test of them would pass with their clears deleted.
  it.each([
    ['a re-join', { type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs'] }],
    ['the session ending', { type: 'session:terminated', sessionId: 'mine', reason: 'agent-disconnected' }],
  ] as const)('closes the log on %s, and drops that launch\'s late output', (_case, message) => {
    const launchId = launched()
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId, text: 'running' })
    })
    flushFrames()
    act(() => {
      deliver!(message as BrowserInbound)
    })
    act(() => {
      deliver!({ type: 'app:log', sessionId: 'mine', launchId, text: 'late' })
    })
    flushFrames()
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
  })

  describe('a watched app', () => {
    const marks = () => Array.from(output()!.querySelectorAll('[data-log-mark]'), (line) => line.textContent)
    const rows = () => Array.from(output()!.querySelectorAll('[data-log-line], [data-log-mark]'), (line) => line.textContent)
    function watchedInstalled() {
      render(<DeviceViewer sessionId="mine" deviceId="dev-1" buildId={7} />)
      act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs', 'app-log-watch'] }) })
      act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
      act(() => {
        deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: sent('app:install').requestId })
        deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME })
      })
    }
    const run = (event: 'started' | 'running' | 'exited', pid: number) =>
      act(() => { deliver!({ type: 'app:log:run', sessionId: 'mine', watchId: 'w', event, pid }) })
    const log = (text: string) => act(() => { deliver!({ type: 'app:log', sessionId: 'mine', watchId: 'w', text }) })

    it('opens on the app opened from the home screen, with no Launch, and marks a crash and a relaunch', () => {
      watchedInstalled()
      expect(output()).toBeNull()
      run('started', 100)
      log('hello\n')
      log('crash')
      run('exited', 100)
      run('started', 200)
      log('again\n')
      flushFrames()
      expect(rows()).toEqual(['── App started (pid 100) ──', 'hello', 'crash', '── App exited (pid 100) ──', '── App started (pid 200) ──', 'again'])
      expect(marks()).toHaveLength(3)
    })

    it('keeps the log through a Launch, which neither empties it nor waits on a launch id', () => {
      watchedInstalled()
      run('started', 100)
      log('first run\n')
      flushFrames()
      launch()
      run('exited', 100)
      run('started', 200)
      flushFrames()
      expect(rows()).toEqual(['── App started (pid 100) ──', 'first run', '── App exited (pid 100) ──', '── App started (pid 200) ──'])
    })

    it('is not opened by an exit alone, which is all a cleared app would show', () => {
      watchedInstalled()
      run('exited', 100)
      flushFrames()
      expect(output()).toBeNull()
      run('started', 101)
      flushFrames()
      expect(rows()).toEqual(['── App started (pid 101) ──'])
    })

    it('keeps the log over a reconnect, and marks a device that came up from off', () => {
      watchedInstalled()
      run('started', 100)
      log('before\n')
      flushFrames()
      act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['app-logs', 'app-log-watch'] }) })
      act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
      act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1', cold: true } }) })
      run('running', 300)
      flushFrames()
      expect(rows()).toEqual(['── App started (pid 100) ──', 'before', '── Device restarted ──', '── App running (pid 300) ──'])
    })
  })
})

