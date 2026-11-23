import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { landingOf, parseDispatch, parseLogTimestamp, pickDispatch, springBoardSurface, type Dispatch, type GestureSpan } from '../touchLanding.js'
import { DispatchLog, type DispatchLogDeps } from '../DispatchLog.js'

// Captured from `simctl spawn … log stream --style ndjson` on iOS 26.5 (spike 3): a tap in an app, then one on the home
// screen; the stream's header and a stderr line are in it as they arrived. The host's home directory is replaced.
const FIXTURE_265 = readFileSync(new URL('./fixtures/dispatch-log-ios26.5.ndjson', import.meta.url), 'utf8').split('\n')
// iOS 27.0 (Mac mini): a permission alert's Allow, a plain and a secure field with two keys each, Home, a home-screen tap,
// a pull from the status bar. The stream's exit line is in it too.
const FIXTURE_270 = readFileSync(new URL('./fixtures/dispatch-log-ios27.0.ndjson', import.meta.url), 'utf8').split('\n')

describe('parseLogTimestamp', () => {
  it('reads the stream\'s local time with microseconds and an offset with no colon', () => {
    expect(parseLogTimestamp('2026-11-24 01:43:55.268637+0900')).toBeCloseTo(Date.parse('2026-11-23T16:43:55.268Z') + 0.637, 6)
    expect(parseLogTimestamp('2026-11-24 01:43:55.268637-0500')).toBeCloseTo(Date.parse('2026-11-24T06:43:55.268Z') + 0.637, 6)
    expect(parseLogTimestamp('2026-11-24 01:43:55+00:00')).toBe(Date.parse('2026-11-24T01:43:55Z'))
  })

  it('refuses anything else rather than guessing', () => {
    expect(parseLogTimestamp('2026-11-24T01:43:55.2Z')).toBeNull()
    expect(parseLogTimestamp('')).toBeNull()
  })
})

describe('parseDispatch', () => {
  const parsed = FIXTURE_265.map(parseDispatch)

  it('reads every dispatch line of a real stream, and nothing else in it', () => {
    const lines = parsed.filter((d): d is Dispatch => d !== null)
    expect(lines).toHaveLength(8)
    expect(parsed.slice(0, 2)).toEqual([null, null]) // stderr, the stream's header
    expect(lines.map((d) => d.window)).toEqual([
      '_UISystemGestureWindow', 'UIWindow', 'UIWindow', '_UISystemGestureWindow',
      '_UISystemGestureWindow', 'SBHomeScreenWindow', '_UISystemGestureWindow', 'SBHomeScreenWindow',
    ])
    expect(lines[1]).toEqual({
      at: parseLogTimestamp('2026-11-24 01:43:55.270224+0900'),
      pid: 74201,
      image: '/Users/dev/Library/Developer/CoreSimulator/Devices/B26DA152-7AE1-49D4-AB91-0B45C33AD902/data/Containers/Bundle/Application/85F7ADBA-7AC8-4E2C-9DD2-54F1FCA0846C/SpikeApp.app/SpikeApp',
      window: 'UIWindow',
    })
    expect(lines[5]!.image).toMatch(/\/SpringBoard\.app\/SpringBoard$/)
  })

  it('reads iOS 27.0\'s lines the same way, and every touch there lands where 26.5\'s did', () => {
    const lines = FIXTURE_270.map(parseDispatch).filter((d): d is Dispatch => d !== null)
    expect(lines).toHaveLength(FIXTURE_270.filter((l) => l.startsWith('{')).length)
    const real = lines.filter((d) => d.window !== '_UISystemGestureWindow')
    const bundle = (image: string) => image.endsWith('/SpringBoard') ? 'com.apple.springboard' : 'dev.tapflow.spikeapp'
    const ctx = { target: 'dev.tapflow.spikeapp', away: false }
    const placed = [...new Set(real.map((d) => `${d.window}:${landingOf(bundle(d.image), d.window, ctx)?.on}`))]
    // The app's keyboard, a secure field's included, is the app's.
    expect(placed).toEqual(['SBAlertItemWindow:alert', 'UIWindow:app', 'UIRemoteKeyboardWindow:app', 'SBHomeScreenWindow:home', 'SBStatusBarWindow:system'])
  })

  it('drops a message it does not know, a line that is not JSON and one missing a field', () => {
    const base = JSON.parse(FIXTURE_265.find((l) => l.includes('SBHomeScreenWindow'))!) as Record<string, unknown>
    const line = (o: Record<string, unknown>) => JSON.stringify({ ...base, ...o })
    expect(parseDispatch(line({}))).not.toBeNull()
    expect(parseDispatch(line({ eventMessage: 'Sending UIEvent type: 1; subtype: 0; to window: <SBHomeScreenWindow: 0x1>; contextId: 0x2' }))).toBeNull()
    expect(parseDispatch(line({ eventMessage: 'Evaluating dispatch of UIEvent: 0x12998b200; type: 0' }))).toBeNull()
    expect(parseDispatch(line({ timestamp: 'yesterday' }))).toBeNull()
    expect(parseDispatch(line({ processID: undefined }))).toBeNull()
    expect(parseDispatch(line({ processImagePath: '' }))).toBeNull()
    expect(parseDispatch('{"eventMessage": "Sending')).toBeNull()
  })
})

