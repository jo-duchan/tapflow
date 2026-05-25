import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { usePerfMode } from '@/hooks/usePerfMode'

function wrapper(url: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  )
}

describe('usePerfMode', () => {
  it('perfMode is false when ?perf param is absent', () => {
    const { result } = renderHook(() => usePerfMode(), { wrapper: wrapper('/session') })
    expect(result.current.perfMode).toBe(false)
    expect(result.current.visible).toBe(false)
  })

  it('perfMode and visible are true when ?perf=1', () => {
    const { result } = renderHook(() => usePerfMode(), { wrapper: wrapper('/session?perf=1') })
    expect(result.current.perfMode).toBe(true)
    expect(result.current.visible).toBe(true)
  })

  it('perfMode is false when ?perf=0', () => {
    const { result } = renderHook(() => usePerfMode(), { wrapper: wrapper('/session?perf=0') })
    expect(result.current.perfMode).toBe(false)
    expect(result.current.visible).toBe(false)
  })

  it('Ctrl+Shift+P toggles visible when perfMode is on', () => {
    const { result } = renderHook(() => usePerfMode(), { wrapper: wrapper('/session?perf=1') })
    expect(result.current.visible).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true }))
    })
    expect(result.current.visible).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true }))
    })
    expect(result.current.visible).toBe(true)
  })

  it('Ctrl+Shift+P has no effect when perfMode is off', () => {
    const { result } = renderHook(() => usePerfMode(), { wrapper: wrapper('/session') })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true }))
    })
    expect(result.current.visible).toBe(false)
  })

  it('visible becomes true when navigating from no perf to ?perf=1', async () => {
    let navigateFn: ReturnType<typeof useNavigate> | null = null

    function NavigationCapture() {
      navigateFn = useNavigate()
      return null
    }

    const { result } = renderHook(() => usePerfMode(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/session']}>
          <NavigationCapture />
          {children}
        </MemoryRouter>
      ),
    })

    expect(result.current.visible).toBe(false)

    await act(async () => {
      navigateFn!('/session?perf=1')
    })

    expect(result.current.perfMode).toBe(true)
    expect(result.current.visible).toBe(true)
  })
})
