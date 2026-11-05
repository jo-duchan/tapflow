import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { TouchHelper as TouchHelperType } from '../TouchHelper.js'

vi.mock('child_process', () => ({ spawn: vi.fn() }))

type FakeProc = EventEmitter & {
  pid: number | undefined
  stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

let nextPid = 4242

// A running helper: libuv assigned a pid and stdin is an open pipe. Running is not the same as
// usable — see announceReady.
function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = nextPid++
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn(() => true) }) as never
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn(() => true) // matches ChildProcess.kill() on a live process
  return proc
}

// A helper that never execed — a missing binary, a missing execute bit, or an arm64-only binary
// on an Intel Mac (#464 EBADARCH). Measured against a real `spawn` of a nonexistent path: libuv
// leaves `pid` undefined and reports the failure on a LATER tick, while stdin is already an open
// pipe whose `writable` reads `true`. `write()` returns false, but that is indistinguishable from
// ordinary backpressure on a healthy helper, so it is not a signal either. `pid` is the only
// thing that tells the truth synchronously.
function makeFailedProc(): FakeProc {
  const proc = makeFakeProc()
  proc.pid = undefined
  proc.stdin.write = vi.fn(() => false)
  return proc
}

// The helper announces itself on stderr once it holds its HID client and is about to start
// reading stdin (its `touch-helper ready` line). Measured on a real simulator: 186–247ms after spawn
// (n=5), and a gesture written before it lands nothing at all — the frames sit in the pipe and
// are drained in one go, collapsing a swipe into microseconds. So tests have to say when a helper
// reached that point, and the window before it is a real state worth covering.
function announceReady(proc: FakeProc): void {
  proc.stderr.emit('data', Buffer.from(`info: touch-helper ready (udid=dev-1) digitizer=true\n`))
}

// Node closes stdin when the child goes away, and `kill()` stops being deliverable once the
// process is reaped. Modelling both keeps a mutation from passing because the fake stayed
// writable on a corpse.
function die(proc: FakeProc, code: number | null = 1): void {
  proc.stdin.writable = false
  proc.kill = vi.fn(() => false)
  proc.emit('exit', code)
}

async function loadHelper(procs: FakeProc[]) {
  const { spawn } = await import('child_process')
  const mock = vi.mocked(spawn)
  mock.mockReset()
  let i = 0
  mock.mockImplementation((() => procs[Math.min(i++, procs.length - 1)]) as never)
  const { TouchHelper } = await import('../TouchHelper.js')
  return { helper: new TouchHelper('dev-1'), spawn: mock }
}

async function startedHelper(procs: FakeProc[]) {
  const { helper, spawn } = await loadHelper(procs)
  helper.start()
  announceReady(procs[0])
  return { helper, spawn }
}

async function setupHelper() {
  const proc = makeFakeProc()
  const { helper, spawn } = await startedHelper([proc])
  return { helper, proc, spawn }
}

