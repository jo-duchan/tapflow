import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppLogViewer } from '@/components/device/shared/AppLogViewer'
import { loadAppLogRows } from '@/components/device/shared/appLogRowsChunk'
import { APP_LOG_MAX_LINES, APP_LOG_TRIM_STEP, AppLogFeed } from '@/lib/appLogs'
import { FAKE_ROW_HEIGHT, fakeAppLogLayout } from './appLogLayout'

// The real virtualizer, passed straight through; the tests only keep a handle on what it was given and what it holds.
type Virtualizer = ReturnType<typeof import('@tanstack/react-virtual')['useVirtualizer']>
const virtualizers: { instance: Virtualizer; getItemKey: unknown }[] = []
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: ((options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const instance = actual.useVirtualizer(options)
      virtualizers.push({ instance, getItemKey: options.getItemKey })
      return instance
    }) as typeof actual.useVirtualizer,
  }
})

function makeFeed() {
  return new AppLogFeed()
}

// The rows are a lazy chunk the viewer starts loading on launch; loaded here so a test can read them in the same frame.
beforeAll(() => loadAppLogRows())

let frames: FrameRequestCallback[] = []
let layout: ReturnType<typeof fakeAppLogLayout>
beforeEach(() => {
  frames = []
  layout = fakeAppLogLayout()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => {
  vi.unstubAllGlobals()
  layout.restore()
})

function flushFrames() {
  act(() => frames.splice(0).forEach((callback) => callback(0)))
}

function launched(supported = true) {
  const feed = makeFeed()
  render(<AppLogViewer feed={feed} supported={supported} />)
  act(() => feed.handle({ kind: 'launch' }))
  const send = (text: string) => act(() => feed.handle({ kind: 'text', text }))
  return { feed, send }
}
const output = () => screen.getByRole('region', { name: 'App log output' })
const lines = () => Array.from(output().querySelectorAll('[data-log-line]'), (line) => line.textContent)
const rowTop = (text: string) => {
  const row = Array.from(output().querySelectorAll<HTMLElement>('[data-log-line]')).find((line) => line.textContent === text)!
  return parseFloat(/translateY\(([-\d.]+)px\)/.exec(row.style.transform)![1])
}

describe('AppLogViewer', () => {
  it('renders nothing until a launch', () => {
    const feed = makeFeed()
    render(<AppLogViewer feed={feed} supported />)
    expect(screen.queryByRole('region', { name: 'App logs' })).toBeNull()
    act(() => feed.handle({ kind: 'launch' }))
    expect(output().textContent).toMatch(/Waiting for app logs/)
    act(() => feed.handle({ kind: 'clear' }))
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
    const { feed, send } = launched()
    send('line\n'.repeat(100))
    flushFrames()
    const first = output()
    layout.scrollBox(first, 0)

    act(() => feed.handle({ kind: 'launch' }))
    const next = output()
    expect(next).not.toBe(first)
    send('new launch output\n'.repeat(100))
    flushFrames()
    expect(next.scrollTop).toBe(next.scrollHeight - next.clientHeight)
    expect(next.scrollTop).toBeGreaterThan(0)
  })

  // jsdom, like Safari, does not move focus to a clicked button.
  it('moves focus out of the log to the toggle when it collapses under it', () => {
    const { send } = launched()
    send('line\n')
    flushFrames()
    output().focus()
    expect(output()).toHaveFocus()
    const toggle = screen.getByRole('button', { name: 'App logs' })
    fireEvent.click(toggle)
    expect(toggle).toHaveFocus()
  })

  it('copies the whole log while collapsed too', async () => {
    const { send } = launched()
    send('alpha\nbeta')
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'App logs' }))
    expect(output().closest('[inert]')).not.toBeNull()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(writeText).toHaveBeenCalledWith('alpha\nbeta')
  })

  it('opens again at the tail after a collapse', () => {
    const { send } = launched()
    send('line\n'.repeat(100))
    flushFrames()
    const toggle = screen.getByRole('button', { name: 'App logs' })
    fireEvent.click(toggle)
    send('more\n'.repeat(100))
    flushFrames()
    fireEvent.click(toggle)
    flushFrames()
    expect(output().scrollTop).toBe(output().scrollHeight - output().clientHeight)
    expect(output().scrollTop).toBeGreaterThan(0)
  })

  it('collapses and remembers it', () => {
    const { send } = launched()
    send('line')
    flushFrames()
    const toggle = screen.getByRole('button', { name: 'App logs' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Kept mounted so the rows keep their measured heights, but out of reach: no focus, not in the accessibility tree.
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(body).toHaveAttribute('inert')
    expect(body).toContainElement(output())
    fireEvent.click(toggle)
    expect(body).not.toHaveAttribute('inert')
    fireEvent.click(toggle)
    expect(localStorage.getItem('tapflow.appLogs.collapsed')).toBe('1')
  })

  it('copies every held line, drawn or not, through the copy command where there is no clipboard', async () => {
    const { send } = launched()
    const all = Array.from({ length: 500 }, (_, i) => `line ${i}`)
    send(all.join('\n'))
    flushFrames()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    let copied = ''
    const execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const button = screen.getByRole('button', { name: 'Copy' })
    button.focus()
    await act(async () => { fireEvent.click(button) })
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copied).toBe(all.join('\n'))
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveFocus()
    Reflect.deleteProperty(document, 'execCommand')

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copied' })) })
    expect(writeText).toHaveBeenCalledWith(all.join('\n'))
  })

  it('does not say Copied when the copy command fails', async () => {
    const { send } = launched()
    send('alpha')
    flushFrames()
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('mounts only the rows in view, however many lines it holds', () => {
    const { send } = launched()
    send(Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n') + '\n')
    flushFrames()
    // The scroll to the tail is read back from the next frame's scroll event, as in a browser.
    flushFrames()
    const mounted = lines()
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(40)
    // At the tail: the newest line is among them.
    expect(mounted).toContain('line 9999')
    expect(screen.getByText('10,000 lines')).toBeInTheDocument()
  })

  it('drops the oldest lines past the cap and says how many, outside the copied text', async () => {
    const { send } = launched()
    const total = APP_LOG_MAX_LINES + APP_LOG_TRIM_STEP
    send(Array.from({ length: total }, (_, i) => `line ${i}`).join('\n') + '\n')
    flushFrames()
    expect(screen.getByText(`${APP_LOG_MAX_LINES.toLocaleString('en-US')} lines (${APP_LOG_TRIM_STEP.toLocaleString('en-US')} dropped)`)).toBeInTheDocument()
    expect(output().querySelector('[data-log-dropped]')!.textContent).toBe(`${APP_LOG_TRIM_STEP.toLocaleString('en-US')} earlier lines dropped`)
    // The note (24px, at the top) sits above the first held line, not over it.
    layout.scrollBox(output(), 0)
    flushFrames()
    expect(rowTop(`line ${APP_LOG_TRIM_STEP}`)).toBeGreaterThanOrEqual(24)

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    const text = writeText.mock.calls[0][0] as string
    expect(text.startsWith(`line ${APP_LOG_TRIM_STEP}\n`)).toBe(true)
    expect(text.endsWith(`line ${total - 1}`)).toBe(true)
    expect(text).not.toMatch(/dropped/)
  })

  // The reader is scrolled up reading a line; the top is trimmed under them and more arrives at the bottom.
  it('keeps the line being read in place while the oldest lines are dropped', () => {
    const { send } = launched()
    send(Array.from({ length: APP_LOG_MAX_LINES }, (_, i) => `line ${i}`).join('\n') + '\n')
    flushFrames()
    const box = output()
    const reading = 30_000
    layout.scrollBox(box, reading * FAKE_ROW_HEIGHT)
    flushFrames()
    expect(lines()).toContain(`line ${reading}`)
    const before = rowTop(`line ${reading}`) - box.scrollTop

    send(Array.from({ length: APP_LOG_TRIM_STEP }, (_, i) => `more ${i}`).join('\n') + '\n')
    flushFrames()
    flushFrames()
    expect(output().querySelector('[data-log-dropped]')).not.toBeNull()
    expect(lines()).toContain(`line ${reading}`)
    expect(rowTop(`line ${reading}`) - box.scrollTop).toBe(before)
  })

  // Below the cap the count grows on every append: that must not send a reader who scrolled up back to the tail.
  it('keeps the line being read in place while lines are appended', () => {
    const { send } = launched()
    send(Array.from({ length: 1_000 }, (_, i) => `line ${i}`).join('\n') + '\n')
    flushFrames()
    flushFrames()
    const box = output()
    layout.scrollBox(box, 300 * FAKE_ROW_HEIGHT)
    flushFrames()
    const before = rowTop('line 300') - box.scrollTop

    send('more\n'.repeat(50))
    flushFrames()
    flushFrames()
    expect(lines()).toContain('line 300')
    expect(rowTop('line 300') - box.scrollTop).toBe(before)
  })

  it('keeps following the tail at the bottom while the oldest lines are dropped', () => {
    const { send } = launched()
    send(Array.from({ length: APP_LOG_MAX_LINES }, (_, i) => `line ${i}`).join('\n') + '\n')
    // Settled at the tail first: with the opening scroll still unread, the next append would be carried by that scroll
    // rather than by following, and the test would pass without it.
    flushFrames()
    flushFrames()
    send(Array.from({ length: APP_LOG_TRIM_STEP }, (_, i) => `more ${i}`).join('\n') + '\n')
    flushFrames()
    flushFrames()
    const box = output()
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
    expect(lines()).toContain(`more ${APP_LOG_TRIM_STEP - 1}`)
  })

  it('follows the tail as lines are appended below the cap', () => {
    const { send } = launched()
    send('line\n'.repeat(100))
    flushFrames()
    flushFrames()
    for (let i = 0; i < 3; i++) {
      send(`more ${i}\n`.repeat(20))
      flushFrames()
      flushFrames()
      const box = output()
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight)
      expect(lines()).toContain(`more ${i}`)
    }
  })

  // A new key function makes the virtualizer rebuild every row's position, 50,000 of them, on a render that only scrolled.
  it('keeps the row key function across renders that drop nothing', () => {
    const { send } = launched()
    send('line\n'.repeat(200))
    flushFrames()
    flushFrames()
    const before = virtualizers.at(-1)!.getItemKey
    layout.scrollBox(output(), 0)
    flushFrames()
    send('more\n')
    flushFrames()
    expect(virtualizers.at(-1)!.getItemKey).toBe(before)
  })

  // Every row drawn leaves its measured height behind, keyed by line number: kept for dropped lines, that grows with
  // everything the stream ever showed rather than with the cap.
  it('forgets the measured heights of dropped lines', () => {
    layout.restore()
    layout = fakeAppLogLayout({ rowHeight: () => FAKE_ROW_HEIGHT + 13 })
    const { send } = launched()
    send(Array.from({ length: APP_LOG_MAX_LINES }, (_, i) => `line ${i}`).join('\n') + '\n')
    flushFrames()
    flushFrames()
    send(Array.from({ length: APP_LOG_TRIM_STEP }, (_, i) => `more ${i}`).join('\n') + '\n')
    flushFrames()
    flushFrames()
    const keys = [...virtualizers.at(-1)!.instance.itemSizeCache.keys()] as number[]
    expect(keys.length).toBeGreaterThan(0)
    expect(Math.min(...keys)).toBeGreaterThanOrEqual(APP_LOG_TRIM_STEP)
  })

  it('is focusable for keyboard users and is not a live region', () => {
    launched()
    expect(output()).toHaveAttribute('tabindex', '0')
    expect(output()).not.toHaveAttribute('aria-live')
  })
})
