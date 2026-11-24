import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { APP_LOG_PID_POLL_INTERVAL_MS, AppLogStream, orphanAppLogStreams } from '../AppLogStream.js'

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

  describe("log stream's own header", () => {
    function streamWithChild() {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), pause: vi.fn(), resume: vi.fn() })
      const child = Object.assign(new EventEmitter(), { pid: 1, stdout, exitCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess
      const onText = vi.fn()
      const stream = new AppLogStream('sim-1', 123, '/A.app/A', onText, vi.fn(), vi.fn(() => child) as unknown as typeof import('child_process').spawn, () => true)
      return { stdout, child, onText, stream, text: () => onText.mock.calls.map(([c]) => c as string).join('') }
    }

    // Measured on iOS 26.5: the first line comes at once, the column title only just before the first entry.
    it('is dropped, both lines, even when they arrive split across chunks and apart', () => {
      const { stdout, text, stream } = streamWithChild()
      stdout.emit('data', 'Filtering the log data using "processImagePath ')
      stdout.emit('data', 'ENDSWITH[cd] \\"/A.app/A\\""\n')
      stdout.emit('data', 'Timestamp               Ty Process[PID:TID]\n2026-11-24 20:37:04.080 Df A[123:6b70] hello\n')
      expect(text()).toBe('2026-11-24 20:37:04.080 Df A[123:6b70] hello\n')
      stream.stop()
    })

    it('stops being looked for after the first entry: the same words later are the app\'s', () => {
      const { stdout, text, stream } = streamWithChild()
      stdout.emit('data', 'Filtering the log data using "x"\nfirst\nFiltering the log data using "y"\nTimestamp               Ty Process[PID:TID]\n')
      expect(text()).toBe('first\nFiltering the log data using "y"\nTimestamp               Ty Process[PID:TID]\n')
      stream.stop()
    })

    it('lets a first line that cannot be the header through at once', () => {
      const { stdout, text, stream } = streamWithChild()
      stdout.emit('data', 'no header')
      expect(text()).toBe('no header')
      stream.stop()
    })

    it('holds a partial line that may be the header, and drops it if the stream closes mid-header', () => {
      const { stdout, child, text } = streamWithChild()
      stdout.emit('data', 'Filtering the')
      expect(text()).toBe('')
      child.emit('close', 0, null)
      expect(text()).toBe('')
    })

    it('does not hold a long first line waiting for its end', () => {
      const { stdout, text, stream } = streamWithChild()
      stdout.emit('data', 'y'.repeat(9000))
      expect(text()).toBe('y'.repeat(9000))
      stream.stop()
    })
  })

  // #1235. Measured on iOS 18.5 and 26.5: a SIGKILLed `simctl spawn`, or an agent killed while its stream is quiet,
  // leaves `log stream` running in the simulator, a child of that device's launchd_sim.
  describe('orphan sweep', () => {
    const U = 'B15B7F66-BB44-4590-BE75-9C24C9ED5966'
    const OTHER = '3BE1E0C2-3CA7-4D49-B98C-16591AF73788'
    const ps = [
      `89055     1 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${U}/data/var/run/launchd_bootstrap.plist`,
      `90000     1 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${OTHER}/data/var/run/launchd_bootstrap.plist`,
      `89243 89055 log stream --level debug --style compact --predicate processIdentifier == 69668 AND processImagePath == "/x/TheApp.app/TheApp"`,
      `89244 90000 log stream --level debug --style compact --predicate processIdentifier == 1 AND processImagePath == "/x/TheApp.app/TheApp"`,
      `89245 89055 log stream --style ndjson --predicate subsystem == "com.apple.UIKit" AND category == "EventDispatch"`,
      `89246 89055 log stream --level debug --style compact --predicate processImagePath ENDSWITH "/Nope.app/Nope"`,
      `89247  4242 log stream --level debug --style compact --predicate processIdentifier == 5 AND processImagePath == "/y"`,
      `89237     1 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl spawn ${U} log stream --level debug --style compact --predicate processIdentifier == 69668 AND processImagePath == "/x/TheApp.app/TheApp"`,
    ].join('\n')

    it("finds only this device's app log streams, by their parent and their arguments", () => {
      expect(orphanAppLogStreams(ps, U)).toEqual([89243])
      expect(orphanAppLogStreams(ps, OTHER)).toEqual([89244])
      expect(orphanAppLogStreams(ps, 'NOPE')).toEqual([])
      // A runtime that shows the full path, whose `iOS 26.5.simruntime` folder has a space in it.
      const fullPath = `89300 89055 /Library/Developer/CoreSimulator/Volumes/iOS_23E254a/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/usr/bin/log stream --level debug --style compact --predicate processIdentifier == 7 AND processImagePath == "/a"`
      expect(orphanAppLogStreams(`${ps}\n${fullPath}`, U)).toEqual([89243, 89300])
    })
  })
})