// Timer-precision cases (SIGKILL suppressed/fired) are covered by childProcessKill.test.ts —
// these check TouchHelper actually wires stop() to it.
describe('TouchHelper.stop()', () => {
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM, then escalates to SIGKILL if the process never exits', async () => {
    vi.useFakeTimers()
    const { helper, proc } = await setupHelper()

    helper.stop()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(1000)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('is a no-op when called again after the process is already gone', async () => {
    vi.useFakeTimers() // leave the first stop()'s fallback timer pending, never fired, no leak into other tests
    const { helper, proc } = await setupHelper()

    helper.stop()
    helper.stop()

    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// A client leaving mid-gesture cancels the touch instead of ending it, so the app does not take it for a tap (#1115).
// The end it sends next must write nothing, and a cancel must never reach a helper with nothing down — one sent that
// way crashed backboardd in another tool.
describe('TouchHelper.touchCancel()', () => {
  const types = (proc: FakeProc) => proc.stdin.write.mock.calls.map((c) => (c[0] as Buffer)[0])

  it('writes a cancel frame for a touch that is down, and the end after it writes nothing', async () => {
    const { helper, proc } = await setupHelper()
    helper.touchStart(0.5, 0.5)
    expect(helper.touchCancel()).toBe(true)
    expect(helper.touchEnd()).toBe(false)
    expect(types(proc)).toEqual([1, 13])
  })

  it('writes nothing when no touch is down: never started, or already ended', async () => {
    const { helper, proc } = await setupHelper()
    expect(helper.touchCancel()).toBe(false)
    helper.touchStart(0.5, 0.5)
    helper.touchEnd()
    expect(helper.touchCancel()).toBe(false)
    expect(types(proc)).toEqual([1, 3])
  })

  it('drops an up held back for the minimum contact, and cancels instead', async () => {
    const { helper, proc } = await setupHelper()
    helper.touchStart(0.5, 0.5)
    const held = helper.touchEndAfterMinContact()
    expect(helper.touchCancel()).toBe(true)
    // Answered at the cancel, not when the minimum contact would have run out.
    await expect(Promise.race([held, new Promise((r) => setTimeout(() => r('still held'), 0))])).resolves.toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(types(proc)).toEqual([1, 13])
  })

  it('does not reach a helper that replaced the one the touch went down on', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])
    helper.touchStart(0.5, 0.5)
    die(first)
    announceReady(second)
    expect(helper.touchCancel()).toBe(false)
    expect(types(second)).toEqual([])
  })

  it('leaves an open pinch alone', async () => {
    const { helper, proc } = await setupHelper()
    helper.pinchStart(0.4, 0.5, 0.6, 0.5)
    expect(helper.touchCancel()).toBe(false)
    expect(types(proc)).toEqual([6])
  })
})

// What a boot waits on before it announces the device (#1114): a client acting on `device:ready` at once was refused
// its first input while the helper the boot had just started was still coming up.
describe('TouchHelper.whenReady()', () => {
  it('resolves once the helper announces itself, and at once when it already has', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()
    let settled: boolean | undefined
    void helper.whenReady().then((r) => { settled = r })
    await Promise.resolve()
    expect(settled).toBeUndefined()
    announceReady(proc)
    await Promise.resolve()
    expect(settled).toBe(true)
    await expect(helper.whenReady()).resolves.toBe(true)
  })

  // A helper that dies before it is ready is replaced, so the wait carries on to the replacement.
  it('keeps waiting across a helper that died before it was ready', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await loadHelper([first, second])
    helper.start()
    const ready = helper.whenReady()
    die(first)
    announceReady(second)
    await expect(ready).resolves.toBe(true)
  })

  it('answers false when the channel is stopped before it is ready', async () => {
    vi.useFakeTimers()
    try {
      const { helper } = await loadHelper([makeFakeProc()])
      helper.start()
      const ready = helper.whenReady()
      helper.stop()
      await expect(ready).resolves.toBe(false)
      await expect(helper.whenReady()).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A running helper is not a usable one. Measured: ~200ms between the two, and a frame written in
// between is silently ineffective — which is #482's failure in a narrower window, so it must not
// be reported as delivered.
describe('TouchHelper — a helper that is running but not yet ready', () => {
  afterEach(() => vi.useRealTimers())
  // The ack needs these three apart: `starting` tells a caller to retry in a moment, `unavailable`
  // tells it to reconnect. A write refusal alone cannot tell them apart, and the agent's own tests
  // mock this class, so this is the only layer where the distinction is observable.
  it('reports the three input states apart', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc, makeFakeProc()])

    expect(helper.inputState()).toBe('unavailable') // never started

    helper.start()
    expect(helper.inputState()).toBe('starting')    // running, not yet announced

    announceReady(proc)
    expect(helper.inputState()).toBe('ready')

    proc.stdin.writable = false
    expect(helper.inputState()).toBe('unavailable') // pipe gone
  })

  // The case the agent's own tests cannot see, because they mock this class and a mocked
  // `inputState()` is a constant: the *transition*. An opening frame refused during start-up owns
  // nothing, so its terminal frame can never land — however ready the helper has since become.
  it('owns no gesture when the opening frame was refused, even after it becomes ready', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()

    expect(helper.touchStart(0.5, 0.5)).toBe(false) // inside the start-up window
    announceReady(proc)

    expect(helper.inputState()).toBe('ready')  // the channel is fine now …
    expect(helper.ownsGesture()).toBe(false)   // … but this gesture never opened
    expect(helper.touchEnd()).toBe(false)
  })

  it('owns the gesture once an opening frame lands, and lets it go when the process changes', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])

    expect(helper.touchStart(0.4, 0.6)).toBe(true)
    expect(helper.ownsGesture()).toBe(true)

    die(first)
    announceReady(second)

    // The replacement is ready, and the gesture it never saw is not its to finish.
    expect(helper.inputState()).toBe('ready')
    expect(helper.ownsGesture()).toBe(false)
  })

  it('reports failure for a frame written before the helper announces itself', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()

    expect(helper.isReady()).toBe(false)
    expect(helper.touchStart(0.5, 0.5)).toBe(false)
    expect(proc.stdin.write).not.toHaveBeenCalled()
  })

  it('reports success once it does', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()
    announceReady(proc)

    expect(helper.isReady()).toBe(true)
    expect(helper.touchStart(0.5, 0.5)).toBe(true)
    expect(proc.stdin.write).toHaveBeenCalledTimes(1)
  })

  it('does not replace a helper that is merely still starting up', async () => {
    // Replacing it would spawn a second process, spend the window budget, and make the wait
    // longer rather than shorter.
    const { helper, spawn } = await loadHelper([makeFakeProc(), makeFakeProc()])
    helper.start()

    for (let i = 0; i < 10; i++) expect(helper.touchStart(0.5, 0.5)).toBe(false)

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('tolerates the announcement arriving split across stderr chunks', async () => {
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()

    proc.stderr.emit('data', Buffer.from('info: touch-hel'))
    proc.stderr.emit('data', Buffer.from('per ready (udid=dev-1)\n'))

    expect(helper.isReady()).toBe(true)
  })

  it('does not hand the rest of a gesture to a helper the opening frame never reached', async () => {
    // The trap in `openGesture`: recording the owner unconditionally reads as equivalent, and is
    // not. Here the open is refused because the helper is still starting, yet `this.proc` is a
    // healthy process that becomes ready a moment later — so identity would pass and the terminal
    // frame would inject a release at (0,0) on a process that never saw the down, reported as
    // delivered.
    const proc = makeFakeProc()
    const { helper } = await loadHelper([proc])
    helper.start()

    expect(helper.touchStart(0.4, 0.6)).toBe(false)
    announceReady(proc)
    expect(helper.isReady()).toBe(true)

    expect(helper.touchEnd()).toBe(false)
    expect(helper.touchMove(0.5, 0.7)).toBe(false)
    expect(proc.stdin.write).not.toHaveBeenCalled()
  })

  it('replaces a helper that never announces itself, so the session is not dead for good', async () => {
    // Running-but-never-ready has no other exit: nothing asks for a replacement (it is running)
    // and every input is refused (it is not ready). A wedge in the device lookup would otherwise
    // strand the session until the device was rebooted.
    vi.useFakeTimers()
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper, spawn } = await loadHelper([first, second])
    helper.start()

    await vi.advanceTimersByTimeAsync(4_000)
    expect(spawn).toHaveBeenCalledTimes(1) // still within its budget to start
    expect(first.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_500)
    expect(first.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawn).toHaveBeenCalledTimes(2)

    announceReady(second)
    expect(helper.isReady()).toBe(true)
  })

  it('does not replace a helper that announced itself in time', async () => {
    vi.useFakeTimers()
    const { helper, proc, spawn } = await setupHelper()

    await vi.advanceTimersByTimeAsync(30_000)

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(proc.kill).not.toHaveBeenCalled()
    expect(helper.isReady()).toBe(true)
  })

  it('does not let a superseded process mark its replacement ready', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])
    die(first)

    announceReady(first) // the corpse's last words arrive after the replacement is up

    expect(helper.isReady()).toBe(false)
    announceReady(second)
    expect(helper.isReady()).toBe(true)
  })
})

