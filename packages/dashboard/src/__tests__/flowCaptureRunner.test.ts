import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RawStep } from '@tapflowio/flow-runner/browser'

// Flow Capture's replay (#1125): the order the device is put back in before the first step, and the pause on
// recording that every step is held to. The engine's own matching is flow-runner's and tested there; here it only
// has to be called, so it is stubbed to say what it was called with.
const log: string[] = []
// What the screen reads as before each step: one test puts a field on it.
const screen: { elements: unknown[] } = { elements: [] }
// One test has the device refuse what is replayed.
const replay = { refuse: false }
vi.mock('@tapflowio/flow-runner/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tapflowio/flow-runner/browser')>()),
  rangeStartOrientation: () => 'landscape',
  waitForStableScreen: async () => ({ elements: screen.elements }),
  replayStep: async (_c: unknown, _s: string, raw: RawStep) => {
    if (replay.refuse) throw new Error('channel-unavailable')
    log.push(`replay ${raw.kind}`)
  },
  matchStep: (raw: RawStep) => ({ raw, step: null }),
  // The engine as far as the keyboard is concerned: a tap, then typing and a key, through the driver it was given.
  runFlow: async (_flow: unknown, driver: { tap: (x: number, y: number) => Promise<void>; inputText: (t: string) => Promise<void>; pressKey: (c: string) => Promise<void> }) => {
    await driver.tap(0.5, 0.5)
    await driver.inputText('안녕')
    await driver.pressKey('ImeAction')
    return { status: 'passed' }
  },
}))

const { keyboardOf, matchRange, PauseLease, typedOnScreenKeyboard, verifyFlow } = await import('@/lib/flowCapture/runner')
type Tap = ConstructorParameters<typeof PauseLease>[0]
type Channel = Parameters<typeof matchRange>[1]

const tap = {
  sessionId: 's1', platform: 'ios', buildId: 7, postures: () => ({ postures: [] }),
} as unknown as Tap

// What the device answers a keyboard-set with, in order; the last is repeated.
let keyboardAnswers: string[] = ['done']
const channel = {
  clearState: async (_s: string, bundleId: string) => { log.push(`clearState ${bundleId}`) },
  setKeyboard: async (_s: string, keyboard?: string) => {
    log.push(`keyboard ${keyboard ?? 'first'}`)
    return keyboardAnswers.length > 1 ? keyboardAnswers.shift() : keyboardAnswers[0]
  },
  setOrientation: async (_s: string, o: string) => { log.push(`orientation ${o}`) },
  launchApp: async () => { log.push('launch') },
  queryUITreeWithTurn: async () => ({ elements: [] }),
  tap: async () => { log.push('tap') },
  typeText: async () => { log.push('type') },
  pressKey: async (_s: string, code: string) => { log.push(`key ${code}`) },
  screenshot: async () => { throw new Error('no screenshot here') },
  chrome: async () => null,
} as unknown as Channel

const base = { at: 0, endAt: 0, outcome: 'done' }
const tapStep = { ...base, kind: 'tap', point: { x: 0.5, y: 0.5 } } as unknown as RawStep
const launchStep = { ...base, kind: 'launch', buildId: 7 } as unknown as RawStep
const installStep = { ...base, kind: 'install', buildId: 7 } as unknown as RawStep
const textStep = { ...base, kind: 'text', text: '안녕', replace: true } as unknown as RawStep

