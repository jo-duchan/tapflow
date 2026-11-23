// State that used to be set from an effect, now derived, read from its store, or reset by unmounting
// (#845). Each case is the behaviour that effect existed for, so removing the new mechanism fails it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  performanceMode: () => 'standard',
}))

import { useIsMobile } from '@/hooks/useMobile'
import { usePerfMode } from '@/hooks/usePerfMode'
import { DeepLinkDialog } from '@/components/device/DeepLinkDialog'
import { SimulatorInfoCard } from '@/components/device/shared/SimulatorInfoCard'
import type { AppLogHandler } from '@/components/device/shared/AppLogViewer'
import { PERF_NOTICE_KEY } from '@/lib/perfNotice'

describe('useIsMobile reads the viewport as a store', () => {
  let matches = false
  const listeners = new Set<() => void>()
  beforeEach(() => {
    matches = false
    listeners.clear()
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return matches },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is right on the first render, and follows the viewport after', () => {
    matches = true
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
    act(() => { matches = false; listeners.forEach((cb) => cb()) })
    expect(result.current).toBe(false)
  })
})

describe('usePerfMode', () => {
  it('shows the overlay again after leaving perf mode and coming back, even if it was hidden', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/session?perf=1']}>{children}</MemoryRouter>
    )
    const { result } = renderHook(() => ({ perf: usePerfMode(), navigate: useNavigate() }), { wrapper })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true })) })
    expect(result.current.perf.visible).toBe(false)
    act(() => { void result.current.navigate('/session') })
    expect(result.current.perf.visible).toBe(false)
    act(() => { void result.current.navigate('/session?perf=1') })
    expect(result.current.perf.visible).toBe(true)
  })
})

describe('DeepLinkDialog', () => {
  it('opens empty each time, not with what was typed before it closed', async () => {
    const props = { onOpenChange: vi.fn(), openUrl: vi.fn() }
    const view = render(<DeepLinkDialog open {...props} />)
    await userEvent.type(screen.getByLabelText('Deeplink URL'), 'myapp://half')
    view.rerender(<DeepLinkDialog open={false} {...props} />)
    view.rerender(<DeepLinkDialog open {...props} />)
    expect((screen.getByLabelText('Deeplink URL') as HTMLInputElement).value).toBe('')
  })

  it('opens empty even when reopened while the close animation is still running', async () => {
    // Radix keeps the content mounted until its exit animation ends. jsdom runs no animations, so the
    // animation is reported through getComputedStyle, which is what Radix's Presence reads; it then
    // waits for an animationend that never comes, and the closed content stays mounted.
    const real = window.getComputedStyle.bind(window)
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      // Presence keeps the object it got at mount and reads it again on close — live in a browser, so
      // this answers from the element's state at the moment it is read. A name different from the one
      // it had while open is what counts as animating out.
      if (!(el instanceof HTMLElement) || el.getAttribute('role') !== 'dialog') return style
      return new Proxy(style, {
        get: (target, prop) => {
          if (prop === 'animationName') return el.dataset.state === 'closed' ? 'exit' : 'enter'
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    try {
      const props = { onOpenChange: vi.fn(), openUrl: vi.fn() }
      const view = render(<DeepLinkDialog open {...props} />)
      await userEvent.type(screen.getByLabelText('Deeplink URL'), 'myapp://half')
      view.rerender(<DeepLinkDialog open={false} {...props} />)
      expect(screen.queryByLabelText('Deeplink URL'), 'the exit animation should keep it mounted').not.toBeNull()
      view.rerender(<DeepLinkDialog open {...props} />)
      expect((screen.getByLabelText('Deeplink URL') as HTMLInputElement).value).toBe('')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('SimulatorInfoCard — the Standard-mode notice', () => {
  const props = {
    joined: true, fps: 0, appLogHandlerRef: { current: null as AppLogHandler | null }, connected: true, deviceReady: true, bootError: null,
    installing: false, installError: null, decoderUnsupported: false, keyboardActive: false,
  }
  afterEach(() => localStorage.clear())

  it('opens on its own the first time a browser streams in Standard mode', () => {
    localStorage.clear()
    render(<SimulatorInfoCard {...props} />)
    expect(screen.getByText('Streaming in Standard mode')).toBeInTheDocument()
  })

  it('stays closed once it has been dismissed in this browser', () => {
    // The twin of the case above: same mode, only the stored dismissal differs.
    localStorage.setItem(PERF_NOTICE_KEY, '1')
    render(<SimulatorInfoCard {...props} />)
    expect(screen.queryByText('Streaming in Standard mode')).toBeNull()
  })
})
