import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_LOG_WATCH_EXIT_POLL_MS, APP_LOG_WATCH_RESTART_MIN_MS, AppLogWatch, type AppLogWatchDeps, type AppLogWatchItem } from '../AppLogWatch.js'

const PKG = 'com.example.app'
const line = (pid: number, text: string, tag = 'Tag') => `I(${String(pid).padStart(5)}) ${text}  (${tag})\n`

function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), pause: vi.fn(), resume: vi.fn() })
  return Object.assign(new EventEmitter(), { stdout, exitCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess & { stdout: EventEmitter }
}

function setup(over: Partial<AppLogWatchDeps> = {}) {
  const children: Array<ReturnType<typeof fakeChild>> = []
  const procs: Array<{ pid: number; name: string }> = []
  const deps: AppLogWatchDeps = {
    spawn: vi.fn(() => { const c = fakeChild(); children.push(c); return c }) as unknown as AppLogWatchDeps['spawn'],
    adbPath: () => 'adb',
    uid: vi.fn(async () => 10193),
    processes: vi.fn(async () => procs.map((p) => ({ ...p }))),
    deviceTime: vi.fn(async () => '11-24 20:00:00.000'),
    ...over,
  }
  const items: AppLogWatchItem[] = []
  const watch = new AppLogWatch('emulator-5594', PKG, (item) => { items.push(structuredClone(item)); return true }, vi.fn(), deps)
  const shown = () => items.map((i) => (i.kind === 'run' ? `[${i.event} ${i.pid}]` : i.text)).join('')
  const settle = () => vi.advanceTimersByTimeAsync(0)
  return { deps, children, procs, items, watch, shown, settle }
}

describe('Android app log watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('streams the uid from now, with each line\'s pid', async () => {
    const { deps, watch } = setup()
    await watch.start()
    expect(deps.spawn).toHaveBeenCalledWith('adb', ['-s', 'emulator-5594', 'logcat', '--uid=10193', '-T', '11-24 20:00:00.000', '-v', 'process'], { stdio: ['ignore', 'pipe', 'ignore'] })
    watch.stop()
  })

  it('marks runs of the main process only, and sends each message as raw text', async () => {
    const { children, procs, shown, settle, watch } = setup()
    await watch.start()
    const out = children[0]!.stdout
    procs.push({ pid: 5344, name: PKG }, { pid: 5350, name: `${PKG}:remote` })
    out.emit('data', '--------- beginning of main\n' + line(5344, 'hello') + line(5350, 'from remote') + line(5344, 'FATAL EXCEPTION: main', 'AndroidRuntime'))
    await settle()
    procs.length = 0
    procs.push({ pid: 5407, name: PKG })
    out.emit('data', line(5407, 'again'))
    await settle()
    expect(shown()).toBe(
      '--------- beginning of main\n[started 5344]hello\nfrom remote\nFATAL EXCEPTION: main\n[exited 5344][started 5407]again\n',
    )
    watch.stop()
  })

  it('keeps a message that has two spaces and parentheses of its own', async () => {
    const { children, procs, shown, settle, watch } = setup()
    procs.push({ pid: 1, name: PKG })
    await watch.start()
    children[0]!.stdout.emit('data', line(1, 'status  (ok) done'))
    await settle()
    expect(shown()).toBe('[running 1]status  (ok) done\n')
    watch.stop()
  })

  it('says exited when the poll no longer lists the run\'s process', async () => {
    const { children, procs, shown, settle, watch } = setup()
    await watch.start()
    procs.push({ pid: 9, name: PKG })
    children[0]!.stdout.emit('data', line(9, 'up'))
    await settle()
    procs.length = 0
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_EXIT_POLL_MS)
    expect(shown()).toBe('[started 9]up\n[exited 9]')
    watch.stop()
  })

  it('refuses a package that is not installed or shares its uid, as the Launch stream does', async () => {
    const { deps, watch } = setup({ uid: vi.fn(async () => null) })
    await watch.start()
    expect(deps.spawn).not.toHaveBeenCalled()
    watch.stop()
  })

  it('raises the stream again when logcat ends under it', async () => {
    const { children, deps, watch } = setup()
    await watch.start()
    children[0]!.emit('close', 1)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS)
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    watch.stop()
    children[1]!.emit('close', null)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS * 4)
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    expect(children[1]!.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