let pauseOk = true
beforeEach(() => {
  log.length = 0
  screen.elements = []
  replay.refuse = false
  pauseOk = true
  keyboardAnswers = ['done']
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/pause') && init?.method === 'PUT') {
      log.push('pause')
      return pauseOk ? new Response(JSON.stringify({ ttlMs: 30_000 })) : new Response('', { status: 404 })
    }
    return new Response('')
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const hooks = () => ({ onStep: vi.fn(), signal: new AbortController().signal })

describe('matchRange', () => {
  // #1135: the replay starts in the keyboard language the range was recorded in, before the app launches.
  it('sets the recorded keyboard before the launch', async () => {
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [tapStep], { start: 0, end: 1 }, 'com.example', hooks(), 'ko_KR@sw=Korean;hw=Automatic')
    await lease.stop()
    expect(log.slice(0, 5)).toEqual(['pause', 'clearState com.example', 'keyboard ko_KR@sw=Korean;hw=Automatic', 'orientation landscape', 'launch'])
  })

  // Android switches only a keyboard that is up: asked again before the first step that types, and no more once set.
  it('asks again before the first typing step while the keyboard was down, and stops once it is set', async () => {
    keyboardAnswers = ['keyboard-hidden', 'done']
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [tapStep, textStep, textStep], { start: 0, end: 3 }, null, hooks(), '한국어 (두벌식)')
    await lease.stop()
    expect(log.filter((l) => l.startsWith('keyboard') || l.startsWith('replay'))).toEqual([
      'keyboard 한국어 (두벌식)', 'replay tap', 'keyboard 한국어 (두벌식)', 'replay text', 'replay text',
    ])
  })

  // E2E of #1135: an inputText showed an empty field, because every picture was taken before its step.
  it('pictures a typing step after it and a tap before it', async () => {
    const shots: string[] = []
    const shooting = { ...channel, screenshot: async () => { shots.push(log.filter((l) => l.startsWith('replay')).join(',')); return new Uint8Array([1]) } } as unknown as Channel
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }))
    const lease = new PauseLease(tap)
    await matchRange(tap, shooting, lease, [tapStep, textStep], { start: 0, end: 2 }, null, hooks())
    await lease.stop()
    expect(shots).toEqual(['', 'replay tap,replay text'])
  })

  // Android E2E: the field was focused before the range began, and a fresh launch focuses nothing.
  it('taps the field typing went into first when nothing has focus, and the tap is a step', async () => {
    screen.elements = [{ identifier: 'form.email', role: 'input', frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 } }]
    const typed = { ...textStep, field: 'form.email' } as unknown as RawStep
    const onStep = vi.fn()
    const lease = new PauseLease(tap)
    const steps = await matchRange(tap, channel, lease, [typed], { start: 0, end: 1 }, null, { onStep, signal: new AbortController().signal })
    await lease.stop()
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay tap', 'replay text'])
    expect(steps.map((s) => s.raw.kind)).toEqual(['tap', 'text'])
    expect((steps[0]!.raw as { point: number[] }).point).toEqual([0.5, 0.225])
  })

  it('says to move the range when nothing has focus and the field cannot be found', async () => {
    const { copy } = await import('@/lib/flowCapture/copy')
    replay.refuse = true
    const lease = new PauseLease(tap)
    await expect(matchRange(tap, channel, lease, [{ ...textStep, field: 'form.email' } as unknown as RawStep], { start: 0, end: 1 }, null, hooks()))
      .rejects.toThrow(copy.typedBeforeRange)
    await lease.stop()
  })

  // Review: after typing a password, Android shows its last character for a moment; the picture is taken before.
  it('pictures a password before it is typed', async () => {
    const shots: string[] = []
    const shooting = { ...channel, screenshot: async () => { shots.push(log.filter((l) => l.startsWith('replay')).join(',')); return new Uint8Array([1]) } } as unknown as Channel
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }))
    const secret = { ...textStep, fieldRead: 'secure', askValue: true } as unknown as RawStep
    const lease = new PauseLease(tap)
    await matchRange(tap, shooting, lease, [secret], { start: 0, end: 1 }, null, hooks())
    await lease.stop()
    expect(shots).toEqual([''])
  })

  it('says where each step touches before it is replayed, for drawing on the device', async () => {
    const onTouch = vi.fn()
    const lease = new PauseLease(tap)
    const at = { ...base, kind: 'tap', point: [0.25, 0.75] } as unknown as RawStep
    await matchRange(tap, channel, lease, [at, textStep], { start: 0, end: 2 }, null, { ...hooks(), onTouch })
    await lease.stop()
    expect(onTouch.mock.calls).toEqual([[{ kind: 'tap', x: 0.25, y: 0.75 }]])
  })

  it('taps nothing first when a field already has focus', async () => {
    screen.elements = [{ identifier: 'form.email', role: 'input', focused: true, frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 } }]
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [{ ...textStep, field: 'form.email' } as unknown as RawStep], { start: 0, end: 1 }, null, hooks())
    await lease.stop()
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay text'])
  })

  it('aligns before a touch the reads could not place, which may be a key', async () => {
    keyboardAnswers = ['keyboard-hidden', 'done']
    const unsure = { ...tapStep, keyboard: 'unknown' } as unknown as RawStep
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [tapStep, unsure], { start: 0, end: 2 }, null, hooks(), '한국어 (두벌식)')
    await lease.stop()
    expect(log.filter((l) => l.startsWith('keyboard') || l.startsWith('replay'))).toEqual([
      'keyboard 한국어 (두벌식)', 'replay tap', 'keyboard 한국어 (두벌식)', 'replay tap',
    ])
  })

  it('stops asking after any answer but a keyboard that was down', async () => {
    keyboardAnswers = ['unsupported']
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [textStep, textStep], { start: 0, end: 2 }, null, hooks())
    await lease.stop()
    expect(log.filter((l) => l.startsWith('keyboard'))).toEqual(['keyboard first'])
  })

  it('pauses recording, clears the app, turns the device and launches it, then renews the pause before each step', async () => {
    const lease = new PauseLease(tap)
    const h = hooks()
    await matchRange(tap, channel, lease, [tapStep, tapStep], { start: 0, end: 2 }, 'com.example', h)
    await lease.stop()
    expect(log).toEqual([
      'pause', 'clearState com.example', 'keyboard first', 'orientation landscape', 'launch',
      'pause', 'replay tap', 'pause', 'replay tap',
    ])
    expect(h.onStep).toHaveBeenCalledTimes(2)
  })

  it('launches nothing for a range that starts with its own launch, and clears nothing with no bundle id', async () => {
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [launchStep, tapStep], { start: 0, end: 2 }, null, hooks())
    await lease.stop()
    expect(log).toEqual(['pause', 'keyboard first', 'orientation landscape', 'pause', 'replay launch', 'pause', 'replay tap'])
  })

  it('does not replay an install, which would uninstall the app it just launched, and still names it', async () => {
    const lease = new PauseLease(tap)
    const h = hooks()
    await matchRange(tap, channel, lease, [installStep, tapStep], { start: 0, end: 2 }, 'com.example', h)
    await lease.stop()
    expect(log).toEqual(['pause', 'clearState com.example', 'keyboard first', 'orientation landscape', 'launch', 'pause', 'replay tap'])
    expect(h.onStep.mock.calls.map(([s]) => s.raw.kind)).toEqual(['install', 'tap'])
  })

  it('replays nothing once stopped', async () => {
    const lease = new PauseLease(tap)
    const controller = new AbortController()
    controller.abort()
    await expect(matchRange(tap, channel, lease, [tapStep], { start: 0, end: 1 }, null, { onStep: vi.fn(), signal: controller.signal }))
      .rejects.toThrow()
    await lease.stop()
    expect(log).not.toContain('replay tap')
  })

  it('does not start when the relay will not pause the recording', async () => {
    pauseOk = false
    const lease = new PauseLease(tap)
    await expect(matchRange(tap, channel, lease, [tapStep], { start: 0, end: 1 }, 'com.example', hooks())).rejects.toThrow()
    await lease.stop()
    expect(log).toEqual(['pause'])
  })
})

