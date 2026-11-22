import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppLogViewer, type AppLogHandler } from '@/components/device/shared/AppLogViewer'

function makeHandlerRef() {
  return { current: null as AppLogHandler | null }
}

let frames: FrameRequestCallback[] = []
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

function flushFrames() {
  act(() => frames.splice(0).forEach((callback) => callback(0)))
}

describe('AppLogViewer', () => {
  it('explains when the connected agent does not support app logs', () => {
    render(<AppLogViewer handlerRef={makeHandlerRef()} supported={false} />)
    expect(screen.getByRole('log', { name: 'App log output' }).textContent).toBe('Update the device agent to view app logs.')
  })

  it('batches chunks until the next animation frame', () => {
    const handlerRef = makeHandlerRef()
    render(<AppLogViewer handlerRef={handlerRef} supported />)
    const log = screen.getByRole('log', { name: 'App log output' })
    act(() => {
      handlerRef.current?.('first')
      handlerRef.current?.(' second')
    })

    expect(log.textContent).toMatch(/Waiting for app logs/)
    flushFrames()
    expect(log.textContent).toBe('first second')
  })

  it('resumes following the tail after the buffer is cleared', () => {
    const handlerRef = makeHandlerRef()
    render(<AppLogViewer handlerRef={handlerRef} supported />)
    const log = screen.getByRole('log', { name: 'App log output' })
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    })

    log.scrollTop = 0
    fireEvent.scroll(log)
    act(() => handlerRef.current?.('first output'))
    flushFrames()

    act(() => handlerRef.current?.(null))
    expect(log.scrollTop).toBe(300)
    act(() => handlerRef.current?.('new launch output'))
    flushFrames()
    expect(log.scrollTop).toBe(300)
  })

  it('is focusable for keyboard users', () => {
    render(<AppLogViewer handlerRef={makeHandlerRef()} supported={true} />)
    const logRegion = screen.getByRole('log')
    expect(logRegion).toHaveAttribute('tabindex', '0')
  })
})
