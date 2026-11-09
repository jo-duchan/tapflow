import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { AppLogStream } from '../AppLogStream.js'

vi.mock('../sdk.js', () => ({ getAdbPath: () => 'adb' }))

describe('Android app log stream', () => {
  it('scopes raw logcat output to the launched app UID, preserves text, and stops its child', () => {
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
    const onText = vi.fn()
    const stream = new AppLogStream('emulator-5554', 10123, onText, vi.fn(), { spawnProcess })

    expect(spawnProcess).toHaveBeenCalledWith(
      'adb',
      ['-s', 'emulator-5554', 'logcat', '--uid=10123', '-v', 'raw'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const text = `${'y'.repeat(8191)}🚀\nnext`
    stdout.emit('data', text)
    expect(onText.mock.calls.map(([chunk]) => chunk).join('')).toBe(text)
    expect(onText.mock.calls.every(([chunk]) => Buffer.byteLength(chunk, 'utf8') <= 8192)).toBe(
      true
    )

    stream.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops the child when the launched app no longer owns its PID', async () => {
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
      const isTargetAlive = vi.fn().mockResolvedValue(false)
      const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
      const stream = new AppLogStream('emulator-5554', 10123, vi.fn(), vi.fn(), {
        spawnProcess,
        isTargetAlive,
      })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(isTargetAlive).toHaveBeenCalledOnce()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      stream.stop()
      expect(child.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops stdout chunks delivered after the stream stops', () => {
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
    const onText = vi.fn()
    const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
    const stream = new AppLogStream('emulator-5554', 10123, onText, vi.fn(), { spawnProcess })

    stream.stop()
    stdout.emit('data', 'buffered after stop')

    expect(onText).not.toHaveBeenCalled()
  })

  it('reports an unsuccessful logcat exit while capture is active', () => {
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    })
    const child = Object.assign(new EventEmitter(), {
      stdout,
      exitCode: null,
      killed: false,
      kill: vi.fn(),
    }) as unknown as ChildProcess
    const onError = vi.fn()
    const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
    const stream = new AppLogStream('emulator-5554', 10123, vi.fn(), onError, { spawnProcess })

    child.emit('close', 1, null)

    expect(onError).toHaveBeenCalledWith(new Error('Android app logcat exited with code 1'))
    stream.stop()
  })

  it('stops and reports an error when PID ownership cannot be checked', async () => {
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
      const error = new Error('adb unavailable')
      const onError = vi.fn()
      const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
      const stream = new AppLogStream('emulator-5554', 10123, vi.fn(), onError, {
        spawnProcess,
        isTargetAlive: vi.fn().mockRejectedValue(error),
      })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(onError).toHaveBeenCalledWith(error)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops checking when the logcat child closes', async () => {
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
        kill: vi.fn(),
      }) as unknown as ChildProcess
      const isTargetAlive = vi.fn().mockResolvedValue(true)
      const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
      const stream = new AppLogStream('emulator-5554', 10123, vi.fn(), vi.fn(), {
        spawnProcess,
        isTargetAlive,
      })
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(isTargetAlive).toHaveBeenCalledOnce()
      child.emit('close', 0, null)

      expect(vi.getTimerCount()).toBe(0)
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
