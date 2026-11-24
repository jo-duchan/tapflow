import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_LOG_WATCH_EXIT_POLL_MS,
  APP_LOG_WATCH_RESTART_MIN_MS,
  AppLogWatch,
  runningAppPid,
  type AppLogWatchDeps,
  type AppLogWatchItem,
} from '../AppLogWatch.js'

const IMAGE = '/Users/me/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/AAA/TheApp.app/TheApp'
const entry = (pid: number, text: string) => `2026-11-24 20:37:04.080 Df TheApp[${pid}:6b70cf] ${text}\n`

function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), pause: vi.fn(), resume: vi.fn() })
  return Object.assign(new EventEmitter(), { stdout, exitCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess & { stdout: EventEmitter }
}

function setup(over: Partial<AppLogWatchDeps> = {}, previousRun: number | null = null) {
  const children: Array<ReturnType<typeof fakeChild>> = []
  const alive = new Set<number>()
  const deps: AppLogWatchDeps = {
    spawn: vi.fn(() => { const c = fakeChild(); children.push(c); return c }) as unknown as AppLogWatchDeps['spawn'],
    findOrphans: vi.fn(async () => []),
    killPid: vi.fn(),
    findRunning: vi.fn(async () => null),
    isAlive: (pid) => alive.has(pid),
    ...over,
  }
  const items: AppLogWatchItem[] = []
  let accept = true
  const watch = new AppLogWatch('U1', IMAGE, (item) => { if (!accept) return false; items.push(structuredClone(item)); return true }, vi.fn(), deps, Date.now, previousRun)
  /** What the holder would see: text joined, a run boundary as its own marker. */
  const shown = () => items.map((i) => (i.kind === 'run' ? `[${i.event} ${i.pid}]` : i.text)).join('')
  return { deps, children, alive, items, watch, shown, block: (b: boolean) => { accept = !b } }
}

describe('iOS app log watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('streams the app by its executable path, not a pid, so one stream outlives each run', async () => {
    const { deps, watch } = setup()
    await watch.start()
    expect(deps.spawn).toHaveBeenCalledWith('xcrun', [
      'simctl', 'spawn', 'U1', 'log', 'stream', '--level', 'debug', '--style', 'compact',
      '--predicate', 'processImagePath ENDSWITH "/TheApp.app/TheApp"',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    watch.stop()
  })

  it('marks each run by the pid on its entries: a home-screen open, a crash, a relaunch', async () => {
    const { children, alive, shown, watch } = setup()
    await watch.start()
    const out = children[0]!.stdout
    out.emit('data', 'Filtering the log data using "processImagePath ENDSWITH[cd] \\"/TheApp.app/TheApp\\""\n')
    out.emit('data', `Timestamp               Ty Process[PID:TID]\n${entry(100, 'hello')}\tcontinued`)
    alive.add(100)
    out.emit('data', `\n${entry(100, 'about to crash')}`)
    // The relaunch's first line arrives before the poll saw the crash: exited still comes first.
    out.emit('data', entry(200, 'again'))
    // A line the ended run wrote last, delivered late: it joins the new run, with no boundary of its own.
    out.emit('data', entry(100, 'late'))
    expect(shown()).toBe(
      `[started 100]${entry(100, 'hello')}\tcontinued\n${entry(100, 'about to crash')}[exited 100][started 200]${entry(200, 'again')}${entry(100, 'late')}`,
    )
    watch.stop()
  })

  it('says exited when the run\'s process is gone, and a late line of it joins no new run', async () => {
    const { children, alive, shown, watch } = setup()
    await watch.start()
    const out = children[0]!.stdout
    alive.add(100)
    out.emit('data', entry(100, 'one'))
    alive.delete(100)
    vi.advanceTimersByTime(APP_LOG_WATCH_EXIT_POLL_MS)
    out.emit('data', entry(100, 'late'))
    expect(shown()).toBe(`[started 100]${entry(100, 'one')}[exited 100]${entry(100, 'late')}`)
    watch.stop()
  })

  it('says running, not started, for an app already up when the watch begins', async () => {
    const { children, alive, shown, watch } = setup({ findRunning: vi.fn(async () => 300) })
    alive.add(300)
    await watch.start()
    children[0]!.stdout.emit('data', entry(300, 'still here'))
    expect(shown()).toBe(`[running 300]${entry(300, 'still here')}`)
    watch.stop()
  })

  it('raised again after a boot or an install, ends the run the last stream left, or carries on with it', async () => {
    const gone = setup({}, 100)
    await gone.watch.start()
    expect(gone.shown()).toBe('[exited 100]')
    gone.watch.stop()

    const up = setup({ findRunning: vi.fn(async () => 100) }, 100)
    up.alive.add(100)
    await up.watch.start()
    up.children[0]!.stdout.emit('data', entry(100, 'still'))
    expect(up.shown()).toBe(entry(100, 'still'))
    expect(up.watch.stop()).toBe(100)
  })

  it('ends the streams an earlier agent left before starting its own (#1235)', async () => {
    const order: string[] = []
    const { watch } = setup({
      findOrphans: vi.fn(async () => { order.push('find'); return [7] }),
      killPid: vi.fn((pid: number) => { order.push(`kill ${pid}`) }),
      spawn: vi.fn(() => { order.push('spawn'); return fakeChild() }) as unknown as AppLogWatchDeps['spawn'],
    })
    await watch.start()
    expect(order).toEqual(['find', 'kill 7', 'spawn'])
    watch.stop()
  })

  it('raises the stream again when it dies under it, later each time', async () => {
    const { children, deps, watch } = setup()
    await watch.start()
    children[0]!.emit('close', 1)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS)
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    children[1]!.emit('close', 1)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS)
    expect(deps.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS)
    expect(deps.spawn).toHaveBeenCalledTimes(3)
    watch.stop()
  })

  it('stops its child and raises nothing after stop', async () => {
    const { children, deps, watch } = setup()
    await watch.start()
    watch.stop()
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    children[0]!.emit('close', null)
    await vi.advanceTimersByTimeAsync(APP_LOG_WATCH_RESTART_MIN_MS * 4)
    expect(deps.spawn).toHaveBeenCalledTimes(1)
  })

  it('holds everything in order while the socket is full, and pauses the pipe', async () => {
    const { children, alive, shown, block, watch } = setup()
    await watch.start()
    const out = children[0]!.stdout
    alive.add(100)
    block(true)
    out.emit('data', entry(100, 'a'))
    expect(shown()).toBe('')
    expect(out.pause).toHaveBeenCalled()
    block(false)
    vi.advanceTimersByTime(20)
    expect(shown()).toBe(`[started 100]${entry(100, 'a')}`)
    watch.stop()
  })

  it('finds a running app by its executable under this device only', () => {
    const ps = [
      '  501 /Users/me/Library/Developer/CoreSimulator/Devices/U2/data/Containers/Bundle/Application/B/TheApp.app/TheApp',
      '  502 /Users/me/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/A/Other.app/Other',
      '  503 /Users/me/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/A/TheApp.app/TheApp -AppleLanguages (en)',
    ].join('\n')
    expect(runningAppPid(ps, 'U1', '/TheApp.app/TheApp')).toBe(503)
    expect(runningAppPid(ps, 'U3', '/TheApp.app/TheApp')).toBeNull()
  })
})