describe('landingOf', () => {
  const APP = 'com.example.app'
  const here = { target: APP, away: false }
  const away = { target: APP, away: true }

  it('places the app\'s own touches in the app, whatever its window: its keyboard\'s keys, a secure field\'s, land there', () => {
    expect(landingOf(APP, 'UIWindow', here)).toEqual({ on: 'app' })
    expect(landingOf(APP, 'UIRemoteKeyboardWindow', here)).toEqual({ on: 'app' })
    expect(landingOf(APP, 'NSKVONotifying_UIWindow', away)).toEqual({ on: 'app' })
  })

  it('reads SpringBoard by its window, and leaves a window it does not know unplaced', () => {
    expect(landingOf('com.apple.springboard', 'SBHomeScreenWindow', here)).toEqual({ on: 'home' })
    for (const w of ['SBStatusBarWindow', 'SBMainSwitcherWindow', 'SBCoverSheetWindow', 'SBControlCenterWindow', 'SBBannerWindow']) {
      expect(landingOf('com.apple.springboard', w, here)).toEqual({ on: 'system' })
    }
    expect(landingOf('com.apple.springboard', 'SBAlertItemWindow', here)).toEqual({ on: 'alert' })
    expect(landingOf('com.apple.springboard', 'SBSomethingNewWindow', here)).toBeNull()
    expect(springBoardSurface('constructor')).toBeNull()
  })

  it('takes an alert over the home screen for a system surface: the app is not there to have raised it', () => {
    expect(landingOf('com.apple.springboard', 'SBAlertItemWindow', away)).toEqual({ on: 'system' })
  })

  it('gives SpringBoard\'s keyboard the surface of its field, only while the app is away', () => {
    const kb = 'UIRemoteKeyboardWindow'
    expect(landingOf('com.apple.springboard', kb, { ...away, previous: { on: 'home' } })).toEqual({ on: 'home' })
    expect(landingOf('com.apple.springboard', kb, { ...away, previous: { on: 'alert' } })).toEqual({ on: 'system' })
    // The app in front: whatever SpringBoard's keyboard is typing, it is not placed on the home screen.
    expect(landingOf('com.apple.springboard', kb, { ...here, previous: { on: 'home' } })).toBeNull()
    expect(landingOf('com.apple.springboard', kb, away)).toBeNull()
  })

  it('names Spotlight and any other app', () => {
    expect(landingOf('com.apple.Spotlight', 'SPUISecureWindow', here)).toEqual({ on: 'other', id: 'com.apple.Spotlight' })
    expect(landingOf('com.apple.Maps', 'EventSourceWindow', here)).toEqual({ on: 'other', id: 'com.apple.Maps' })
  })

  it('with no app under test known, places only SpringBoard and Spotlight: the app\'s own touch would read as another app\'s', () => {
    const none = { away: true }
    expect(landingOf(APP, 'UIWindow', none)).toBeNull()
    expect(landingOf('com.apple.springboard', 'SBHomeScreenWindow', none)).toEqual({ on: 'home' })
    expect(landingOf('com.apple.Spotlight', 'SPUISecureWindow', none)).toEqual({ on: 'other', id: 'com.apple.Spotlight' })
  })
})