describe('PauseLease.ensure', () => {
  it('rides out a failed renewal while the last one still holds, and refuses once it may have lapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const lease = new PauseLease(tap)
    await lease.start()
    pauseOk = false
    vi.setSystemTime(20_000)
    await expect(lease.ensure()).resolves.toBeUndefined()
    vi.setSystemTime(31_000)
    await expect(lease.ensure()).rejects.toThrow()
    await lease.stop()
  })
})

describe('PauseLease.stop', () => {
  // Review of #1141: closed while the first renewal was out, the lease still set its timer and paused recording
  // again for a dialog that was gone.
  it('stops for good when it lands while the first renewal is out, and gives the pause back after it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const order: string[] = []
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      order.push(`${init?.method} ${url.split('/').pop()}`)
      if (init?.method === 'PUT') return new Promise<Response>((r) => { answer = (res) => { order.push('PUT answered'); r(res) } })
      return Promise.resolve(new Response(''))
    }))
    const lease = new PauseLease(tap)
    const started = lease.start()
    const stopped = lease.stop()
    await Promise.resolve()
    answer(new Response(JSON.stringify({ ttlMs: 30_000 })))
    await expect(started).rejects.toThrow()
    await stopped
    // The release goes after the renewal it would otherwise race: the relay takes them in the order they arrive.
    expect(order).toEqual(['PUT pause', 'PUT answered', 'DELETE pause'])
    vi.advanceTimersByTime(60_000)
    lease.touch()
    await expect(lease.ensure()).rejects.toThrow()
    expect(order).toEqual(['PUT pause', 'PUT answered', 'DELETE pause'])
  })
})

