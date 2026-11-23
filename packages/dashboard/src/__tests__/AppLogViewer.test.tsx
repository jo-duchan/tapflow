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
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => vi.unstubAllGlobals())

function flushFrames() {
  act(() => frames.splice(0).forEach((callback) => callback(0)))
}

function launched(supported = true) {
  const handlerRef = makeHandlerRef()
  render(<AppLogViewer handlerRef={handlerRef} supported={supported} />)
  act(() => handlerRef.current?.({ kind: 'launch' }))
  const send = (text: string) => act(() => handlerRef.current?.({ kind: 'text', text }))
  return { handlerRef, send }
}
const output = () => screen.getByRole('region', { name: 'App log output' })
const lines = () => Array.from(output().querySelectorAll('[data-log-line]'), (line) => line.textContent)

describe('AppLogViewer', () => {
  it('renders nothing until a launch', () => {
    const handlerRef = makeHandlerRef()
    render(<AppLogViewer handlerRef={handlerRef} supported />)
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
    act(() => handlerRef.current?.({ kind: 'launch' }))
    expect(output().textContent).toMatch(/Waiting for app logs/)
    act(() => handlerRef.current?.({ kind: 'clear' }))
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
  })

  it('explains when the connected agent does not support app logs', () => {
    launched(false)
    expect(output().textContent).toBe('Update the device agent to view app logs.')
  })

  it('batches chunks until the next animation frame', () => {
    const { send } = launched()
    send('first')
    send(' second')
    expect(output().textContent).toMatch(/Waiting for app logs/)
    flushFrames()
    expect(lines()).toEqual(['first second'])
  })

  // The card is 300px wide: a line wraps in its own row instead of scrolling the box sideways.
  it('puts each line in its own wrapping row, a partial last line included', () => {
    const { send } = launched()
    send('one\ntwo\nthr')
    flushFrames()
    send('ee\n')
    flushFrames()
    expect(lines()).toEqual(['one', 'two', 'three'])
    expect(output().className).toMatch(/overflow-x-hidden/)
    expect(output().querySelector('[data-log-line]')!.className).toMatch(/whitespace-pre-wrap/)
  })

  it('follows the tail of a new launch even if the last one was scrolled up', () => {
    const { handlerRef, send } = launched()
    send('first output')
    flushFrames()
    const first = output()
    Object.defineProperties(first, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })
    fireEvent.scroll(first)

    act(() => handlerRef.current?.({ kind: 'launch' }))
    const next = output()
    expect(next).not.toBe(first)
    Object.defineProperties(next, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })
    send('new launch output')
    flushFrames()
    expect(next.scrollTop).toBe(300)
  })

  it('collapses and remembers it', () => {
    const { send } = launched()
    send('line')
    flushFrames()
    const toggle = screen.getByRole('button', { name: 'App logs' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'App log output' })).toBeNull()
    expect(localStorage.getItem('tapflow.appLogs.collapsed')).toBe('1')
  })

  it('copies the whole log, and selects it where there is no clipboard', async () => {
    const { send } = launched()
    send('alpha\nbeta')
    flushFrames()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const select = vi.spyOn(window, 'getSelection')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(select).toHaveBeenCalled()

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(writeText).toHaveBeenCalledWith('alpha\nbeta')
  })

  it('is focusable for keyboard users and is not a live region', () => {
    launched()
    expect(output()).toHaveAttribute('tabindex', '0')
    expect(output()).not.toHaveAttribute('aria-live')
  })
})