describe('pickDispatch', () => {
  const at = (t: number, window = 'W', pid = 1): Dispatch => ({ at: t, pid, image: '/x', window })

  it('takes the earliest line at or after the down and before the next gesture\'s', () => {
    const spans: GestureSpan[] = [{ down: 1000, up: 1080 }, { down: 2000 }]
    const lines = [at(998, 'Before'), at(1010, 'Down'), at(1081, 'Lift'), at(2012, 'Next')]
    expect(pickDispatch(lines, spans, 0)).toEqual({ kind: 'found', line: lines[1] })
    expect(pickDispatch(lines, spans, 1)).toEqual({ kind: 'found', line: lines[3] })
  })

  it('takes a line 2 ms before the next down as this gesture\'s, and one at the next down as the next one\'s', () => {
    const spans: GestureSpan[] = [{ down: 1000, up: 1080, first: 1010 }, { down: 2000 }]
    expect(pickDispatch([at(1998, 'Mine')], spans, 0)).toMatchObject({ kind: 'found', line: { window: 'Mine' } })
    expect(pickDispatch([at(1998, 'Mine'), at(2000, 'Next')], spans, 1)).toMatchObject({ kind: 'found', line: { window: 'Next' } })
  })

  it('places nothing when the gesture before may still be delivering into this one: a lagging lift would take it', () => {
    // A swipe on the home screen whose log trails by 600 ms, then an app tap 300 ms after its lift.
    const spans: GestureSpan[] = [{ down: 1000, up: 1400 }, { down: 1700 }]
    const lines = [at(1600, 'SBHomeScreenWindow'), at(2000, 'SBHomeScreenWindow'), at(2310, 'UIWindow')]
    expect(pickDispatch(lines, spans, 1)).toEqual({ kind: 'refused' })
    // The same gap with a log 30 ms behind: the swipe's lines were all in before the tap.
    const quick = [at(1030, 'SBHomeScreenWindow'), at(1430, 'SBHomeScreenWindow'), at(1710, 'UIWindow')]
    expect(pickDispatch(quick, spans, 1)).toMatchObject({ kind: 'found', line: { window: 'UIWindow' } })
  })

  it('takes an unknown lag for a long one while the gap is short, and not once the longest lag has passed', () => {
    expect(pickDispatch([at(1710, 'UIWindow')], [{ down: 1000, up: 1080 }, { down: 1700 }], 1)).toEqual({ kind: 'refused' })
    expect(pickDispatch([at(9010, 'UIWindow')], [{ down: 1000, up: 1080 }, { down: 9000 }], 1)).toMatchObject({ kind: 'found' })
    // No up recorded yet for the one before (a pinch still open, say): no gap is known either.
    expect(pickDispatch([at(1030), at(9010)], [{ down: 1000 }, { down: 9000 }], 1)).toEqual({ kind: 'refused' })
  })

  it('finds nothing with no line in the window', () => {
    expect(pickDispatch([at(500)], [{ down: 1000 }], 0)).toEqual({ kind: 'none' })
    expect(pickDispatch([], [], 0)).toEqual({ kind: 'none' })
  })
})

