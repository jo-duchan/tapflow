import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createSleepBlocker } from '../utils/power'

function fakeProc() {
  const e = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
  e.kill = vi.fn()
  e.unref = vi.fn()
  return e
}

describe('createSleepBlocker', () => {
  it('is a complete no-op off macOS', () => {
    const spawnFn = vi.fn(() => fakeProc())
    const b = createSleepBlocker('linux', spawnFn as never)
    b.acquire()
    b.release()
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('spawns `caffeinate -i` on acquire (macOS)', () => {
    const spawnFn = vi.fn(() => fakeProc())
    const b = createSleepBlocker('darwin', spawnFn as never)
    b.acquire()
    expect(spawnFn).toHaveBeenCalledOnce()
    expect(spawnFn).toHaveBeenCalledWith('caffeinate', ['-i'], { stdio: 'ignore' })
  })

  it('is idempotent — repeated acquire spawns once', () => {
    const spawnFn = vi.fn(() => fakeProc())
    const b = createSleepBlocker('darwin', spawnFn as never)
    b.acquire()
    b.acquire()
    b.acquire()
    expect(spawnFn).toHaveBeenCalledOnce()
  })

  it('kills the process on release and can re-acquire afterwards', () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const spawnFn = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const b = createSleepBlocker('darwin', spawnFn as never)
    b.acquire()
    b.release()
    expect(procs[0].kill).toHaveBeenCalledOnce()
    b.acquire()
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })

  it('re-acquires after the process emits error (caffeinate missing)', () => {
    const procs: ReturnType<typeof fakeProc>[] = []
    const spawnFn = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const b = createSleepBlocker('darwin', spawnFn as never)
    b.acquire()
    procs[0].emit('error', new Error('ENOENT')) // handle dropped
    b.acquire()
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })

  it('does not throw if spawn itself throws', () => {
    const spawnFn = vi.fn(() => { throw new Error('boom') })
    const b = createSleepBlocker('darwin', spawnFn as never)
    expect(() => b.acquire()).not.toThrow()
  })
})