// #482: a helper that dies on its own left `this.proc` pointing at the corpse. Every write
// then returned early at a `stdin.writable` guard and the session accepted no further input,
// while the stream kept running and nothing was reported.
describe('TouchHelper — recovery from a helper that died on its own', () => {
  afterEach(() => vi.useRealTimers())

  it('respawns on exit without waiting for the next input', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper, spawn } = await startedHelper([first, second])
    expect(spawn).toHaveBeenCalledTimes(1)

    die(first)

    // Eager, not lazy: the replacement is already starting up before anyone taps, which is what
    // buys the ~200ms it needs. Verified on a real simulator — a kill while idle, then the next
    // swipe lands.
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(helper.isReady()).toBe(false)
    announceReady(second)
    expect(helper.isReady()).toBe(true)
  })

  it('respawns when a running helper errors rather than exiting', async () => {
    // Not the same as an exec failure: that one has no pid, takes the early return in
    // spawnHelper, and recovers lazily. This is a process that did start and then errored, which
    // goes through the same death path as an exit.
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper, spawn } = await startedHelper([first, second])

    first.stdin.writable = false
    first.emit('error', new Error('boom'))

    expect(spawn).toHaveBeenCalledTimes(2)
    announceReady(second)
    expect(helper.isReady()).toBe(true)
  })

  it('recovers lazily when the exec failed, since that death path never fires', async () => {
    const replacement = makeFakeProc()
    const { helper, spawn } = await loadHelper([makeFailedProc(), replacement])
    helper.start()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(helper.isReady()).toBe(false)

    // The frame that triggers the respawn cannot itself land — the replacement is not ready yet,
    // and saying otherwise is the lie this whole change is about.
    expect(helper.touchStart(0.5, 0.5)).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)

    announceReady(replacement)
    expect(helper.touchStart(0.5, 0.5)).toBe(true)
  })

  it('reports failure when the helper closes stdin without exiting', async () => {
    // #482 in its purest form: the process reference is still there and no death event has
    // fired, but the pipe is gone.
    const { helper, proc } = await setupHelper()

    proc.stdin.writable = false

    expect(helper.isReady()).toBe(false)
    expect(helper.touchEnd()).toBe(false)
  })

  it('sends the next gesture to the replacement process', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])
    die(first)
    announceReady(second)

    expect(helper.touchStart(0.5, 0.5)).toBe(true)
    expect(second.stdin.write).toHaveBeenCalledTimes(1)
    expect(first.stdin.write).not.toHaveBeenCalled()
  })

  it('does not respawn while the helper is alive', async () => {
    const { helper, proc, spawn } = await setupHelper()

    for (let i = 0; i < 20; i++) helper.touchStart(0.1, 0.1)

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(proc.stdin.write).toHaveBeenCalledTimes(20)
  })

  it('does not respawn after an intentional stop, not even for an input', async () => {
    // A healthy replacement is queued up deliberately: if stop() did not latch, the input below
    // would spawn it and the agent would be serving a helper it asked to be gone.
    const first = makeFakeProc()
    const { helper, spawn } = await startedHelper([first, makeFakeProc()])
    vi.useFakeTimers() // swallow stop()'s pending SIGKILL timer

    helper.stop()
    die(first, null) // SIGTERM landing, arriving after stop() cleared the reference
    expect(spawn).toHaveBeenCalledTimes(1)

    expect(helper.touchStart(0.5, 0.5)).toBe(false)
    expect(helper.isReady()).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('never makes a process that failed to exec the active helper', async () => {
    const first = makeFakeProc()
    const failed = makeFailedProc()
    const { helper } = await startedHelper([first, failed])

    die(first)

    expect(helper.touchStart(0.5, 0.5)).toBe(false)
    // The load-bearing assertion: a pid-less process must not have become `this.proc`, and the
    // only way to tell from out here is that its announcement cannot make the helper ready.
    // Asserting `isReady() === false` alone would pass for any fresh process.
    announceReady(failed)
    expect(helper.isReady()).toBe(false)
    expect(helper.touchStart(0.5, 0.5)).toBe(false)
  })
})

