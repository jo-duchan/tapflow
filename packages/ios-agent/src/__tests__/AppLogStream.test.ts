import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { APP_LOG_PID_POLL_INTERVAL_MS, AppLogStream } from '../AppLogStream.js'

describe('iOS app log stream', () => {
  it('scopes native output to the launched process, preserves text, and stops its child', () => {
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    })
    const child = {
      pid: 456,
      stdout,
      exitCode: null,
      killed: false,
      once: vi.fn(),
      kill: vi.fn(function (this: { killed: boolean }) {
        this.killed = true
        return true
      }),
    } as unknown as ChildProcess
    const spawnMock = vi.fn((..._args: unknown[]) => child)
    const spawnProcess = spawnMock as unknown as typeof import('child_process').spawn
    const onText = vi.fn()
    const stream = new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', onText, vi.fn(), spawnProcess, () => true)

    expect(spawnProcess).toHaveBeenCalledWith(
      'xcrun',
      [
        'simctl',
        'spawn',
        'sim-1',
        'log',
        'stream',
        '--level',
        'debug',
        '--style',
        'compact',
        '--predicate',
        'processIdentifier == 123 AND processImagePath == "/Applications/Example.app/Example"',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const text = `${'x'.repeat(8191)}🚀\nnext`
    stdout.emit('data', text)
    expect(onText.mock.calls.map(([chunk]) => chunk).join('')).toBe(text)
    expect(onText.mock.calls.every(([chunk]) => Buffer.byteLength(chunk, 'utf8') <= 8192)).toBe(
      true
    )

    stream.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops the log child when the launched app process exits', () => {
    vi.useFakeTimers()
    try {
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      })
      const child = Object.assign(new EventEmitter(), {
        pid: 789,
        stdout,
        exitCode: null,
        killed: false,
        kill: vi.fn(function (this: { killed: boolean }) {
          this.killed = true
          return true
        }),
      }) as unknown as ChildProcess
      const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
      const isPidAlive = vi.fn(() => true)
      const onText = vi.fn()
      const stream = new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', onText, vi.fn(), spawnProcess, isPidAlive)

      isPidAlive.mockReturnValue(false)
      vi.advanceTimersByTime(APP_LOG_PID_POLL_INTERVAL_MS)
      child.emit('close', 143, 'SIGTERM')
      stdout.emit('data', 'late output')

      expect(isPidAlive).toHaveBeenCalledWith(123)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(onText).not.toHaveBeenCalled()
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains queued final output after target exit when the socket was backpressured', () => {
    vi.useFakeTimers()
    try {
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      })
      const child = Object.assign(new EventEmitter(), {
        pid: 789,
        stdout,
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        exitCode: null,
        killed: false,
        kill: vi.fn(function (this: { killed: boolean }) {
          this.killed = true
          return true
        }),
      }) as unknown as ChildProcess
      const isPidAlive = vi.fn(() => true)
      let writable = false
      const onText = vi.fn(() => writable)
      new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', onText, vi.fn(), vi.fn(() => child) as unknown as typeof import('child_process').spawn, isPidAlive)

      stdout.emit('data', 'last line')
      expect(onText).toHaveBeenCalledTimes(1)
      isPidAlive.mockReturnValue(false)
      vi.advanceTimersByTime(APP_LOG_PID_POLL_INTERVAL_MS)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      onText.mockClear()
      writable = true
      vi.advanceTimersByTime(20)
      expect(onText).toHaveBeenCalled()
      expect(onText).toHaveBeenLastCalledWith('last line')
      child.emit('close', 143, 'SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports nonzero exits with bounded stderr detail', () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), pause: vi.fn(), resume: vi.fn() })
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    const child = Object.assign(new EventEmitter(), {
      pid: 789,
      stdout,
      stderr,
      exitCode: 1,
      killed: false,
      kill: vi.fn(),
    }) as unknown as ChildProcess
    const onError = vi.fn()
    new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', vi.fn(), onError, vi.fn(() => child) as unknown as typeof import('child_process').spawn, () => true)

    stderr.emit('data', 'x'.repeat(5000))
    child.emit('close', 1, null)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0].message.length).toBeLessThan(2200)
  })

  it('stops polling when the log child fails to start', () => {
    vi.useFakeTimers()
    try {
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      })
      const child = Object.assign(new EventEmitter(), {
        stdout,
        exitCode: null,
        killed: false,
        kill: vi.fn(function (this: { killed: boolean }) {
          this.killed = true
          return true
        }),
      }) as unknown as ChildProcess
      const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
      const isPidAlive = vi.fn(() => true)
      const onError = vi.fn()
      const stream = new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', vi.fn(), onError, spawnProcess, isPidAlive)
      const error = new Error('spawn failed')

      child.emit('error', error)
      vi.advanceTimersByTime(APP_LOG_PID_POLL_INTERVAL_MS * 2)

      expect(onError).toHaveBeenCalledWith(error)
      expect(isPidAlive).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('escapes predicate quotes in an app executable path', () => {
    const child = {
      stdout: null,
      exitCode: null,
      killed: false,
      once: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess
    const spawnMock = vi.fn((..._args: unknown[]) => child)
    const spawnProcess = spawnMock as unknown as typeof import('child_process').spawn

    new AppLogStream('sim-1', 123, '/Apps/QA "Build"/Example\\App', vi.fn(), vi.fn(), spawnProcess, () => true).stop()

    expect(spawnMock.mock.calls[0]?.[1]).toContain(
      'processIdentifier == 123 AND processImagePath == "/Apps/QA \\\"Build\\\"/Example\\\\App"'
    )
  })

  it('stops polling when the log child closes', () => {
    vi.useFakeTimers()
    try {
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      })
      const child = Object.assign(new EventEmitter(), {
        pid: 456,
        stdout,
        exitCode: 0,
        killed: false,
        kill: vi.fn(),
      }) as unknown as ChildProcess
      const isPidAlive = vi.fn(() => true)
      new AppLogStream('sim-1', 123, '/Applications/Example.app/Example', vi.fn(), vi.fn(), vi.fn(() => child) as unknown as typeof import('child_process').spawn, isPidAlive)

      child.emit('close', 0, null)
      vi.advanceTimersByTime(APP_LOG_PID_POLL_INTERVAL_MS * 2)

      expect(isPidAlive).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