describe('DispatchLog', () => {
  const FIX_LINES = FIXTURE_265.filter((l) => l.startsWith('{') || l.startsWith('Filtering'))

  function fakeProc(): ChildProcess & { stdout: PassThrough } {
    const p = new EventEmitter() as ChildProcess & { stdout: PassThrough }
    Object.assign(p, { stdout: new PassThrough(), kill: vi.fn(() => { p.emit('exit', null, 'SIGTERM'); return true }) })
    return p
  }

  function deps(over: Partial<DispatchLogDeps> = {}) {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    let now = parseLogTimestamp('2026-11-24 01:43:56.000000+0900')!
    const d: DispatchLogDeps = {
      spawn: vi.fn(() => { const p = fakeProc(); procs.push(p); return p }),
      bundleOf: vi.fn(async (image: string) => image.endsWith('/SpringBoard') ? 'com.apple.springboard' : 'dev.tapflow.spikeapp'),
      findOrphans: vi.fn(async () => []),
      killPid: vi.fn(),
      now: () => now,
      ...over,
    }
    return { d, procs, advance: (ms: number) => { now += ms } }
  }

  it('keeps the lines a real stream delivers, cut anywhere, in time order and without the system-gesture layer', async () => {
    const { d, procs } = deps()
    const log = new DispatchLog('U', d)
    await log.start()
    expect(log.attached).toBe(false)
    const text = FIX_LINES.join('\n') + '\n'
    for (let k = 0; k < text.length; k += 333) procs[0]!.stdout.write(text.slice(k, k + 333))
    await new Promise((r) => setImmediate(r))
    expect(log.attached).toBe(true)
    expect(log.lines().map((l) => l.window)).toEqual(['UIWindow', 'UIWindow', 'SBHomeScreenWindow', 'SBHomeScreenWindow'])
    expect(await log.bundleOf(log.lines()[2]!.image)).toBe('com.apple.springboard')
    await log.bundleOf(log.lines()[3]!.image)
    expect(d.bundleOf).toHaveBeenCalledTimes(1)
    log.stop()
  })

  it('clears what an earlier agent left for the device before it starts', async () => {
    const { d } = deps({ findOrphans: vi.fn(async () => [41, 42]) })
    const log = new DispatchLog('U', d)
    await log.start()
    expect(d.killPid).toHaveBeenCalledWith(41)
    expect(d.killPid).toHaveBeenCalledWith(42)
    expect(d.findOrphans).toHaveBeenCalledWith('U')
    expect(d.spawn).toHaveBeenCalledTimes(1)
    log.stop()
  })

  it('starts nothing when stopped while it was clearing', async () => {
    const { d } = deps()
    const log = new DispatchLog('U', d)
    const started = log.start()
    log.stop()
    await started
    expect(d.spawn).not.toHaveBeenCalled()
  })

  it('starts a stream that died again, at most three times in 30 s, and never once stopped', async () => {
    const { d, procs, advance } = deps()
    const log = new DispatchLog('U', d)
    await log.start()
    procs[0]!.emit('exit', 1, null)
    procs[1]!.emit('exit', 1, null)
    procs[2]!.emit('exit', 1, null)
    expect(d.spawn).toHaveBeenCalledTimes(3)
    expect(log.running).toBe(false)
    advance(30_000)
    await log.start()
    expect(d.spawn).toHaveBeenCalledTimes(4)
    log.stop()
    expect(procs[3]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(d.spawn).toHaveBeenCalledTimes(4)
    expect(log.running).toBe(false)
  })

  it('lets lines go once they are older than any gesture can wait for', async () => {
    const { d, procs, advance } = deps()
    const log = new DispatchLog('U', d)
    await log.start()
    procs[0]!.stdout.write(FIX_LINES.join('\n') + '\n')
    await new Promise((r) => setImmediate(r))
    expect(log.lines()).toHaveLength(4)
    advance(15_000)
    procs[0]!.stdout.write('\n')
    await new Promise((r) => setImmediate(r))
    expect(log.lines()).toHaveLength(0)
    log.stop()
  })
})
