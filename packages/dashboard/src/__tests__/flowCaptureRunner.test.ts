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
// What each step was matched with: one test reads the device's reach answers off it.
const matchedWith: unknown[] = []
// Settle reads and replays in the order they happened: one test needs reads it does not log above.
const seq: string[] = []
// The options the engine was last run with, the flows it was given, and what it answers next (else a pass).
const ran: { options?: { observeEffects?: boolean }; flows: Array<{ steps: unknown[] }>; answers: Array<{ status: string; failureKind?: string; failureMessage?: string }>; beforeRun?: () => void; probe?: Record<string, string> } = { flows: [], answers: [] }
vi.mock('@tapflowio/flow-runner/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tapflowio/flow-runner/browser')>()),
  rangeStartOrientation: () => 'landscape',
  waitForStableScreen: async () => { seq.push('settle'); return { elements: screen.elements } },
  replayStep: async (_c: unknown, _s: string, raw: RawStep) => {
    if (replay.refuse) throw new Error('channel-unavailable')
    log.push(`replay ${raw.kind}`)
    seq.push(`replay ${raw.kind}`)
  },
  matchStep: (raw: RawStep, ctx: unknown) => { matchedWith.push(ctx); return { raw, step: null } },
  // The engine as far as the keyboard is concerned: a tap, then typing and a key, through the driver it was given.
  runFlow: async (_flow: unknown, driver: { tap: (x: number, y: number) => Promise<void>; inputText: (t: string) => Promise<void>; pressKey: (c: string) => Promise<void> }, options?: { observeEffects?: boolean }) => {
    ran.options = options
    ran.flows.push(_flow as { steps: unknown[] })
    ran.beforeRun?.()
    if (ran.probe) {
      const d = driver as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      const calls: Array<[string, unknown[]]> = [['queryUITree', []], ['reach', [[]]], ['swipe', [[0.5, 0.7], [0.5, 0.3], 300]], ['tap', [0.5, 0.5]], ['screenshot', []]]
      for (const [m, args] of calls) ran.probe[m] = await Promise.resolve().then(() => d[m]!(...args)).then(() => 'sent', (e: unknown) => ((e as Error).name === 'AbortError' ? 'stopped' : 'sent'))
    }
    const answer = ran.answers.shift()
    if (answer) return answer
    await driver.tap(0.5, 0.5)
    await driver.inputText('안녕')
    await driver.pressKey('ImeAction')
    return { status: 'passed' }
  },
}))

const { DialogRun, keyboardOf, loadSnapshot: loadSnapshotForTest, matchRange, PauseLease, typedOnScreenKeyboard, verifyFlow } = await import('@/lib/flowCapture/runner')
type Tap = ConstructorParameters<typeof PauseLease>[0]
type Channel = Parameters<typeof matchRange>[1]

const tap = {
  sessionId: 's1', platform: 'ios', buildId: 7, postures: () => ({ postures: [] }),
} as unknown as Tap

// What the device answers a keyboard-set with, in order; the last is repeated.
let keyboardAnswers: string[] = ['done']
// What the device answers a run reset with (#1139): a report, or `undefined` from an agent that cannot do it.
let resetAnswer: { done: string[]; failed: string[] } | undefined = { done: ['keychain'], failed: [] }
const channel = {
  runReset: async (_s: string, apps: string[]) => { log.push(`reset ${apps.join(' ')}`.trimEnd()); return resetAnswer },
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
  screenshot: async () => { if (trackShots.on) seq.push('shot'); throw new Error('no screenshot here') },
  chrome: async () => null,
  reach: async (_s: string, targets: { label: string }[]) => {
    log.push(`reach ${targets.map((t) => t.label).join(',')}`)
    if (reachAnswer === 'fail') throw new Error('relay 502')
    return targets.map(() => ({ state: 'occluded', by: 'Tab Bar' }))
  },
} as unknown as Channel
let reachAnswer: 'occluded' | 'fail' = 'occluded'

const base = { at: 0, endAt: 0, outcome: 'done' }
const tapStep = { ...base, kind: 'tap', point: [0.5, 0.5] } as unknown as RawStep
const launchStep = { ...base, kind: 'launch', buildId: 7 } as unknown as RawStep
const installStep = { ...base, kind: 'install', buildId: 7 } as unknown as RawStep
const textStep = { ...base, kind: 'text', text: '안녕', replace: true } as unknown as RawStep

