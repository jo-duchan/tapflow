import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'events'
import { execFile, spawn } from 'child_process'

vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.kill = vi.fn()
  proc.unref = vi.fn()
  return proc
}

// execFile callback arrives as the last argument regardless of options
function cbSuccess(_f: unknown, _a: unknown, cb: (e: null, out: string, err: string) => void) {
  cb(null, '', '')
  return {} as ReturnType<typeof execFile>
}

function cbFail(error: Error) {
  return (_f: unknown, _a: unknown, cb: (e: Error) => void) => {
    cb(error)
    return {} as ReturnType<typeof execFile>
  }
}

describe('ScrcpySession', () => {
  beforeAll(() => {
    vi.stubEnv('LOG_LEVEL', 'debug')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    process.env['ADB_PATH'] = '/usr/bin/adb'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
    delete process.env['ADB_PATH']
  })

  it('kills serverProc when an error is thrown after spawn', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                              // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)   // forward: fail

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    // Attach catch immediately to prevent PromiseRejectionHandledWarning
    let caughtError: Error | undefined
    const startPromise = session.start('emulator-5554').catch(e => { caughtError = e })
    await vi.advanceTimersByTimeAsync(1500)
    await startPromise

    expect(caughtError?.message).toBe('forward failed')
    expect(proc.kill).toHaveBeenCalled()
  })

  it('does not kill serverProc on the error path before spawn', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbFail(new Error('push failed')) as never)  // push: fail (before spawn)

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    await expect(session.start('emulator-5554')).rejects.toThrow('push failed')
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('does not crash the process when serverProc emits an error', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                            // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never) // forward: fail

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    const startPromise = session.start('emulator-5554').catch(() => {})

    // Flush the awaited push (execFileAsync) so start() reaches the spawn() call and
    // attaches its listeners before we emit — spawn() itself runs after that await.
    await vi.advanceTimersByTimeAsync(0)

    // An EventEmitter throws a synchronous, uncaught error on 'error' with no listener
    // attached — e.g. spawn() failing (ENOENT/EACCES) or EPERM from kill() — which would
    // crash the whole agent (all devices it manages), not just this session.
    expect(() => proc.emit('error', new Error('EPIPE'))).not.toThrow()

    await vi.advanceTimersByTimeAsync(1500)
    await startPromise
  })
  it('logs a warning when serverProc exits unexpectedly', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                              // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)   // forward: fail

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const startPromise = session.start('emulator-5554').catch(() => {})

    // Advance past execFileAsync (push) so spawn() and its handlers are attached
    await vi.advanceTimersByTimeAsync(0)

    // Simulate the server process exiting with code 1 and no signal
    proc.emit('exit', 1, null)

    // Advance past the rest of start() and wait for cleanup
    await vi.advanceTimersByTimeAsync(1500)
    await startPromise

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpectedly'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('code=1'))

    warnSpy.mockRestore()
  })

  it('logs at debug level (not warn) when serverProc exits after stop()', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                              // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)   // forward: fail
      .mockImplementation(cbSuccess as never)                                  // forward --remove: success

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const startPromise = session.start('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)

    // Intentionally stop the session before exit fires
    session.stop('emulator-5554')

    // Now the process exits (expected teardown)
    proc.emit('exit', null, 'SIGTERM')

    await vi.advanceTimersByTimeAsync(1500)
    await startPromise

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unexpectedly'))
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('signal=SIGTERM'))

    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })

  it('warns again on an unexpected exit after a restart following a clean stop', async () => {
    // Regression: `stopping` was set true in stop() but never reset, so after the FIRST
    // stop/restart cycle every later unexpected exit silently logged at debug forever --
    // exactly the failure this whole change exists to make visible.
    vi.useFakeTimers()

    const proc1 = makeFakeProc()
    const proc2 = makeFakeProc()
    vi.mocked(spawn)
      .mockReturnValueOnce(proc1 as never)
      .mockReturnValueOnce(proc2 as never)
    vi.mocked(execFile)
      .mockImplementation(cbSuccess as never)

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    // First run: stop cleanly, first process exits, expect debug only.
    const firstStart = session.start('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    session.stop('emulator-5554')
    proc1.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(1500)
    await firstStart

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockClear()
    debugSpy.mockClear()

    // Restart: the second process exits unexpectedly. Without the reset, this would still log
    // at debug because `stopping` was never cleared by the first stop().
    const secondStart = session.start('emulator-5554').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    proc2.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(1500)
    await secondStart

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpectedly'))

    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })
})