describe('TouchHelper — respawn budget', () => {
  afterEach(() => vi.useRealTimers())

  it('stops spawning at the ceiling, and keeps reporting failure after it', async () => {
    const { helper, spawn } = await loadHelper([makeFailedProc()])
    helper.start() // attempt 1 — fails

    // Each self-contained frame retries, so a permanently broken install (#464) would spawn a
    // doomed process per tap without this ceiling.
    for (let i = 0; i < 50; i++) expect(helper.touchStart(0.5, 0.5)).toBe(false)

    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('bounds churn from a helper that keeps dying, with no input at all', async () => {
    const procs = Array.from({ length: 8 }, () => makeFakeProc())
    const { helper } = await startedHelper(procs)

    for (const p of procs) die(p)

    expect(vi.mocked((await import('child_process')).spawn)).toHaveBeenCalledTimes(3)
    expect(helper.isReady()).toBe(false)
  })

  it('bounds it whatever the helper\'s lifetime — the ceiling is not a guess about start-up', async () => {
    // The failure mode a consecutive-failure counter has. A helper that reliably outlives the
    // "it died too fast" threshold and then dies resets such a counter every time, so it churns a
    // process every few seconds for the life of the agent — no input, no user, no ceiling. The
    // helper's own start-up is expensive enough (measured 186–247ms) to make any fixed threshold
    // a guess, and this is the direction a wrong guess fails in.
    vi.useFakeTimers()
    const procs = Array.from({ length: 8 }, () => makeFakeProc())
    const { helper: _h, spawn } = await startedHelper(procs)

    for (const p of procs) {
      await vi.advanceTimersByTimeAsync(3_000)
      die(p)
    }

    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('lets go of the corpse when it stops spawning, so a later stop() signals nothing', async () => {
    // #479's SIGKILL fallback arms a timer against whatever stop() was handed. Keeping a
    // reference to a reaped process past the ceiling would aim that timer at a pid the OS is free
    // to have reassigned by then.
    const procs = Array.from({ length: 4 }, () => makeFakeProc())
    const { helper } = await startedHelper(procs)
    // Three deaths reach the ceiling. procs[3] was never handed out, so its death is a no-op.
    for (const p of procs) die(p)

    helper.stop()

    for (const [i, p] of procs.entries()) expect(p.kill, `procs[${i}]`).not.toHaveBeenCalled()
  })

  it('serves a helper that crashes rarely without ever reaching the ceiling', async () => {
    vi.useFakeTimers()
    const procs = [makeFakeProc(), makeFakeProc(), makeFakeProc(), makeFakeProc()]
    const { helper, spawn } = await startedHelper(procs)

    // One crash per minute is well inside the window, so each one is replaced. Each replacement
    // has to announce itself, or the readiness deadline replaces it first — which is the
    // behaviour a different test pins.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
      die(procs[i])
      announceReady(procs[i + 1])
    }

    expect(spawn).toHaveBeenCalledTimes(4)
    expect(helper.isReady()).toBe(true)
  })

  it('recovers on its own once the window slides, so a transient failure is not permanent', async () => {
    vi.useFakeTimers()
    const last = makeFakeProc()
    const { helper, spawn } = await loadHelper([makeFailedProc(), makeFailedProc(), makeFailedProc(), last])
    helper.start()
    for (let i = 0; i < 5; i++) helper.touchStart(0.5, 0.5)
    expect(spawn).toHaveBeenCalledTimes(3)

    // Without this the ceiling is absorbing: no spawn can happen, so none can succeed, and only
    // a reboot would revive input on the session.
    await vi.advanceTimersByTimeAsync(30_000)

    expect(helper.touchStart(0.5, 0.5)).toBe(false) // spawned, not ready yet
    expect(spawn).toHaveBeenCalledTimes(4)
    announceReady(last)
    expect(helper.touchStart(0.5, 0.5)).toBe(true)
  })
})

// The case the frame-type split alone does not cover. Replacement is eager, so after a
// mid-gesture death there is normally a healthy process standing by — and writing the rest of
// the gesture to it is worse than dropping it, because the new process has the coordinate
// latches at zero and would release the touch at (0,0) while reporting success. Confirmed on a
// real simulator: the guard holds, and the next fresh gesture works, so nothing stays held.
describe('TouchHelper — a gesture belongs to the process that opened it', () => {
  afterEach(() => vi.useRealTimers())
  const continuations: Array<[string, (h: TouchHelperType) => boolean]> = [
    ['touchEnd', (h) => h.touchEnd()],
    ['touchMove', (h) => h.touchMove(0.5, 0.7)],
    ['pinchMove', (h) => h.pinchMove(0.1, 0.1, 0.2, 0.2)],
    ['pinchEnd', (h) => h.pinchEnd()],
  ]

  for (const [name, call] of continuations) {
    it(`refuses ${name} after the opening process died, even though a live one is standing by`, async () => {
      const first = makeFakeProc()
      const second = makeFakeProc()
      const { helper } = await startedHelper([first, second])
      expect(helper.touchStart(0.4, 0.6)).toBe(true)
      expect(helper.pinchStart(0.1, 0.1, 0.9, 0.9)).toBe(true)
      first.stdin.write.mockClear()

      die(first)
      announceReady(second)

      // The replacement is healthy and usable — that is the point. Liveness is not the question.
      expect(helper.isReady()).toBe(true)
      expect(call(helper)).toBe(false)
      expect(second.stdin.write).not.toHaveBeenCalled()
    })
  }

  it('serves the next gesture normally once it opens on the replacement', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])
    helper.touchStart(0.4, 0.6)
    die(first)
    announceReady(second)

    expect(helper.touchStart(0.1, 0.2)).toBe(true)
    expect(helper.touchEnd()).toBe(true)
    expect(second.stdin.write).toHaveBeenCalledTimes(2)
  })

  it('does not carry a gesture across an intentional restart either', async () => {
    const first = makeFakeProc()
    const second = makeFakeProc()
    const { helper } = await startedHelper([first, second])
    helper.touchStart(0.4, 0.6)
    vi.useFakeTimers() // swallow stop()'s pending SIGKILL timer
    helper.stop()
    helper.start()
    announceReady(second)

    expect(helper.isReady()).toBe(true)
    expect(helper.touchEnd()).toBe(false)
  })
})

