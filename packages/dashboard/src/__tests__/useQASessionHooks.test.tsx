import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AgentDevice, Build, RelayMessage, SessionInfo } from '@/lib/types'

vi.mock('@/lib/queries', () => ({
  getBuild: vi.fn(),
}))

vi.mock('@/hooks/useRelay', () => ({
  useRelay: vi.fn(),
}))

import { getBuild } from '@/lib/queries'
import { useRelay } from '@/hooks/useRelay'
import { useBuildLoader } from '@/hooks/useBuildLoader'
import { useAgentSession } from '@/hooks/useAgentSession'
import { useDeviceSelector } from '@/hooks/useDeviceSelector'

const mockSend = vi.fn()
let capturedOnMessage: (msg: RelayMessage) => void = () => {}

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  agentName: 'test-mac',
  devices: [],
  ...overrides,
})

const makeDevice = (overrides: Partial<AgentDevice> = {}): AgentDevice => ({
  id: 'avd:Pixel_7',
  name: 'Pixel 7',
  platform: 'android',
  status: 'booted',
  sessionId: 'sess-1',
  busy: false,
  ...overrides,
})

// ─── useBuildLoader ────────────────────────────────────────────────────────────

describe('useBuildLoader', () => {
  beforeEach(() => vi.mocked(getBuild).mockReset())

  it('returns null and does not fetch when buildId is null', () => {
    const { result } = renderHook(() => useBuildLoader(null))
    expect(result.current.build).toBeNull()
    expect(getBuild).not.toHaveBeenCalled()
  })

  it('fetches build and updates state when buildId is provided', async () => {
    const fakeBuild = { id: 42, name: 'MyApp' } as Build
    vi.mocked(getBuild).mockResolvedValue(fakeBuild)

    const { result } = renderHook(() => useBuildLoader('42'))
    await act(async () => {})

    expect(getBuild).toHaveBeenCalledWith('42')
    expect(result.current.build).toBe(fakeBuild)
  })

  it('re-fetches when buildId changes', async () => {
    const build42 = { id: 42, name: 'A' } as Build
    const build99 = { id: 99, name: 'B' } as Build
    vi.mocked(getBuild).mockResolvedValueOnce(build42).mockResolvedValueOnce(build99)

    const { result, rerender } = renderHook(({ id }) => useBuildLoader(id), {
      initialProps: { id: '42' as string | null },
    })
    await act(async () => {})
    expect(result.current.build).toBe(build42)

    rerender({ id: '99' })
    await act(async () => {})
    expect(result.current.build).toBe(build99)
  })
})

// ─── useAgentSession ───────────────────────────────────────────────────────────

describe('useAgentSession', () => {
  beforeEach(() => {
    mockSend.mockReset()
    vi.mocked(useRelay).mockImplementation((onMessage) => {
      capturedOnMessage = onMessage
      return { send: mockSend, connected: false }
    })
  })

  afterEach(() => vi.useRealTimers())

  it('sends agents:list immediately and on interval when connected', () => {
    vi.useFakeTimers()
    vi.mocked(useRelay).mockImplementation((onMessage) => {
      capturedOnMessage = onMessage
      return { send: mockSend, connected: true }
    })

    renderHook(() => useAgentSession('android'))

    expect(mockSend).toHaveBeenCalledWith({ type: 'agents:list' })
    const callCount = mockSend.mock.calls.length

    vi.advanceTimersByTime(5000)
    expect(mockSend.mock.calls.length).toBe(callCount + 1)

    vi.advanceTimersByTime(5000)
    expect(mockSend.mock.calls.length).toBe(callCount + 2)
  })

  it('updates sessions on agents:listed message', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const sessions = [makeSession({ agentName: 'mac-1' })]

    act(() => capturedOnMessage({ type: 'agents:listed', sessions } as RelayMessage))

    expect(result.current.sessions).toEqual(sessions)
  })

  it('clears booting flag and sets status on session:joined', async () => {
    const { result } = renderHook(() => useAgentSession('android'))

    act(() => {
      result.current.startDevice(makeDevice())
    })
    expect(result.current.booting).toBe(true)

    act(() => capturedOnMessage({ type: 'session:joined' } as RelayMessage))
    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('Connected')
  })

  it('clears booting flag and sets error status on error message', () => {
    const { result } = renderHook(() => useAgentSession('android'))

    act(() => result.current.startDevice(makeDevice()))
    act(() => capturedOnMessage({ type: 'error', message: 'boom' } as RelayMessage))

    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('Error: boom')
  })

  it('sends device:shutdown and resets state on handleBack', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.startDevice(device))
    // flush ref update effect
    await act(async () => {})

    act(() => result.current.handleBack())

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('')
  })

  it('sends device:shutdown and clears selectedAgent on handleBackToMacs', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.setSelectedAgent('mac-1'))
    act(() => result.current.startDevice(device))
    await act(async () => {})

    act(() => result.current.handleBackToMacs())

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.selectedAgent).toBeNull()
  })

  it('sends device:shutdown on unmount when a session is active', async () => {
    const { result, unmount } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.startDevice(device))
    await act(async () => {})

    unmount()

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
  })
})

// ─── useDeviceSelector ─────────────────────────────────────────────────────────

describe('useDeviceSelector', () => {
  const devices: AgentDevice[] = [
    makeDevice({ id: 'd1', name: 'Pixel 7', osVersion: 'Android 14', platform: 'android' }),
    makeDevice({ id: 'd2', name: 'Pixel 6', osVersion: 'Android 13', platform: 'android' }),
    makeDevice({ id: 'd3', name: 'iPhone 15', osVersion: 'iOS 17', platform: 'ios' }),
  ]
  const session: SessionInfo = { agentName: 'mac', devices }

  it('filters devices by osVersion when set', () => {
    const { result } = renderHook(() => useDeviceSelector(session, 'android'))

    act(() => result.current.setOsVersion('Android 14'))

    expect(result.current.versionedDevices).toEqual([devices[0]])
  })

  it('filters devices by name search', () => {
    const { result } = renderHook(() => useDeviceSelector(session, 'android'))

    act(() => result.current.setDeviceSearch('Pixel 6'))

    expect(result.current.versionedDevices).toEqual([devices[1]])
  })

  it('returns osVersions sorted descending (newest first)', () => {
    const mixedDevices: AgentDevice[] = [
      makeDevice({ osVersion: 'Android 13', platform: 'android' }),
      makeDevice({ osVersion: 'Android 15', platform: 'android' }),
      makeDevice({ osVersion: 'Android 14', platform: 'android' }),
    ]
    const sess: SessionInfo = { agentName: 'mac', devices: mixedDevices }
    const { result } = renderHook(() => useDeviceSelector(sess, 'android'))

    expect(result.current.osVersions).toEqual(['Android 15', 'Android 14', 'Android 13'])
  })
})
