import type { CaptureTouched } from '@tapflowio/protocol'
import { describe, expect, it, vi } from 'vitest'
import { TouchWatch } from '../TouchWatch.js'

const APP = 'dev.tapflow.sample.compose'
const MS = 1_000_000
/** The device's clock runs this far ahead of the host's (ns). */
const OFFSET = 5_000_000 * MS

const HEADER = 'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,FrameCompleted'
const framestats = (pid: number, completedHostMs: number[]) =>
  `** Graphics info for pid ${pid} [${APP}] **\n\n---PROFILEDATA---\n${HEADER}\n`
  + completedHostMs.map((t) => `0,0,${t * MS + OFFSET - 20 * MS},0,${t * MS + OFFSET}`).join('\n') + '\n---PROFILEDATA---\n'

interface Answer { pkg?: string; type?: number; branch?: unknown[]; readAfterMs?: number; none?: boolean }

/**
 * A watch on a fake clock: `hit` answers as the jar would, its branch read `readAfterMs` after the request (on the
 * device's clock); `sleep` moves the clock. `frames` is what the app drew, in host ms.
 */
function rig(opts: { answers?: Answer[]; frames?: number[] | (() => number[]); pid?: () => number; pkg?: string | undefined; pkgNow?: () => string | undefined } = {}) {
  let now = 1_000
  const sent: CaptureTouched[] = []
  const holds: boolean[] = []
  const answers = [...(opts.answers ?? [])]
  const deps = {
    now: () => now,
    sleep: async (ms: number) => { now += ms },
    hit: vi.fn(async () => {
      const a = answers.shift() ?? {}
      if (a.none) return null
      const rx = now * MS + OFFSET
      return {
        writtenAt: now,
        answer: JSON.stringify({
          rx, done: rx + (a.readAfterMs ?? 14) * MS, w: 1000, h: 2000, type: a.type ?? 1, pkg: a.pkg ?? APP, under: APP,
          branch: a.branch ?? [{ c: 'android.widget.Button', id: 'form.submit', t: 'Submit', k: 1, b: [100, 200, 300, 400] }],
        }),
      }
    }),
    framestats: vi.fn(async () => framestats(opts.pid?.() ?? 4495, typeof opts.frames === 'function' ? opts.frames() : opts.frames ?? [])),
    ping: vi.fn(async () => {}),
    hold: vi.fn(async (_serial: string, on: boolean) => { holds.push(on) }),
    send: (m: CaptureTouched) => { sent.push(m) },
  }
  const pkg = 'pkg' in opts ? opts.pkg : APP
  const watch = new TouchWatch(deps, 'emulator-5554', opts.pkgNow ?? (() => pkg))
  const tap = (x: number, y: number, holdMs = 100, id = `rq-${sent.length}-${now}`) => {
    watch.down(x, y, { x, y })
    now += holdMs
    watch.up('s1', id)
    return id
  }
  const advance = (ms: number) => { now += ms }
  return { watch, sent, holds, deps, tap, advance, clock: () => now }
}