describe('verifyFlow', () => {
  it('sets the recorded keyboard before the flow, and again before its first typing while the keyboard was down', async () => {
    keyboardAnswers = ['keyboard-hidden', 'done']
    const lease = new PauseLease(tap)
    const flow = { name: 'f', steps: [] }
    await verifyFlow(tap, channel, lease, flow, {}, () => {}, '한국어 (두벌식)')
    await lease.stop()
    expect(log.filter((l) => l !== 'pause')).toEqual(['keyboard 한국어 (두벌식)', 'tap', 'keyboard 한국어 (두벌식)', 'type', 'key ImeAction'])
  })

  it('says where the flow touches, for drawing on the device', async () => {
    const onTouch = vi.fn()
    const lease = new PauseLease(tap)
    await verifyFlow(tap, channel, lease, { name: 'f', steps: [] }, {}, () => {}, undefined, onTouch)
    await lease.stop()
    expect(onTouch.mock.calls).toEqual([[{ kind: 'tap', x: 0.5, y: 0.5 }]])
  })
})

describe('the keyboard a range was recorded in', () => {
  const at = (ms: number) => ({ ...base, at: ms, endAt: ms, kind: 'tap', point: [0.5, 0.5] }) as unknown as RawStep
  const read = (ms: number, language: string) => ({ at: ms, kind: 'field' as const, phase: 'value' as const, requestedAt: ms - 10, field: null, language })

  it('is the first one read from the range\'s start on, else the last before it', () => {
    const steps = [at(100), at(500)]
    const snapshot = { id: 'x', takenAt: 0, thinned: false, entries: [read(50, 'English (US) (QWERTY)'), read(600, '한국어 (두벌식)')] }
    expect(keyboardOf(snapshot, steps, { start: 1, end: 2 })).toBe('한국어 (두벌식)')
    expect(keyboardOf({ ...snapshot, entries: [read(50, 'English (US) (QWERTY)')] }, steps, { start: 1, end: 2 })).toBe('English (US) (QWERTY)')
    expect(keyboardOf({ ...snapshot, entries: [] }, steps, { start: 1, end: 2 })).toBeUndefined()
  })

  it('says the range was typed on the on-screen keyboard when a key on it, or a touch it could not place, is in it', () => {
    const key = { ...base, kind: 'keyboardKey', point: [0.5, 0.9] } as unknown as RawStep
    const unsure = { ...base, kind: 'tap', point: [0.5, 0.9], keyboard: 'unknown' } as unknown as RawStep
    expect(typedOnScreenKeyboard([tapStep, key], { start: 0, end: 2 })).toBe(true)
    expect(typedOnScreenKeyboard([tapStep, unsure], { start: 1, end: 2 })).toBe(true)
    expect(typedOnScreenKeyboard([key, tapStep], { start: 1, end: 2 })).toBe(false)
  })
})