describe('TouchHelper — which frames may resurrect the helper', () => {
  // Leaves the helper dead with budget to spare: the process died, and the eager respawn that
  // followed produced one that never execed. What the next frame does now is the whole question.
  async function deadWithBudget() {
    const first = makeFakeProc()
    const { helper, spawn } = await startedHelper([first, makeFailedProc(), makeFakeProc()])
    die(first)
    expect(helper.isReady()).toBe(false)
    spawn.mockClear()
    return { helper, spawn }
  }

  const continuations: Array<[number, string, (h: TouchHelperType) => boolean]> = [
    [2, 'touchMove', (h) => h.touchMove(0.5, 0.7)],
    [3, 'touchEnd', (h) => h.touchEnd()],
    [7, 'pinchMove', (h) => h.pinchMove(0.1, 0.1, 0.2, 0.2)],
    [8, 'pinchEnd', (h) => h.pinchEnd()],
  ]

  for (const [type, name, call] of continuations) {
    it(`type ${type} (${name}) reports failure rather than respawning`, async () => {
      const { helper, spawn } = await deadWithBudget()

      expect(call(helper)).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    })
  }

  // 1, 4, 5, 6, 9, 10, 11 — each carries its whole payload, so a fresh process serves it exactly
  // as the old one would have. The frame that triggers the respawn still reports failure, because
  // the replacement needs ~200ms before anything written to it reaches the device.
  const selfContained: Array<[number, string, (h: TouchHelperType) => boolean]> = [
    [1, 'touchStart', (h) => h.touchStart(0.5, 0.5)],
    [4, 'pressButton', (h) => h.pressButton(0x0c, 0xe9)],
    [5, 'pressLegacyButton', (h) => h.pressLegacyButton(0)],
    [6, 'pinchStart', (h) => h.pinchStart(0.1, 0.1, 0.2, 0.2)],
    [9, 'sendKey', (h) => h.sendKey(0x04, 0)],
    [10, 'pressButtonDown', (h) => h.pressButtonDown(0x0c, 0xe9)],
    [11, 'pressButtonUp', (h) => h.pressButtonUp(0x0c, 0xe9)],
  ]

  for (const [type, name, call] of selfContained) {
    it(`type ${type} (${name}) resurrects the helper`, async () => {
      const { helper, spawn } = await deadWithBudget()

      expect(call(helper)).toBe(false) // spawned, not usable yet — and it says so
      expect(spawn).toHaveBeenCalledTimes(1)
    })
  }
})

