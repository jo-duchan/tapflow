import { describe, expect, it } from 'vitest'
import { AppLogBuffer, appLogMarkText, emptiesWatchedLog, endsShownLaunch } from '@/lib/appLogs'

describe('app log buffer', () => {
  const rows = (buffer: AppLogBuffer) => Array.from({ length: buffer.rowCount }, (_, i) => buffer.row(i))

  it('joins a line split across chunks and holds the unfinished one as the last row', () => {
    const buffer = new AppLogBuffer()
    buffer.append('ab')
    buffer.append('c\nd')
    expect(buffer.lines).toEqual(['abc'])
    expect(buffer.partial).toBe('d')
    expect(rows(buffer)).toEqual(['abc', 'd'])
  })

  it('keeps empty lines, and adds no row after a trailing newline', () => {
    const buffer = new AppLogBuffer()
    buffer.append('one\n\nthree\n')
    expect(rows(buffer)).toEqual(['one', '', 'three'])
  })

  it('drops the oldest lines in steps once over the cap, and counts them', () => {
    const buffer = new AppLogBuffer(10, 4)
    buffer.append('x\n'.repeat(13) + 'tail')
    expect(buffer.lines).toHaveLength(13)
    expect(buffer.dropped).toBe(0)
    const trimmed = buffer.append('\n')
    expect(trimmed).toBe(4)
    expect(buffer.lines).toHaveLength(10)
    expect(buffer.dropped).toBe(4)
    expect(buffer.lines.at(-1)).toBe('tail')
  })

  // Lines can be kilobytes each (a response body logged whole), so a line count alone does not bound memory.
  it('also drops the oldest lines once the held text passes its size budget, to below it by a step', () => {
    const buffer = new AppLogBuffer(1_000, 100, 1_000)
    buffer.append('x'.repeat(100) + '\n'.repeat(1))
    for (let i = 0; i < 9; i++) buffer.append('y'.repeat(100) + '\n')
    expect(buffer.lines).toHaveLength(10)
    expect(buffer.dropped).toBe(0)
    const trimmed = buffer.append('z'.repeat(100) + '\n')
    expect(trimmed).toBeGreaterThan(0)
    expect(buffer.lines.at(-1)).toBe('z'.repeat(100))
    expect(buffer.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(1_000 * 0.9)
    expect(buffer.dropped).toBe(trimmed)
  })

  it('keeps the newest line even when it alone is over the size budget', () => {
    const buffer = new AppLogBuffer(1_000, 100, 10)
    buffer.append('a\n' + 'b'.repeat(50) + '\n')
    expect(buffer.lines).toEqual(['b'.repeat(50)])
  })

  it('never drops the unfinished line', () => {
    const buffer = new AppLogBuffer(2, 1)
    buffer.append('a\nb\nc\npart')
    expect(buffer.partial).toBe('part')
    expect(buffer.lines).toEqual(['b', 'c'])
    expect(buffer.dropped).toBe(1)
  })

  it('keeps a surrogate pair split across chunks as one character', () => {
    const buffer = new AppLogBuffer()
    const rocket = '🚀'
    buffer.append('go ' + rocket[0])
    buffer.append(rocket[1] + '\n')
    expect(buffer.lines).toEqual(['go 🚀'])
  })

  it('gives every held line and the unfinished one as text', () => {
    const buffer = new AppLogBuffer(2, 1)
    buffer.append('a\nb\nc\npart')
    expect(buffer.text()).toBe('b\nc\npart')
    const ended = new AppLogBuffer()
    ended.append('a\nb\n')
    expect(ended.text()).toBe('a\nb')
  })
})

// Flow Capture's replay sends these through the viewer's socket, and the relay forgets the shown launch on each.
describe('what ends the shown launch', () => {
  it('is a clear-state, an install, or a launch the viewer did not start', () => {
    expect(endsShownLaunch({ type: 'app:clear-state', sessionId: 's', requestId: 'r', payload: { bundleId: 'b' } }, 'shown')).toBe(true)
    expect(endsShownLaunch({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 1 }, 'shown')).toBe(true)
    expect(endsShownLaunch({ type: 'app:launch', sessionId: 's', requestId: 'replay', buildId: 1 }, 'shown')).toBe(true)
  })

  it("is not the viewer's own launch, nor an input", () => {
    expect(endsShownLaunch({ type: 'app:launch', sessionId: 's', requestId: 'shown', buildId: 1 }, 'shown')).toBe(false)
    expect(endsShownLaunch({ type: 'input:key', sessionId: 's', payload: { code: 'KeyA' } } as never, 'shown')).toBe(false)
  })
})

describe('run separators', () => {
  it('ends an unfinished line before the separator, and copies it as text', () => {
    const buffer = new AppLogBuffer()
    buffer.append('crash')
    buffer.mark(appLogMarkText('exited', 5344))
    buffer.mark(appLogMarkText('started', 5407))
    buffer.append('again\n')
    expect(buffer.lines).toEqual(['crash', '── App exited (pid 5344) ──', '── App started (pid 5407) ──', 'again'])
    expect([0, 1, 2, 3].map((i) => buffer.isMark(i))).toEqual([false, true, true, false])
    expect(buffer.text()).toBe('crash\n── App exited (pid 5344) ──\n── App started (pid 5407) ──\nagain')
  })

  it('keeps marking the same lines after the oldest are dropped', () => {
    const buffer = new AppLogBuffer(4, 2)
    buffer.append('a\nb\n')
    buffer.mark('── x ──')
    buffer.append('c\nd\ne\n')
    expect(buffer.dropped).toBe(2)
    expect(buffer.lines).toEqual(['── x ──', 'c', 'd', 'e'])
    expect(buffer.isMark(0)).toBe(true)
    expect(buffer.isMark(1)).toBe(false)
    buffer.append('f\ng\n')
    expect(buffer.lines[0]).toBe('d')
    expect(buffer.isMark(0)).toBe(false)
  })

  it('names each boundary', () => {
    expect(appLogMarkText('running', 1)).toBe('── App running (pid 1) ──')
    expect(appLogMarkText('device-restarted')).toBe('── Device restarted ──')
  })

  it('is emptied only by an install or a clear state when the app is watched', () => {
    expect(emptiesWatchedLog({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 1 })).toBe(true)
    expect(emptiesWatchedLog({ type: 'app:clear-state', sessionId: 's', requestId: 'r', payload: { bundleId: 'b' } } as never)).toBe(true)
    expect(emptiesWatchedLog({ type: 'app:launch', sessionId: 's', requestId: 'r', buildId: 1 })).toBe(false)
    expect(emptiesWatchedLog({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 1, keepIfInstalled: true })).toBe(false)
  })
})

