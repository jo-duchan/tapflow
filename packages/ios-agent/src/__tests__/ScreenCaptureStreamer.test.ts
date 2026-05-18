import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'

vi.mock('child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

async function setupProc() {
  const { spawn } = await import('child_process')
  const proc = makeFakeProc()
  vi.mocked(spawn).mockReturnValue(proc as never)
  // existsSync(BINARY)=true, existsSync(SWIFT_SRC)=false → ensureCompiled() skips recompile
  vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false)
  return proc
}

describe('ScreenCaptureStreamer', () => {
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM on cancel', async () => {
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not send SIGKILL when process exits within 1s', async () => {
    vi.useFakeTimers()
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()
    proc.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('sends SIGKILL if process does not exit within 1s', async () => {
    vi.useFakeTimers()
    const proc = await setupProc()
    const { ScreenCaptureStreamer } = await import('../ScreenCaptureStreamer')

    const reader = new ScreenCaptureStreamer(30, 'booted').start().getReader()
    await reader.cancel()
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