describe('minimum contact', () => {
  afterEach(() => { vi.useRealTimers() })

  // The frame types written so far: 1 down, 2 move, 3 up.
  const types = (proc: FakeProc) => proc.stdin.write.mock.calls.map((c) => (c[0] as Buffer)[0])

  it('holds back the up of a touch shorter than MIN_CONTACT_MS, then writes it', async () => {
    const { helper, proc } = await setupHelper()
    const { MIN_CONTACT_MS } = await import('../TouchHelper.js')
    vi.useFakeTimers()
    helper.touchStart(0.5, 0.5)
    const ended = helper.touchEndAfterMinContact()
    await vi.advanceTimersByTimeAsync(MIN_CONTACT_MS - 1)
    expect(types(proc)).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(types(proc)).toEqual([1, 3])
    await expect(ended).resolves.toBe(true)
  })

  it('writes the up at once when the touch already lasted long enough', async () => {
    const { helper, proc } = await setupHelper()
    const { MIN_CONTACT_MS } = await import('../TouchHelper.js')
    vi.useFakeTimers()
    helper.touchStart(0.5, 0.5)
    await vi.advanceTimersByTimeAsync(MIN_CONTACT_MS)
    const ended = helper.touchEndAfterMinContact()
    expect(types(proc)).toEqual([1, 3])
    await expect(ended).resolves.toBe(true)
  })

  it('writes a held-back up before the next touch goes down', async () => {
    const { helper, proc } = await setupHelper()
    vi.useFakeTimers()
    helper.touchStart(0.2, 0.2)
    const first = helper.touchEndAfterMinContact()
    helper.touchStart(0.8, 0.8)
    expect(types(proc)).toEqual([1, 3, 1])
    await expect(first).resolves.toBe(true)
    // and the timer it was waiting on writes nothing more
    await vi.advanceTimersByTimeAsync(1000)
    expect(types(proc)).toEqual([1, 3, 1])
  })

  it('writes a held-back up with its own touch\'s position, not the next one\'s', async () => {
    const { helper, proc } = await setupHelper()
    vi.useFakeTimers()
    helper.touchStart(0.2, 0.3)
    void helper.touchEndAfterMinContact()
    helper.touchStart(0.8, 0.9)
    const up = proc.stdin.write.mock.calls.map((c) => c[0] as Buffer).find((b) => b[0] === 3)!
    expect([up.readFloatBE(1), up.readFloatBE(5)].map((v) => Math.round(v * 10) / 10)).toEqual([0.2, 0.3])
  })

  it('writes a held-back up before a pinch opens', async () => {
    const { helper, proc } = await setupHelper()
    vi.useFakeTimers()
    helper.touchStart(0.2, 0.2)
    const first = helper.touchEndAfterMinContact()
    helper.pinchStart(0.4, 0.4, 0.6, 0.6)
    expect(types(proc)).toEqual([1, 3, 6])
    await expect(first).resolves.toBe(true)
  })

  it('answers a held-back up as not sent when the helper stops, and writes nothing', async () => {
    const { helper, proc } = await setupHelper()
    vi.useFakeTimers()
    helper.touchStart(0.5, 0.5)
    const ended = helper.touchEndAfterMinContact()
    helper.stop()
    await expect(ended).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(types(proc)).toEqual([1])
  })
})