describe('TouchWatch', () => {
  it('holds the connection while it lives and lets go when stopped', () => {
    const { watch, holds } = rig()
    watch.stop()
    expect(holds).toEqual([true, false])
  })

  it('reports a tap on the app: what it hit, its count and seq, and that the app drew after it', async () => {
    const { watch, sent, tap, clock } = rig({ frames: [1_200, 1_250, 1_300] })
    tap(0.2, 0.15)
    await watch.settled()
    expect(sent).toEqual([{
      type: 'capture:touched', sessionId: 's1', requestId: expect.any(String),
      observation: {
        point: { x: 0.2, y: 0.15 }, moving: false, tapCount: 1, seq: 1, acted: true,
        element: { identifier: 'form.submit', label: 'Submit', traits: 1, frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
        button: { identifier: 'form.submit', label: 'Submit', traits: 1, frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
      },
    }])
    // Read once the app had its 0.8 s after the lift.
    expect(clock()).toBeGreaterThanOrEqual(1_000 + 100 + 800)
  })

  it('reports nothing for a hit read after the up: the screen may already be the one the tap made', async () => {
    const { watch, sent, tap } = rig({ answers: [{ readAfterMs: 120 }] })
    tap(0.2, 0.15, 100)
    await watch.settled()
    expect(sent).toEqual([])
  })

  it('takes a hit read during a long press, until a long press could fire', async () => {
    const { watch, sent, tap } = rig({ answers: [{ readAfterMs: 300 }, { readAfterMs: 450 }] })
    tap(0.2, 0.15, 600)
    tap(0.6, 0.6, 600)
    await watch.settled()
    expect(sent).toHaveLength(1)
  })

  it('reports nothing for another app, no answer, or no app under test', async () => {
    const a = rig({ answers: [{ pkg: 'com.google.android.apps.nexuslauncher' }, { none: true }] })
    a.tap(0.5, 0.5)
    a.tap(0.5, 0.5)
    await a.watch.settled()
    expect(a.sent).toEqual([])
    const b = rig({ pkg: undefined })
    b.tap(0.5, 0.5)
    await b.watch.settled()
    expect(b.sent).toEqual([])
  })

  it('counts a quick repeat at one spot as iOS does, and not a tap elsewhere or later', async () => {
    const { watch, sent, tap, advance } = rig()
    tap(0.5, 0.5, 60)
    advance(150)
    tap(0.52, 0.5, 60)
    advance(150)
    tap(0.9, 0.9, 60)
    advance(500)
    tap(0.9, 0.9, 60)
    await watch.settled()
    expect(sent.map((m) => m.observation.tapCount)).toEqual([1, 2, 1, 1])
  })

  it('numbers touches in the app\'s process, from 1 again in a new one', async () => {
    let pid = 100
    // Each process drew before the downs: it was there for them.
    const { watch, sent, tap, advance } = rig({ pid: () => pid, frames: [500] })
    tap(0.5, 0.5)
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    pid = 200
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, 2, 1])
  })

  it('a swipe gets no count and no verdict, and the tap after it on a gliding list reads moving', async () => {
    const glide = Array.from({ length: 30 }, (_, i) => 1_200 + i * 16)
    const { watch, sent, advance } = rig({ answers: [{}, { branch: [{ c: 'android.widget.TextView', t: 'Row 8', b: [0, 0, 10, 10] }, { c: 'androidx.recyclerview.widget.RecyclerView', k: 16, b: [0, 0, 10, 10] }] }], frames: glide })
    watch.down(0.5, 0.8, { x: 0.5, y: 0.8 })
    advance(50)
    watch.move(0.5, 0.5)
    advance(50)
    watch.up('s1', 'swipe')
    advance(500)
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    advance(80)
    watch.up('s1', 'tap')
    await watch.settled()
    expect(sent[0]!.observation).not.toHaveProperty('tapCount')
    expect(sent[0]!.observation).not.toHaveProperty('acted')
    expect(sent[1]!.observation).toMatchObject({ moving: true, element: { label: 'Row 8' } })
    expect(sent[1]!.observation).not.toHaveProperty('acted')
  })

  // Review of P4: a slow drag (a pull to refresh) leaves a spinner drawing every vsync, not a list gliding.
  it('reads a tap after a slow drag as not moving', async () => {
    // Drawing right up to the tap and stopping there, as a gliding list would: only the slow release tells them apart.
    const drawing = Array.from({ length: 94 }, (_, i) => 1_000 + i * 16)
    const scrolling = [{ c: 'android.widget.TextView', t: 'Row 8', b: [0, 0, 10, 10] }, { c: 'androidx.recyclerview.widget.RecyclerView', k: 16, b: [0, 0, 10, 10] }]
    const { watch, sent, advance } = rig({ answers: [{}, { branch: scrolling }], frames: drawing })
    watch.down(0.5, 0.3, { x: 0.5, y: 0.3 })
    // Slower at the lift than Android flings (50 dp/s, 0.12 of the screen a second): 0.08 over its last moves.
    for (let i = 1; i <= 10; i++) { advance(100); watch.move(0.5, i < 10 ? 0.3 + i * 0.02 : 0.496) }
    advance(100)
    watch.up('s1', 'pull')
    advance(400)
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    advance(80)
    watch.up('s1', 'tap')
    await watch.settled()
    expect(sent[1]!.observation).toMatchObject({ moving: false, element: { label: 'Row 8' } })
  })

  // Review of P4: iOS counts every touch-down; a first tap in the app that went unreported must not leave the second
  // reading as the first, which says it opened the app.
  it('leaves seq out for the rest of a process once a touch in it may have gone uncounted', async () => {
    let pid = 100
    const { watch, sent, tap, advance } = rig({ pid: () => pid, answers: [{}, { readAfterMs: 500 }, {}, {}], frames: [500] })
    tap(0.5, 0.5)
    advance(1_000)
    tap(0.5, 0.5)
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    pid = 200
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, undefined, 1])
  })

  it('leaves seq out in a new process when the touch before it went unreported', async () => {
    const { watch, sent, tap, advance } = rig({ pid: () => 300, answers: [{ readAfterMs: 500 }, {}] })
    tap(0.5, 0.5)
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.observation).not.toHaveProperty('seq')
  })

  // Review of P4: the frames take up to 3 s to read, and a reboot in that time stops the watch.
  it('sends nothing for a touch whose frames came back after the watch stopped', async () => {
    const { watch, sent, tap, deps } = rig()
    deps.framestats.mockImplementation(async () => { watch.stop(); return '' })
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent).toEqual([])
  })

  // CodeRabbit on #1187: a report waits behind the one before it, and a launch in that time is not the touch's app.
  it('judges a touch by the app it went down in, not one launched while its report waited', async () => {
    let pkgNow: string = APP
    const { watch, sent, deps, advance } = rig({ pkgNow: () => pkgNow })
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    pkgNow = 'com.other.app'
    advance(100)
    watch.up('s1', 'rq')
    await watch.settled()
    expect(sent).toHaveLength(1)
    expect(deps.framestats).toHaveBeenCalledWith('emulator-5554', APP)
  })

  // CodeRabbit on #1187: the app saw a cancelled gesture's down, which iOS counts.
  it('leaves seq out after a cancelled gesture, as one the app saw and nobody reported', async () => {
    const { watch, sent, tap, advance } = rig()
    tap(0.5, 0.5)
    advance(1_000)
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    watch.cancel()
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, undefined])
  })

  // CodeRabbit on #1187: the app restarted between the down and the frames read.
  it('gives no count and no verdict to a touch whose frames belong to a process started after it', async () => {
    let pid = 100
    let drawn: number[] = [900]
    const { watch, sent, tap, advance, clock } = rig({ pid: () => pid, frames: () => drawn })
    tap(0.5, 0.5)
    await watch.settled()
    advance(1_000)
    pid = 200
    // Drawn only after the down, as the new process's first frames: read as this tap's, they would say it acted.
    drawn = [clock() + 50, clock() + 70, clock() + 90]
    const at = tap(0.5, 0.5)
    await watch.settled()
    expect(at).toBeDefined()
    expect(sent[1]!.observation).not.toHaveProperty('seq')
    expect(sent[1]!.observation).not.toHaveProperty('acted')
    // The new process's own first touch is still its first.
    // Drawn before its next down: the process was there for it.
    advance(1_000)
    drawn = [clock() - 300]
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent[2]!.observation.seq).toBe(1)
  })

  // Review of #1187: a new process that has drawn nothing has not shown the screen this touch was on.
  it('counts no touch for a new process that has drawn nothing yet', async () => {
    let pid = 100
    let drawn: number[] = [500]
    const { watch, sent, tap, advance } = rig({ pid: () => pid, frames: () => drawn })
    tap(0.5, 0.5)
    await watch.settled()
    pid = 200
    drawn = []
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    drawn = [500]
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, undefined, 1])
  })

  // Review of #1187: a full ring's oldest frame is not the process's first, so a new pid there cannot be placed.
  it('loses the count when a new process\'s ring is too full to say whether it was there for the touch', async () => {
    let pid = 100
    let drawn: number[] = [500]
    const { watch, sent, tap, advance, clock } = rig({ pid: () => pid, frames: () => drawn })
    tap(0.5, 0.5)
    await watch.settled()
    pid = 200
    advance(1_000)
    drawn = Array.from({ length: 120 }, (_, i) => clock() + 20 + i * 8)
    tap(0.5, 0.5)
    await watch.settled()
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, undefined, undefined])
  })

  // Review of #1187: a gesture cancelled on the launcher is no touch the app saw.
  it('keeps the count across a gesture cancelled outside the app', async () => {
    const { watch, sent, tap, advance } = rig({ answers: [{}, { pkg: 'com.google.android.apps.nexuslauncher' }, {}], frames: [500] })
    tap(0.5, 0.5)
    advance(1_000)
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    watch.cancel()
    advance(1_000)
    tap(0.5, 0.5)
    await watch.settled()
    expect(sent.map((m) => m.observation.seq)).toEqual([1, 2])
  })

  it('reports nothing for a cancelled gesture, or once stopped', async () => {
    const { watch, sent, tap } = rig()
    watch.down(0.5, 0.5, { x: 0.5, y: 0.5 })
    watch.cancel()
    watch.up('s1', 'after-cancel')
    tap(0.5, 0.5)
    watch.stop()
    await watch.settled()
    expect(sent).toEqual([])
  })
})