let pauseOk = true
// One test reads where the pictures were taken among the reads and replays.
const trackShots = { on: false }
beforeEach(() => {
  log.length = 0
  seq.length = 0
  screen.elements = []
  replay.refuse = false
  pauseOk = true
  keyboardAnswers = ['done']
  resetAnswer = { done: ['keychain'], failed: [] }
  matchedWith.length = 0
  reachAnswer = 'occluded'
  ran.flows = []
  ran.answers = []
  ran.beforeRun = undefined
  ran.probe = undefined
  trackShots.on = false
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
    expect(log.slice(0, 5)).toEqual(['pause', 'reset com.example', 'keyboard ko_KR@sw=Korean;hw=Automatic', 'orientation landscape', 'launch'])
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
    // The range was held sideways (the mocked start), so its turn leads.
    expect(steps.map((s) => s.raw.kind)).toEqual(['rotate', 'tap', 'text'])
    expect((steps[1]!.raw as { point: number[] }).point).toEqual([0.5, 0.225])
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

  // #1125: the tree cannot say what covers an element on the device, so the device is asked about the screen the step is
  // about to act on — before it is replayed, which changes that screen.
  it('asks the device where a touch on the tapped element lands, before replaying it, and matches with the answer', async () => {
    screen.elements = [{ role: 'cell', label: 'Row 13', enabled: true, frame: { x: 0, y: 0.86, width: 1, height: 0.06 } }]
    const at = { ...base, kind: 'tap', point: [0.5, 0.88] } as unknown as RawStep
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [launchStep, at], { start: 0, end: 2 }, null, hooks())
    await lease.stop()
    expect(log.filter((l) => l.startsWith('reach') || l.startsWith('replay'))).toEqual(['replay launch', 'reach Row 13', 'replay tap'])
    expect(matchedWith.at(-1)).toMatchObject({ reach: [{ state: 'occluded', by: 'Tab Bar' }] })
  })

  // Research for #1125: Match watches each touch too, from the screen before it to the next read, for Export to keep
  // only what Verify saw as well.
  it('says what each touch did, from the screen before it to the one read after', async () => {
    const row = { role: 'cell', label: 'Row 13', enabled: true, frame: { x: 0, y: 0.5, width: 1, height: 0.06 } }
    const saved = { role: 'text', label: 'Saved', enabled: true, frame: { x: 0, y: 0.1, width: 1, height: 0.04 } }
    screen.elements = [row]
    const at = { ...base, kind: 'tap', point: [0.5, 0.52] } as unknown as RawStep
    const lease = new PauseLease(tap)
    const matched = await matchRange(tap, channel, lease, [launchStep, at], { start: 0, end: 2 }, null, {
      ...hooks(),
      onStep: (step: { raw: RawStep }) => { if (step.raw === at) screen.elements = [row, saved] },
    })
    await lease.stop()
    expect(matched.at(-1)).toMatchObject({ observed: { appear: [{ text: 'Saved', role: 'text' }] } })
    expect(matched[0]).not.toHaveProperty('observed')
  })

  it('closes one touch\'s watch on the screen read before the next step', async () => {
    const row = { role: 'cell', label: 'Row 13', enabled: true, frame: { x: 0, y: 0.5, width: 1, height: 0.06 } }
    const saved = { role: 'text', label: 'Saved', enabled: true, frame: { x: 0, y: 0.1, width: 1, height: 0.04 } }
    screen.elements = [row]
    const first = { ...base, kind: 'tap', point: [0.5, 0.52] } as unknown as RawStep
    const second = { ...base, kind: 'tap', point: [0.5, 0.53] } as unknown as RawStep
    const shared = { role: 'text', label: 'Shared', enabled: true, frame: { x: 0, y: 0.2, width: 1, height: 0.04 } }
    const lease = new PauseLease(tap)
    const matched = await matchRange(tap, channel, lease, [launchStep, first, second], { start: 0, end: 3 }, null, {
      ...hooks(),
      // The first tap brings "Saved", the second "Shared".
      onStep: (step: { raw: RawStep }) => { screen.elements = step.raw === first ? [row, saved] : step.raw === second ? [row, saved, shared] : screen.elements },
    })
    await lease.stop()
    const observedOf = (raw: RawStep) => matched.find((m) => m.raw === raw)?.observed
    expect(observedOf(first)).toEqual({ appear: [{ text: 'Saved', role: 'text' }] })
    expect(observedOf(second)).toEqual({ appear: [{ text: 'Shared', role: 'text' }] })
  })

  it('matches by the tree alone when the device cannot answer', async () => {
    reachAnswer = 'fail'
    screen.elements = [{ role: 'cell', label: 'Row 13', enabled: true, frame: { x: 0, y: 0.86, width: 1, height: 0.06 } }]
    const at = { ...base, kind: 'tap', point: [0.5, 0.88] } as unknown as RawStep
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [launchStep, at], { start: 0, end: 2 }, null, hooks())
    await lease.stop()
    expect(log).toContain('replay tap')
    expect(matchedWith.at(-1)).toMatchObject({ tree: [{ label: 'Row 13' }] })
    expect(matchedWith.at(-1)).not.toHaveProperty('reach')
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

  it('pauses recording, resets the device, turns it and launches the app, then renews the pause before each step', async () => {
    const lease = new PauseLease(tap)
    const h = { ...hooks(), onReset: vi.fn() }
    await matchRange(tap, channel, lease, [tapStep, tapStep], { start: 0, end: 2 }, 'com.example', h)
    await lease.stop()
    expect(log).toEqual([
      'pause', 'reset com.example', 'keyboard first', 'orientation landscape', 'launch',
      'pause', 'replay tap', 'pause', 'replay tap',
    ])
    // The two steps, and the turn the range began in, which goes into the flow but is not replayed again.
    expect(h.onStep.mock.calls.map(([s, , inserted]) => [s.raw.kind, inserted ?? false])).toEqual([['rotate', true], ['tap', false], ['tap', false]])
    expect(h.onReset).toHaveBeenCalledWith({ done: ['keychain'], failed: [] })
  })

  // #1139: an agent that predates the reset still gets the app's data cleared, and the dialog is told it was not reset.
  it('clears the app\'s data when the agent cannot reset the device, and says so', async () => {
    resetAnswer = undefined
    const lease = new PauseLease(tap)
    const h = { ...hooks(), onReset: vi.fn() }
    await matchRange(tap, channel, lease, [tapStep], { start: 0, end: 1 }, 'com.example', h)
    await lease.stop()
    expect(log.slice(0, 3)).toEqual(['pause', 'reset com.example', 'clearState com.example'])
    expect(h.onReset).toHaveBeenCalledWith(null)
  })

  it('launches nothing for a range that starts with its own launch, and resets no app with no bundle id', async () => {
    const lease = new PauseLease(tap)
    const h = hooks()
    await matchRange(tap, channel, lease, [launchStep, tapStep], { start: 0, end: 2 }, null, h)
    await lease.stop()
    expect(log).toEqual(['pause', 'reset', 'keyboard first', 'orientation landscape', 'pause', 'replay launch', 'pause', 'replay tap'])
    // The turn after the launch, so the flow does not read as starting without one and get a second.
    expect(h.onStep.mock.calls.map(([s]) => s.raw.kind)).toEqual(['launch', 'rotate', 'tap'])
  })

  // Measured (Sample SwiftUI, iOS 26.5): after the reset the app is not running, and the settle read before the range's
  // launch went unanswered until its 15 s deadline, every Match.
  it('reads no screen before a launch that nothing is waiting on, and does before one that ends a touch\'s watch', async () => {
    const lease = new PauseLease(tap)
    await matchRange(tap, channel, lease, [launchStep, tapStep, launchStep, tapStep], { start: 0, end: 4 }, null, hooks())
    await lease.stop()
    expect(seq).toEqual(['replay launch', 'settle', 'replay tap', 'settle', 'replay launch', 'settle', 'replay tap', 'settle'])
  })

  it('does not replay an install, which would uninstall the app it just launched, and still names it', async () => {
    const lease = new PauseLease(tap)
    const h = hooks()
    await matchRange(tap, channel, lease, [installStep, tapStep], { start: 0, end: 2 }, 'com.example', h)
    await lease.stop()
    expect(log).toEqual(['pause', 'reset com.example', 'keyboard first', 'orientation landscape', 'launch', 'pause', 'replay tap'])
    expect(h.onStep.mock.calls.map(([s]) => s.raw.kind)).toEqual(['install', 'rotate', 'tap'])
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

// 1b-3b: each step that acts on the screen is compared with the picture of the screen it was recorded on, and Match
// waits at one that looks different until the person goes on or stops the run.
describe('matchRange: comparing each step with its recording', () => {
  const lease = { start: async () => {}, ensure: async () => {}, stop: async () => {} } as unknown as InstanceType<typeof PauseLease>
  const viewer = { ...tap, chrome: () => null } as unknown as Tap
  const KEYS = { x: 0, y: 0.6, width: 1, height: 0.4 }
  const differs = { diff: 0.2, nowUrl: 'blob:now', masks: [] }

  it('compares a step before it is replayed, the status bar and the recorded keyboard left out', async () => {
    const compared: unknown[] = []
    const typed = { ...textStep, keyboardRect: KEYS } as RawStep
    // The range is held sideways in this suite: its first step comes after a turn the replay puts in, and is not compared.
    await matchRange(viewer, channel, lease, [tapStep, tapStep, typed], { start: 0, end: 3 }, null, {
      ...hooks(),
      compare: async (step, masks) => { log.push(`compare ${step.kind}`); compared.push(masks); return null },
      onDiverged: async () => {},
    })
    expect(log.filter((l) => l.startsWith('compare') || l.startsWith('replay'))).toEqual(['replay tap', 'compare tap', 'replay tap', 'compare text', 'replay text'])
    expect(compared[1]).toEqual([{ x: 0, y: 0, width: 1, height: 0.055 }, KEYS])
  })

  it('does not compare a launch, nor the step after an install it leaves out', async () => {
    const marked = (n: number) => ({ ...tapStep, thumbnailKey: `r${n}` }) as RawStep
    await matchRange(viewer, channel, lease, [launchStep, marked(1), installStep, marked(2), marked(3)], { start: 0, end: 5 }, null, {
      ...hooks(),
      compare: async (step) => { log.push(`compare ${step.thumbnailKey}`); return null },
      onDiverged: async () => {},
    })
    // #1 comes after the turn the replay puts in, #2 after the install it leaves out: only #3 is compared.
    expect(log.filter((l) => l.startsWith('compare'))).toEqual(['compare r3'])
  })

  it('waits at a step that looks different, and replays it once the person goes on', async () => {
    let goOn: () => void = () => {}
    const at: number[] = []
    const run = matchRange(viewer, channel, lease, [tapStep, tapStep], { start: 0, end: 2 }, null, {
      ...hooks(),
      compare: async () => differs,
      onDiverged: (index) => { at.push(index); log.push('stopped'); return new Promise<void>((resolve) => { goOn = resolve }) },
    })
    await vi.waitFor(() => expect(log).toContain('stopped'))
    expect(log.filter((l) => l === 'replay tap')).toHaveLength(1)
    goOn()
    await run
    expect(at).toEqual([1])
    expect(log.filter((l) => l === 'replay tap')).toHaveLength(2)
  })

  it('replays nothing more when the run is stopped while it waits', async () => {
    const controller = new AbortController()
    const run = matchRange(viewer, channel, lease, [tapStep, tapStep], { start: 0, end: 2 }, null, {
      onStep: vi.fn(), signal: controller.signal,
      compare: async () => differs,
      onDiverged: () => new Promise<void>((_resolve, reject) => {
        log.push('stopped')
        controller.signal.addEventListener('abort', () => reject(new Error('stopped')))
      }),
    })
    await vi.waitFor(() => expect(log).toContain('stopped'))
    controller.abort()
    await expect(run).rejects.toThrow()
    expect(log.filter((l) => l === 'replay tap')).toHaveLength(1)
  })

  // CodeRabbit on #1155: Back goes wherever the screen it is pressed on leads; Home and the rest do not.
  it('compares a Back press, and no other button', async () => {
    const button = (name: string) => ({ ...base, kind: 'button', name, thumbnailKey: name }) as unknown as RawStep
    await matchRange(viewer, channel, lease, [tapStep, button('back'), button('home')], { start: 0, end: 3 }, null, {
      ...hooks(),
      compare: async (step) => { log.push(`compare ${step.thumbnailKey}`); return null },
      onDiverged: async () => {},
    })
    expect(log.filter((l) => l.startsWith('compare'))).toEqual(['compare back'])
  })

  // CodeRabbit on #1155: Stop pressed during the reads after the last step, which do not watch the signal.
  it('ends as stopped when Stop lands after the last step', async () => {
    const controller = new AbortController()
    const run = matchRange(viewer, channel, lease, [tapStep], { start: 0, end: 1 }, null, {
      onStep: () => controller.abort(), signal: controller.signal,
    })
    await expect(run).rejects.toThrow()
  })

  it('replays a step whose picture could not be compared, as before', async () => {
    await matchRange(viewer, channel, lease, [tapStep, tapStep], { start: 0, end: 2 }, null, {
      ...hooks(),
      compare: async () => { throw new Error('thumbnail 404') },
      onDiverged: async () => { log.push('stopped') },
    })
    expect(log).not.toContain('stopped')
    expect(log.filter((l) => l === 'replay tap')).toHaveLength(2)
  })
})

// Review of 1b-3b: the wait at a step that looked different, which Continue anyway ends and a stop rejects.
// 1b-3c: the screen each touch left, for Edit's "after this tap", by the touch's index into the matched steps.
describe('matchRange: the screen a touch left', () => {
  const lease = { start: async () => {}, ensure: async () => {}, stop: async () => {} } as unknown as InstanceType<typeof PauseLease>
  const viewer = { ...tap, chrome: () => null } as unknown as Tap
  it('hands over each tap\'s after-screen with its tree, the last one from the read after it', async () => {
    const afters: Array<[number, unknown]> = []
    screen.elements = [{ role: 'text', label: 'Welcome', frame: { x: 0, y: 0, width: 1, height: 0.1 }, enabled: true }]
    await matchRange(viewer, channel, lease, [launchStep, tapStep, textStep, tapStep], { start: 0, end: 4 }, null, {
      ...hooks(), onAfter: (index, after) => afters.push([index, after.tree]),
    })
    // launch #0, the turn the suite puts in #1, tap #2, text #3, tap #4: the two taps, by their places.
    expect(afters.map(([i]) => i)).toEqual([2, 4])
    expect(afters[0]![1]).toEqual(screen.elements)
  })
})

describe('DialogRun: deciding at a stop', () => {
  it('goes on when told, and rejects when the run is stopped', async () => {
    const run = new DialogRun()
    const signal = run.begin()
    const waiting = run.decide(signal)
    run.goOn()
    await expect(waiting).resolves.toBeUndefined()
    const again = run.decide(signal)
    run.abort()
    await expect(again).rejects.toBeDefined()
  })

  it('knows a run a later one replaced', () => {
    const run = new DialogRun()
    const first = run.begin()
    expect(run.isCurrent(first)).toBe(true)
    run.begin()
    expect(run.isCurrent(first)).toBe(false)
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
    expect(log.filter((l) => l !== 'pause')).toEqual(['reset', 'keyboard 한국어 (두벌식)', 'tap', 'keyboard 한국어 (두벌식)', 'type', 'key ImeAction'])
  })

  // #1139: from where a run starts, the flow's own app reset as Match's was, before the keyboard is set.
  it('resets the device for the flow\'s app before anything else, and reports it', async () => {
    const lease = new PauseLease(tap)
    const onReset = vi.fn()
    await verifyFlow(tap, channel, lease, { name: 'f', appId: 'com.example', steps: [] }, {}, () => {}, undefined, undefined, onReset)
    await lease.stop()
    expect(log.filter((l) => l !== 'pause')[0]).toBe('reset com.example')
    expect(onReset).toHaveBeenCalledWith({ done: ['keychain'], failed: [] })
  })

  // #1125: Export writes what each touch did beside it, so Verify has to watch.
  it('watches what each touch does', async () => {
    const lease = new PauseLease(tap)
    await verifyFlow(tap, channel, lease, { name: 'f', steps: [] }, {}, () => {})
    await lease.stop()
    expect(ran.options).toMatchObject({ observeEffects: true })
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

// 1b-3b: the pictures of the last steps go up after the steps; the snapshot is taken once they are there.
describe('loadSnapshot', () => {
  afterEach(() => vi.restoreAllMocks())
  it('waits for the viewer\'s pictures before it takes the snapshot', async () => {
    const order: string[] = []
    let release!: () => void
    const flushed = new Promise<void>((r) => { release = r })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { order.push('snapshot'); return new Response(JSON.stringify({ id: 'x', takenAt: 0, entries: [], thinned: false }), { status: 200 }) })
    const tap = { sessionId: 's', flushThumbnails: () => flushed.then(() => { order.push('flushed') }) } as never
    const loading = loadSnapshotForTest(tap)
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    release()
    await loading
    expect(order).toEqual(['flushed', 'snapshot'])
  })
})

// Record-time observation (P2b): a tap the app named is replayed on that element through the engine, wherever the list
// now puts it; a tap that only stopped a moving list is not compared.
describe('matchRange with the app\'s touch reports', () => {
  // The picture's masks read the chrome for the turn: none here.
  const ctap = { ...(tap as object), chrome: () => null } as unknown as Tap
  const frame = { x: 0.1, y: 0.3, width: 0.4, height: 0.06 }
  const orders = { role: 'button', label: 'New Orders', enabled: true, frame }
  const named = { ...tapStep, point: [0.3, 0.33], touched: { point: { x: 0.3, y: 0.33 }, moving: false, element: { label: 'New Orders', traits: 1, frame } } } as unknown as RawStep
  const swipeUp = { ...base, kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.3], durationMs: 300 } as unknown as RawStep
  const compareHooks = () => {
    const compare = vi.fn(async (_raw: RawStep, _masks: unknown[]) => null)
    return { compare, h: { ...hooks(), compare, onDiverged: vi.fn(async () => {}) } }
  }
  const flowsAsSteps = () => ran.flows.map((f) => (f.steps as Array<{ type: string; direction?: string }>).map((x) => x.direction ? `${x.type} ${x.direction}` : x.type))
  // A step first after the launch is never compared here (the mock holds the range sideways, and the turn the replay
  // puts in leaves that step's screen unlike the recording's): a `tapStep` takes that place, and the next one is the
  // control that is compared.

  it('taps the named element through the engine, not the recorded point, and judges it by the element, not the picture', async () => {
    screen.elements = [orders]
    const { compare, h } = compareHooks()
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, named], { start: 0, end: 4 }, null, h)
    await lease.stop()
    expect(flowsAsSteps()).toEqual([['tapOn']])
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay launch', 'replay tap', 'replay tap'])
    expect(compare.mock.calls.map((c) => c[0])).toEqual([tapStep])
    expect((h.onStep.mock.calls.at(-1) as unknown as [{ step: unknown }])[0].step).toMatchObject({ type: 'tapOn' })
  })

  it('scrolls the way the swipe before it went, then back the other way, when the element is off the screen', async () => {
    screen.elements = []
    ran.answers = [{ status: 'failed', failureKind: 'product' }]
    const { compare, h } = compareHooks()
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, swipeUp, named], { start: 0, end: 5 }, null, h)
    await lease.stop()
    expect(flowsAsSteps()).toEqual([['scroll down', 'tapOn'], ['scroll up', 'tapOn']])
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay launch', 'replay tap', 'replay tap', 'replay swipe'])
    // How far the swipe carried the list is not compared: the tap after it finds its element wherever it is.
    expect(compare.mock.calls.map((c) => c[0])).toEqual([tapStep])
  })

  it('falls back to the picture and the recorded point when the element is found neither way', async () => {
    screen.elements = []
    ran.answers = [{ status: 'failed', failureKind: 'product' }, { status: 'failed', failureKind: 'product' }]
    const { compare, h } = compareHooks()
    trackShots.on = true
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, swipeUp, named], { start: 0, end: 5 }, null, h)
    await lease.stop()
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay launch', 'replay tap', 'replay tap', 'replay swipe', 'replay tap'])
    expect(compare.mock.calls.map((c) => c[0])).toEqual([tapStep, named])
    // The search moved the screen: it is read again before the point is replayed on it.
    // …and pictured again for the step: the picture taken before the search shows a screen it moved.
    const last = seq.lastIndexOf('replay tap')
    expect(seq.slice(last - 3, last + 1)).toEqual(['shot', 'settle', 'shot', 'replay tap'])
  })

  // Review of P2b: the fallback matched against the screen read before the search and asked the device nothing.
  it('asks the device about the point it falls back to, on the screen the search left', async () => {
    screen.elements = [{ role: 'button', label: 'Row 2', enabled: true, frame: { x: 0, y: 0.2, width: 1, height: 0.06 } }]
    // The search moves the screen: what it leaves is not what was read before it, so a stale tree fails this.
    ran.beforeRun = () => { screen.elements = [{ role: 'button', label: 'Row 3', enabled: true, frame: { x: 0, y: 0.3, width: 1, height: 0.06 } }] }
    ran.answers = [{ status: 'failed', failureKind: 'product' }, { status: 'failed', failureKind: 'product' }]
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, swipeUp, named], { start: 0, end: 5 }, null, compareHooks().h)
    await lease.stop()
    expect(log.filter((l) => l.startsWith('reach')).at(-1)).toBe('reach Row 3')
    expect(log.indexOf('reach Row 3')).toBeLessThan(log.lastIndexOf('replay tap'))
  })

  // CodeRabbit on #1167: an iOS tree keeps rows a list scrolled past, and `tapOn` alone failed such a row as off screen.
  it('searches for an element the tree holds off the screen, as for one it does not hold', async () => {
    screen.elements = [{ ...orders, frame: { ...frame, y: 1.3 } }]
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, swipeUp, named], { start: 0, end: 5 }, null, compareHooks().h)
    await lease.stop()
    expect(flowsAsSteps()).toEqual([['scroll down', 'tapOn']])
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay launch', 'replay tap', 'replay tap', 'replay swipe'])
  })

  it('searches the way the swipe went when the element on the screen could not be tapped, before the point', async () => {
    screen.elements = [orders]
    ran.answers = [{ status: 'failed', failureKind: 'product' }]
    const onAfter = vi.fn()
    const h = { ...compareHooks().h, onAfter }
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, swipeUp, named], { start: 0, end: 5 }, null, h)
    await lease.stop()
    expect(flowsAsSteps()).toEqual([['tapOn'], ['scroll down', 'tapOn']])
    expect(log.filter((l) => l.startsWith('replay'))).toEqual(['replay launch', 'replay tap', 'replay tap', 'replay swipe'])
    // Found after a scroll: its effect is not read against the screen from before it.
    expect(onAfter.mock.calls.map((c) => c[0])).not.toContain(4)
  })

  // Review of P2b: the engine takes no signal, and a scroll search ran on for up to 30 s after Stop.
  it('stops the engine at its next touch when Stop is pressed during a named tap', async () => {
    screen.elements = [orders]
    const stop = new AbortController()
    ran.beforeRun = () => stop.abort()
    const lease = new PauseLease(ctap)
    ran.probe = {}
    await expect(matchRange(ctap, channel, lease, [launchStep, named], { start: 0, end: 2 }, null, { ...hooks(), signal: stop.signal })).rejects.toThrow()
    await lease.stop()
    expect(log).not.toContain('tap')
    // Every way the engine reaches the device from a scroll search and a tap, its failure picture included.
    expect(ran.probe).toEqual({ queryUITree: 'stopped', reach: 'stopped', swipe: 'stopped', tap: 'stopped', screenshot: 'stopped' })
  })

  it('stops on a session that ended rather than falling back', async () => {
    screen.elements = [orders]
    ran.answers = [{ status: 'failed', failureKind: 'environment', failureMessage: 'session ended' }]
    const lease = new PauseLease(ctap)
    await expect(matchRange(tap, channel, lease, [launchStep, named], { start: 0, end: 2 }, null, hooks())).rejects.toThrow('session ended')
    await lease.stop()
    expect(log).not.toContain('replay tap')
  })

  it('does not compare a tap left out for stopping a moving list', async () => {
    const dropped = { ...tapStep, dropped: 'stopped-scroll' } as unknown as RawStep
    const { compare, h } = compareHooks()
    const lease = new PauseLease(ctap)
    await matchRange(ctap, channel, lease, [launchStep, tapStep, tapStep, dropped, tapStep], { start: 0, end: 5 }, null, h)
    await lease.stop()
    expect(compare.mock.calls.map((c) => c[0])).toEqual([tapStep, tapStep])
  })
})
