import { describe, it, expect, vi } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { runFlow, type FlowDriver } from '../engine.js'
import { parseFlow } from '../schema.js'
import { DeviceLacksError, EnvironmentStepError, markEnvironmentFailure, TransientQueryError } from '../errors.js'
import type { PinchFingers } from '../engine.js'
import type { ChromeButton, ChromeData } from '@tapflowio/protocol'

const el = (over: Partial<UIElement>): UIElement => ({
  role: 'button',
  label: '',
  frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.1 },
  enabled: true,
  ...over,
})

// trees: sequence of queryUITree results; the last one repeats.
function fakeDriver(trees: UIElement[][]): FlowDriver & { calls: Array<[string, ...unknown[]]> } {
  let i = 0
  const calls: Array<[string, ...unknown[]]> = []
  return {
    calls,
    queryUITree: vi.fn(async () => trees[Math.min(i++, trees.length - 1)]),
    tap: vi.fn(async (x: number, y: number) => { calls.push(['tap', x, y]) }),
    swipe: vi.fn(async (from: [number, number], to: [number, number], durationMs: number) => {
      calls.push(['swipe', from, to, durationMs])
    }),
    inputText: vi.fn(async (text: string) => { calls.push(['inputText', text]) }),
    pressKey: vi.fn(async (code: string) => { calls.push(['pressKey', code]) }),
    openUrl: vi.fn(async (url: string) => { calls.push(['openUrl', url]) }),
    launchApp: vi.fn(async (options?: unknown) => { calls.push(options === undefined ? ['launchApp'] : ['launchApp', options]) }),
    clearState: vi.fn(async (appId: string) => { calls.push(['clearState', appId]) }),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    pressButton: vi.fn(async (name: string) => { calls.push(['pressButton', name]) }),
    longPress: vi.fn(async (x: number, y: number, durationMs: number) => { calls.push(['longPress', x, y, durationMs]) }),
    pinch: vi.fn(async (start: PinchFingers, end: PinchFingers, durationMs: number) => { calls.push(['pinch', start, end, durationMs]) }),
    setOrientation: vi.fn(async (orientation: string, timeoutMs: number) => { calls.push(['setOrientation', orientation, timeoutMs]) }),
    setPosture: vi.fn(async (posture: string, timeoutMs: number) => { calls.push(['setPosture', posture, timeoutMs]) }),
  }
}

const chromeButton = (name: string, usage: number): ChromeButton => ({
  name, accessibilityTitle: name, anchor: 'left', onTop: false,
  normalOffset: { x: 0, y: 0 }, rolloverOffset: { x: 0, y: 0 }, buttonW: 1, buttonH: 1, usagePage: 12, usage,
})

const iosChrome = (...buttons: ChromeButton[]): ChromeData => ({
  framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
  padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
  screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1, buttons,
})

const OPTS = { pollIntervalMs: 1, defaultTimeoutMs: 20 }

const flowOf = (yaml: string) => parseFlow(yaml, 'test.yaml')

describe('runFlow', () => {
  // #1047. The step's name is what a run record and a failure message show: argument values yes, env values never.
  it('launches with the step\'s options and names them without env values', async () => {
    const driver = fakeDriver([[el({ label: 'Home' })]])
    const result = await runFlow(flowOf('steps:\n  - launchApp: { arguments: { flag: true, host: s.example.com }, env: { TOKEN: hunter2 } }\n'), driver, OPTS)
    expect(driver.calls[0]).toEqual(['launchApp', { arguments: { flag: true, host: 's.example.com' }, env: { TOKEN: 'hunter2' } }])
    const name = result.steps[0]!.name
    expect(name).toBe('launchApp(flag=true, host="s.example.com", env TOKEN=***)')
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  // #1047, PR 2. The relay's per-app defaults are applied outside the YAML, so the run record names them — keys only,
  // since the relay sends no values back — or the same flow's result would depend on a config nobody can see.
  it.each([
    ['a plain launch', 'steps:\n  - launchApp\n', 'launchApp(config: a, b, env LOG_LEVEL)'],
    ['a launch whose own keys overlap the defaults', 'steps:\n  - launchApp: { arguments: { b: 3 } }\n', 'launchApp(b=3; config: a, env LOG_LEVEL)'],
  ])('names the defaults the relay added to %s', async (_, yaml, expected) => {
    const driver = fakeDriver([[el({ label: 'Home' })]])
    vi.mocked(driver.launchApp).mockResolvedValue({ arguments: ['a', 'b'], env: ['LOG_LEVEL'] })
    const result = await runFlow(flowOf(yaml), driver, OPTS)
    expect(result.steps[0]!.name).toBe(expected)
  })

  it('keeps the plain name when nothing was applied, and when a driver answers nothing', async () => {
    const driver = fakeDriver([[el({ label: 'Home' })]])
    vi.mocked(driver.launchApp).mockResolvedValue({ arguments: [], env: [] })
    expect((await runFlow(flowOf('steps:\n  - launchApp\n'), driver, OPTS)).steps[0]!.name).toBe('launchApp')
    expect((await runFlow(flowOf('steps:\n  - launchApp\n'), fakeDriver([[el({ label: 'Home' })]]), OPTS)).steps[0]!.name).toBe('launchApp')
  })

  it('taps the center of the matched element frame', async () => {
    const driver = fakeDriver([[el({ label: '로그인', frame: { x: 0.2, y: 0.8, width: 0.6, height: 0.1 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.5, 0.85]])
  })

  it('resolves a bare-string selector as identifier before label', async () => {
    const driver = fakeDriver([[
      el({ label: 'login', identifier: 'other' }),
      el({ label: 'x', identifier: 'login', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "login"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.1]])
  })

  it('prefers exact label matches over partial ones', async () => {
    const driver = fakeDriver([[
      el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
      el({ label: '로그인', frame: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.6, 0.6]])
  })

  it('falls back to partial label matches when no exact match exists', async () => {
    const driver = fakeDriver([[el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('fails immediately on multiple matches instead of picking one implicitly', async () => {
    const driver = fakeDriver([[el({ label: '삭제' }), el({ label: '삭제' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "삭제"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/2 elements match/)
    expect(result.failureMessage).toMatch(/add an index or a more specific role\/label/)
    expect(driver.tap).not.toHaveBeenCalled()
  })

  // B2: a tapOn that misses carries lines to try, from the screen it missed on.
  it('attaches suggestions to a tapOn that matched nothing, from the last screen it saw', async () => {
    const driver = fakeDriver([[el({ label: 'Sign in' }), el({ label: 'Help', role: 'text' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign inn"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]!.suggestions).toEqual([{ yaml: 'tapOn: "Sign in"', element: { role: 'button', label: 'Sign in' } }])
  })

  it('attaches the matches, told apart, to a tapOn that matched several', async () => {
    const driver = fakeDriver([[el({ label: '삭제' }), el({ label: '삭제', role: 'cell' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "삭제"\n'), driver, OPTS)
    expect(result.steps[0]!.suggestions?.map((x) => x.yaml)).toEqual([
      'tapOn: { label: "삭제", role: "button" }', 'tapOn: { label: "삭제", role: "cell" }',
    ])
  })

  it('suggests nothing for an assertVisible that misses: the app may be what is wrong', async () => {
    const driver = fakeDriver([[el({ label: 'Pay now' })]])
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "Pay nw"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  it('suggests nothing when the screen was read and then the query itself failed', async () => {
    // The selector is not what failed: the last tree seen is no evidence about it.
    let calls = 0
    const driver = fakeDriver([])
    driver.queryUITree = vi.fn(async () => {
      if (calls++ === 0) return [el({ label: 'Sign in' })]
      throw new Error('session ended')
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign inn"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  it('suggests nothing when no screen was ever read', async () => {
    const driver = fakeDriver([])
    driver.queryUITree = vi.fn(async () => { throw new TransientQueryError('agent busy') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, OPTS)
    expect(result.failureKind).toBe('environment')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  describe('launchApp waits for the app\'s screen to hold still', () => {
    const SLOW = { pollIntervalMs: 500, defaultTimeoutMs: 10_000 }
    // Runs a flow under fake timers. `reads` answers each tree query in turn (the last repeats); a function is
    // called instead, so a test can throw or spend time. Returns when each query started and when the swipe went.
    async function launchThenScroll(reads: Array<UIElement[] | (() => UIElement[])>) {
      vi.useFakeTimers()
      try {
        const t0 = Date.now()
        const queries: number[] = []
        let swipeAt = -1
        const driver = fakeDriver([])
        let i = 0
        driver.queryUITree = vi.fn(async () => {
          queries.push(Date.now() - t0)
          const r = reads[Math.min(i++, reads.length - 1)]!
          return typeof r === 'function' ? r() : r
        })
        driver.swipe = vi.fn(async () => { swipeAt = Date.now() - t0 })
        const run = runFlow(flowOf('steps:\n  - launchApp\n  - scroll: down\n'), driver, SLOW)
        await vi.advanceTimersByTimeAsync(20_000)
        const result = await run
        return { result, queries, swipeAt }
      } finally {
        vi.useRealTimers()
      }
    }
    const screen = [el({ label: 'Home' }), el({ label: 'Settings', identifier: 'settings' })]

    // Seen on iOS: a scroll sent right after launch was acknowledged and dropped by the app, 5 of 5.
    it('sends the next step once the same screen has read for a second, counted from when it was first read', async () => {
      const { result, queries, swipeAt } = await launchThenScroll([screen])
      expect(result.status).toBe('passed')
      // Reads 500 ms apart: the second is only 500 ms after the first, so it is the third that confirms.
      expect(queries).toEqual([0, 500, 1000])
      expect(swipeAt).toBe(1000)
    })

    // Measured on a Flutter iOS app: the first tree that reads is its splash, one element.
    it('does not take a splash for the screen when the screen follows it', async () => {
      const { queries, swipeAt } = await launchThenScroll([[el({ label: 'splash' })], screen])
      expect(queries).toEqual([0, 500, 1000, 1500])
      expect(swipeAt).toBe(1500)
    })

    it('compares role, label and identifier, not where things are drawn', async () => {
      let x = 0
      const moving = () => [el({ label: 'donut', frame: { x: (x = (x + 0.1) % 0.5), y: 0, width: 0.1, height: 0.1 } })]
      const { swipeAt } = await launchThenScroll([moving])
      expect(swipeAt).toBe(1000)
    })

    it('treats a label that changes as a different screen', async () => {
      const relabelled = [el({ label: 'Home' }), el({ label: 'Settings', identifier: 'other' })]
      const { swipeAt } = await launchThenScroll([screen, relabelled, relabelled, relabelled])
      expect(swipeAt).toBe(1500)
    })

    // A game, canvas or WebView-only screen has nothing in the tree and is up all the same.
    it('takes an empty tree that holds still as a screen, instead of waiting out the timeout', async () => {
      const { result, swipeAt } = await launchThenScroll([[]])
      expect(result.status).toBe('passed')
      expect(swipeAt).toBe(1000)
    })

    it('lets a failed read neither confirm nor reset the screen', async () => {
      const notUp = () => { throw new TransientQueryError('not up yet') }
      const { swipeAt } = await launchThenScroll([screen, notUp, screen])
      expect(swipeAt).toBe(1000)
    })

    it('stops waiting 3 s after the first read on a screen that never holds still', async () => {
      let n = 0
      const ticking = () => [el({ label: `00:0${n++}` })]
      const { result, swipeAt } = await launchThenScroll([ticking])
      expect(result.status).toBe('passed')
      expect(swipeAt).toBe(3000)
    })

    // An Android dump takes ~2.5 s by itself.
    it('does not add the poll interval after a read that already took longer', async () => {
      const slowDump = () => { vi.advanceTimersByTime(2500); return screen }
      const { queries, swipeAt } = await launchThenScroll([slowDump])
      expect(queries).toEqual([0, 2500])
      expect(swipeAt).toBe(5000)
    })

    // A slow emulator: the confirming dump takes longer than the cap's margin. It must be allowed to finish and count,
    // rather than be cut off at the cap. Real timers: `AbortSignal.timeout` does not follow vitest's fake clock.
    it('lets a read that ends past the cap confirm the screen', async () => {
      let aborted = false
      let reads = 0
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn((signal?: AbortSignal) => {
        if (reads++ === 0) return Promise.resolve(screen)
        return new Promise<UIElement[]>((resolve, reject) => {
          const t = setTimeout(() => resolve(screen), 3500)
          signal?.addEventListener('abort', () => {
            aborted = true
            clearTimeout(t)
            reject(new TransientQueryError('aborted'))
          })
        })
      })
      const result = await runFlow(flowOf('steps:\n  - launchApp\n'), driver, SLOW)
      expect(result.status).toBe('passed')
      expect(aborted).toBe(false)
      expect(reads).toBe(2)
    }, 10_000)

    it('goes on after the timeout when no read ever succeeds, without failing', async () => {
      const { result, swipeAt } = await launchThenScroll([() => { throw new TransientQueryError('not up yet') }])
      expect(result.status).toBe('passed')
      expect(swipeAt).toBe(10_000)
    })

    it('leaves a failing tree query to the next step to report', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn(async () => { throw new Error('Session not found') })
      const result = await runFlow(flowOf('steps:\n  - launchApp\n'), driver, OPTS)
      expect(result.status).toBe('passed')
    })
  })

  describe('a query cut off at the deadline', () => {
    // The runner aborts its own in-flight query when the step's time is up. That names nothing that failed.
    const hangingAfter = (tree: UIElement[]) => {
      let calls = 0
      return vi.fn(async (signal?: AbortSignal) => {
        if (calls++ === 0) return tree
        return new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
          reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout'))))
      })
    }

    it('is left out of a selector miss on a screen that was read', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = hangingAfter([el({ label: 'Other' })])
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureKind).toBe('product')
      expect(result.failureMessage).not.toMatch(/last query error/)
    })

    it('stays when no screen was ever read — then it is the finding', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn((signal?: AbortSignal) => new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
        reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout')))))
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureKind).toBe('environment')
      expect(result.failureMessage).toMatch(/aborted due to timeout/)
    })

    it('does not hide a real error seen before it', async () => {
      let calls = 0
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn(async (signal?: AbortSignal) => {
        const n = calls++
        if (n === 0) return [el({ label: 'Other' })]
        if (n === 1) throw new TransientQueryError('agent busy')
        return new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
          reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout'))))
      })
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureMessage).not.toMatch(/aborted/)
      expect(result.failureMessage).toMatch(/last query error: agent busy/)
    })
  })

  // A2: the name watchers see drops what a step types, the URL it opens and a key that types a character.
  it('names each step for watchers without what it types', async () => {
    const marks: Record<string, unknown>[] = []
    const driver = fakeDriver([[el({ label: 'ok' })]])
    await runFlow(flowOf('steps:\n  - inputText: "hunter2"\n  - openUrl: "myapp://reset?token=s3cret"\n  - pressKey: KeyA\n  - pressKey: NumpadComma\n  - pressKey: NumpadStar\n  - pressKey: Enter\n  - pressKey: { code: KeyQ, modifiers: [shift] }\n  - pressKey: { code: ArrowLeft, modifiers: [alt] }\n  - tapOn: "ok"\n'), driver, { ...OPTS, onStep: (m) => marks.push(m) })
    expect(marks.filter((m) => m['phase'] === 'start').map((m) => m['label'])).toEqual([
      'inputText (7 chars)', 'openUrl', 'pressKey(character)', 'pressKey(character)', 'pressKey(character)', 'pressKey(Enter)',
      'pressKey(shift+character)', 'pressKey(alt+ArrowLeft)', 'tapOn("ok")',
    ])
    expect(JSON.stringify(marks.map((m) => m['label']))).not.toMatch(/hunter2|s3cret/)
  })

  it('disambiguates a shared label by role', async () => {
    const driver = fakeDriver([[
      el({ role: 'button', label: 'New Orders', frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }),
      el({ role: 'text', label: 'New Orders', frame: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      label: "New Orders"\n      role: button\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.2, 0.25]]) // the button, not its inner text
  })

  it('picks the Nth match by index (label-less rows)', async () => {
    const driver = fakeDriver([[
      el({ role: 'cell', label: '', frame: { x: 0, y: 0, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.3, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.6, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 2\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.65]]) // cell at index 2
  })

  it('index: 0 picks the first match', async () => {
    const driver = fakeDriver([[
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.1, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.5, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 0\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.15]]) // first cell
  })

  it('index out of range → no match, fails at the deadline', async () => {
    const driver = fakeDriver([[el({ role: 'cell', label: '' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 5\n'), driver, OPTS)
    expect(result.status).toBe('failed')
  })

  it('polls the tree until the element appears', async () => {
    const driver = fakeDriver([[], [], [el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(3)
  })

  it('retries a transient query error (foreground race), then resolves', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('is the app running in the foreground?')
      return [el({ label: 'OK' })]
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('fails at the deadline surfacing the last transient query error', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async () => { throw new TransientQueryError('is the app running in the foreground?') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('last query error: is the app running in the foreground?')
  })

  it('fails immediately on a non-transient query error (no retry)', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async () => { throw new Error('Session not found') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('Session not found')
    expect(driver.queryUITree).toHaveBeenCalledTimes(1)
  })

  it('does not hang when a query stalls — the deadline aborts it and the step fails', async () => {
    const driver = fakeDriver([[]])
    // The query never resolves on its own; only the engine's deadline AbortSignal ends it.
    driver.queryUITree = vi.fn((signal?: AbortSignal) => new Promise<UIElement[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new TransientQueryError('query aborted at deadline')))
    }))
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(vi.mocked(driver.queryUITree).mock.calls[0]![0]).toBeInstanceOf(AbortSignal) // engine passed a bounding signal
  })

  it('caps the final polling delay at the selector deadline', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      const pending = runFlow(flowOf('steps:\n  - assertVisible:\n      label: OK\n'), driver, { pollIntervalMs: 500, defaultTimeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(driver.queryUITree).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hang when failure screenshot capture stalls', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.openUrl = vi.fn(async () => { throw new Error('product failure') })
      driver.screenshot = vi.fn(() => new Promise<Buffer>(() => {}))
      const pending = runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(result.failureScreenshot).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures the screen a passed flow ends on only when asked, and keeps it out of the duration', async () => {
    const asked = fakeDriver([[]])
    const passed = await runFlow(flowOf('steps:\n  - pressKey: Enter\n'), asked, { ...OPTS, captureLastScreen: true })
    expect(passed.status).toBe('passed')
    expect(passed.lastScreenshot).toEqual(Buffer.from('PNG'))
    expect(passed.failureScreenshot).toBeUndefined()

    const notAsked = fakeDriver([[]])
    const plain = await runFlow(flowOf('steps:\n  - pressKey: Enter\n'), notAsked, OPTS)
    expect(plain.lastScreenshot).toBeUndefined()
    expect(notAsked.screenshot).not.toHaveBeenCalled()

    // A failed flow already has its last screen as the failure screenshot; it is not taken twice.
    const failing = fakeDriver([[]])
    failing.openUrl = vi.fn(async () => { throw new Error('product failure') })
    const failed = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), failing, { ...OPTS, captureLastScreen: true })
    expect(failed.lastScreenshot).toBeUndefined()
    expect(failing.screenshot).toHaveBeenCalledTimes(1)
  })

  it('gives up on a last screen that stalls, and still passes the flow', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.screenshot = vi.fn(() => new Promise<Buffer>(() => {}))
      const pending = runFlow(flowOf('steps:\n  - pressKey: Enter\n'), driver, { ...OPTS, captureLastScreen: true })
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await pending
      expect(result.status).toBe('passed')
      expect(result.lastScreenshot).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with a timeout, captures a screenshot, and skips remaining steps', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n  - pressKey: Enter\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/없는버튼/)
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(result.failureScreenshot).toEqual(Buffer.from('PNG'))
    expect(driver.pressKey).not.toHaveBeenCalled()
  })

  it('assertNotVisible passes once the element disappears', async () => {
    const driver = fakeDriver([[el({ label: '스피너' })], []])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "스피너"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
  })

  it('assertNotVisible fails when the element is still present at timeout', async () => {
    const driver = fakeDriver([[el({ label: '오류' })]])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "오류"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
  })

  it('assertVisible accepts multiple matches (presence only)', async () => {
    const driver = fakeDriver([[el({ label: '항목' }), el({ label: '항목' })]])
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "항목"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('assertVisible retries a transient query error, then passes', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('foreground?')
      return [el({ label: '항목' })]
    })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "항목"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('assertNotVisible does not treat a transient error as "gone" (element still present)', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('foreground?')
      return [el({ label: '오류' })] // still present after the transient blip
    })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "오류"\n'), driver, OPTS)
    expect(result.status).toBe('failed') // must not pass on the transient poll
  })

  it('maps scroll directions to swipes (direction = where to reveal content)', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - scroll\n  - scroll: up\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([
      ['swipe', [0.5, 0.7], [0.5, 0.3], 300],
      ['swipe', [0.5, 0.3], [0.5, 0.7], 300],
    ])
  })

  describe('scroll until an element is on screen', () => {
    const row = (label: string, y: number) => el({ label, role: 'cell', frame: { x: 0, y, width: 1, height: 0.05 } })
    const swipes = (driver: ReturnType<typeof fakeDriver>) => driver.calls.filter((c) => c[0] === 'swipe')

    it('sends no swipe when the element is already on screen', async () => {
      const driver = fakeDriver([[row('Row 16', 0.5)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toEqual([])
      expect(result.steps[0]!.name).toBe('scroll(down until "Row 16")')
    })

    it('swipes the scroll gesture until it appears, in the given direction', async () => {
      const driver = fakeDriver([[row('Row 1', 0.3)], [row('Row 8', 0.3)], [row('Row 16', 0.3)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { direction: up, until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toEqual([['swipe', [0.5, 0.3], [0.5, 0.7], 300], ['swipe', [0.5, 0.3], [0.5, 0.7], 300]])
    })

    // The agents clip frames to the screen, so a row cut by the edge content enters from ends exactly on it — and a
    // tap on its center can land on a bar drawn over that edge.
    it('keeps scrolling past a match cut by the edge the list scrolls in from', async () => {
      const cut = el({ label: 'Row 16', role: 'cell', frame: { x: 0, y: 0.97, width: 1, height: 0.03 } })
      const driver = fakeDriver([[row('Row 1', 0.3), cut], [row('Row 16', 0.5)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(1)
    })

    it('judges the cut by the direction: scrolling up, the top edge', async () => {
      const top = el({ label: 'Header', frame: { x: 0, y: 0, width: 1, height: 0.04 } })
      const bottom = el({ label: 'Header', frame: { x: 0, y: 0.96, width: 1, height: 0.04 } })
      const up = fakeDriver([[top], [row('Header', 0.3)]])
      expect((await runFlow(flowOf('steps:\n  - scroll: { direction: up, until: "Header" }\n'), up, OPTS)).status).toBe('passed')
      expect(swipes(up)).toHaveLength(1)
      const down = fakeDriver([[bottom]])
      expect((await runFlow(flowOf('steps:\n  - scroll: { direction: up, until: "Header" }\n'), down, OPTS)).status).toBe('passed')
      expect(swipes(down)).toHaveLength(0)
    })

    it('judges the cut by the direction: left and right, the side edges', async () => {
      const at = (x: number) => el({ label: 'Tab', frame: { x, y: 0.1, width: 0.04, height: 0.05 } })
      const right = fakeDriver([[at(0.96)], [at(0.5)]])
      expect((await runFlow(flowOf('steps:\n  - scroll: { direction: right, until: "Tab" }\n'), right, OPTS)).status).toBe('passed')
      expect(swipes(right)).toEqual([['swipe', [0.8, 0.5], [0.2, 0.5], 300]])
      const left = fakeDriver([[at(0)], [at(0.5)]])
      expect((await runFlow(flowOf('steps:\n  - scroll: { direction: left, until: "Tab" }\n'), left, OPTS)).status).toBe('passed')
      expect(swipes(left)).toEqual([['swipe', [0.2, 0.5], [0.8, 0.5], 300]])
      const notCut = fakeDriver([[at(0)]])
      expect((await runFlow(flowOf('steps:\n  - scroll: { direction: right, until: "Tab" }\n'), notCut, OPTS)).status).toBe('passed')
      expect(swipes(notCut)).toEqual([])
    })

    it('takes a match pinned to the entering edge while something else keeps changing', async () => {
      const cta = el({ label: 'Continue', frame: { x: 0, y: 0.92, width: 1, height: 0.08 } })
      const driver = fakeDriver([[]])
      let n = 0
      vi.mocked(driver.queryUITree).mockImplementation(async () => [row(`Synced ${n++}s ago`, 0.1), cta])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: { label: "Continue", timeout: 5 } }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(2)
    })

    it('does not take a match larger than the screen for one that stays put: clipped, it reads the same anywhere', async () => {
      const big = el({ label: 'Target', frame: { x: 0, y: 0, width: 1, height: 1 } })
      const driver = fakeDriver([[]])
      let n = 0
      vi.mocked(driver.queryUITree).mockImplementation(async () => (n++ < 5 ? [row(`Synced ${n}s ago`, 0.1), big] : [row('Target', 0.4)]))
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: { label: "Target", timeout: 5 } }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(5)
    })

    it('counts a match as still only while it stays put: one that moves again is being scrolled in', async () => {
      const cut = (y: number) => el({ label: 'Row 16', role: 'cell', frame: { x: 0, y, width: 1, height: 1 - y } })
      const driver = fakeDriver([[cut(0.97)], [cut(0.97)], [cut(0.96)], [cut(0.96)], [row('Row 16', 0.5)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(4)
    })

    it('takes a cut match at the end of the list, where scrolling cannot bring more of it', async () => {
      const cut = el({ label: 'Footer', frame: { x: 0, y: 0.98, width: 1, height: 0.02 } })
      const driver = fakeDriver([[row('Row 1', 0.3), cut]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Footer" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(2)
    })

    // Rows that share a label scroll by moving, not by changing what the screen holds.
    it('does not take a screen whose elements only moved for the end of the list', async () => {
      const page = (shift: number) => [0.2, 0.4, 0.6, 0.8].map((y) => row('Item', y - shift))
      const driver = fakeDriver([page(0), page(0.1), page(0.15), [...page(0.15), row('Done', 0.9)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Done" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
    })

    // assertVisible's rule (suggest.ts): a tapOn line offered for a check that something is there turns a regression green.
    it('offers no selector suggestions when it fails', async () => {
      const driver = fakeDriver([[row('Checkout later', 0.3)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Checkout now" }\n'), driver, OPTS)
      expect(result.status).toBe('failed')
      expect(result.steps[0]!.suggestions).toBeUndefined()
    })

    // Two unchanged reads, not one: a single one can follow a swipe the app dropped.
    it('fails as the product\'s at the end of the list, before the timeout', async () => {
      const driver = fakeDriver([[row('Row 1', 0.3)], [row('Row 30', 0.3)], [row('Row 30', 0.3)], [row('Row 30', 0.3)]])
      const started = Date.now()
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 99" }\n'), driver, OPTS)
      expect(result.status).toBe('failed')
      expect(result.failureKind).toBe('product')
      expect(result.failureMessage).toMatch(/scrolled down to the end without "Row 99" coming on screen/)
      expect(swipes(driver)).toHaveLength(3)
      expect(Date.now() - started).toBeLessThan(5_000)
    })

    it('two unchanged reads that are not in a row are not the end', async () => {
      const driver = fakeDriver([[row('Row 1', 0.3)], [row('Row 1', 0.3)], [row('Row 8', 0.3)], [row('Row 8', 0.3)], [row('Row 16', 0.3)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
    })

    it('one unchanged read after a swipe is not the end', async () => {
      const driver = fakeDriver([[row('Row 1', 0.3)], [row('Row 1', 0.3)], [row('Row 16', 0.3)]])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 16" }\n'), driver, OPTS)
      expect(result.status).toBe('passed')
    })

    // A dump takes ~2.5 s on an emulator: the default step wait would allow about three swipes.
    it('waits past the default step timeout when until names none', async () => {
      const driver = fakeDriver([[]])
      let n = 0
      vi.mocked(driver.queryUITree).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 3))
        return [row(`Row ${n++}`, 0.3)]
      })
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: "Row 15" }\n'), driver, OPTS) // OPTS waits 20 ms
      expect(result.status).toBe('passed')
      expect(swipes(driver)).toHaveLength(15)
    })

    it('fails at the selector\'s timeout while the screen keeps changing', async () => {
      const driver = fakeDriver([[]])
      let n = 0
      vi.mocked(driver.queryUITree).mockImplementation(async () => [row(`Row ${n++}`, 0.3)])
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: { label: "Row 99999", timeout: 0.05 } }\n'), driver, OPTS)
      expect(result.status).toBe('failed')
      expect(result.failureKind).toBe('product')
      expect(result.failureMessage).toMatch(/on screen after scrolling down for 0.05s/)
    })

    // A failed read says nothing about where the list is; swiping blind could carry the element past.
    it('does not swipe after a read that failed, and fails as the environment\'s with no screen seen', async () => {
      const driver = fakeDriver([[]])
      vi.mocked(driver.queryUITree).mockRejectedValue(new TransientQueryError('agent busy'))
      const result = await runFlow(flowOf('steps:\n  - scroll: { until: { label: "Row 16", timeout: 0.05 } }\n'), driver, OPTS)
      expect(result.failureKind).toBe('environment')
      expect(swipes(driver)).toEqual([])
    })
  })

  it('passes a pressKey step\'s modifiers, and a plain press with no second argument', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - pressKey: { code: KeyA, modifiers: [shift, meta] }\n  - pressKey: Enter\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(vi.mocked(driver.pressKey).mock.calls).toEqual([['KeyA', ['shift', 'meta']], ['Enter']])
    expect(result.steps.map((s) => s.name)).toEqual(['pressKey(shift+meta+KeyA)', 'pressKey(Enter)'])
  })

  it('clearState uses the flow appId, inline bundle id wins', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf(`
appId: com.example.app
steps:
  - clearState
  - clearState: com.other.app
`), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['clearState', 'com.example.app'], ['clearState', 'com.other.app']])
  })

  it('clearState with no app id anywhere fails the step instead of sending an empty payload', async () => {
    // Not reachable through `parseFlow`, which rejects the bare form without a flow-level appId — but `runFlow`
    // is exported and does not parse, so an embedder can hand it this. `flow.appId!` used to launder it into
    // `app:clear-state` with `payload: {}` and let the device answer 'bundleId missing' a network hop later.
    const driver = fakeDriver([[]])
    const result = await runFlow({ name: 'hand-built', steps: [{ type: 'clearState' }] }, driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('clearState has no app id')
    expect(driver.calls).toEqual([])
  })

  it('per-selector timeout overrides the default', async () => {
    const driver = fakeDriver([[]])
    const start = Date.now()
    const result = await runFlow(
      flowOf('steps:\n  - assertVisible:\n      label: x\n      timeout: 0.01\n'),
      driver,
      { pollIntervalMs: 1, defaultTimeoutMs: 5_000 },
    )
    expect(result.status).toBe('failed')
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('normalizes fractional default timeouts before using timer APIs', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, { defaultTimeoutMs: 1_234.5 })
    expect(result.status).toBe('passed')
  })

  it('reports step names and durations in results', async () => {
    const driver = fakeDriver([[el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - launchApp\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.steps[0]).toMatchObject({ name: 'launchApp', status: 'passed' })
    expect(result.steps[1].name).toBe('tapOn("OK")')
    expect(result.steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
  })

  it('a driver error on a step fails the flow with that error', async () => {
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new Error('agent offline') })
    const result = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('agent offline')
  })

  // Failure-kind routing (#543): the engine is what classifies, so consumers never branch on prose.
  it('marks an environment step failure as environment', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    driver.tap = vi.fn(async () => { throw new EnvironmentStepError('relay connection closed') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('relay connection closed')
  })

  it('marks selector and assertion failures as product', async () => {
    const missing = fakeDriver([[]])
    const missingResult = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n'), missing, OPTS)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.failureKind).toBe('product')

    const ambiguous = fakeDriver([[el({ label: 'x' }), el({ label: 'x' })]])
    const ambiguousResult = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), ambiguous, OPTS)
    expect(ambiguousResult.status).toBe('failed')
    expect(ambiguousResult.failureKind).toBe('product')
  })

  it('omits the failure kind on success', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(result.failureKind).toBeUndefined()
  })

  it('aborts a stalled failure screenshot instead of hanging the flow', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.openUrl = vi.fn(async () => { throw new Error('product failure') })
      let seenSignal: AbortSignal | undefined
      driver.screenshot = vi.fn((signal?: AbortSignal) => new Promise<Buffer>((_resolve, _reject) => {
        seenSignal = signal
      }))
      const pending = runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(result.failureScreenshot).toBeUndefined()
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(seenSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a product miss when a trailing transient blip hits the deadline', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      // Successful empty trees first (the element genuinely never matches),
      // then a transient blip exactly at the deadline.
      if (n++ < 3) return []
      throw new TransientQueryError('agent blip at deadline')
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
  })

  it('rejects timeouts that round to 0ms', async () => {
    const driver = fakeDriver([[]])
    await expect(runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, { defaultTimeoutMs: 0.4 })).rejects.toThrow(/at least 1ms/)
  })
})

// Deadline classification (#825): queryDeadlineFailure returns environment
// when no tree was ever seen, product once one was — across every poll loop
// that keeps its own sawTree state (resolveOne, waitVisible, waitNotVisible).
// Small real timeouts keep these deterministic: the loop can only end at the
// deadline with lastError set, so no timing decides the kind.
describe('query deadline classification', () => {
  const ABORT = 'query aborted at deadline'
  const QUERY_TIMEOUT = 'ui-tree query timed out'

  it('tapOn whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('assertVisible whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('assertNotVisible whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('tapOn whose query times out on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(QUERY_TIMEOUT) })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${QUERY_TIMEOUT}`)
  })

  it('tapOn that aborts after an earlier non-matching tree stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return [] // a tree was seen; the element genuinely never matched
      throw new TransientQueryError(ABORT)
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
  })

  it('assertVisible that times out after an earlier non-matching tree stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return []
      throw new TransientQueryError(QUERY_TIMEOUT)
    })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
  })

  it('assertNotVisible that aborts after an earlier tree showing the element stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    const tree = [el({ label: 'OK' })]
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return tree // the element is still visible; the abort cannot confirm it gone
      throw new TransientQueryError(ABORT)
    })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('still visible')
  })
})

// Evidence collection (#825): captureFailureScreenshot swallows its own
// failure, and failureKind is set before capture runs — so a rejecting
// screenshot cannot reclassify the step. Pins both kinds.
describe('rejected failure screenshot preserves classification', () => {
  it('leaves an environmental failureKind, message and failed step unchanged', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    driver.tap = vi.fn(async (): Promise<void> => { throw new EnvironmentStepError('relay connection closed') })
    driver.screenshot = vi.fn(async (): Promise<Buffer> => { throw new Error('screenshot backend down') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('relay connection closed')
    expect(result.failureMessage).not.toContain('screenshot backend down')
    expect(result.steps[0]).toMatchObject({ status: 'failed' })
    expect(result.steps[0]?.message).toContain('relay connection closed')
    expect(result.failureScreenshot).toBeUndefined()
  })

  it('leaves a product failureKind, message and failed step unchanged', async () => {
    const driver = fakeDriver([[]])
    driver.screenshot = vi.fn(async (): Promise<Buffer> => { throw new Error('screenshot backend down') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
    expect(result.failureMessage).not.toContain('screenshot backend down')
    expect(result.steps[0]).toMatchObject({ status: 'failed' })
    expect(result.steps[0]?.message).toContain('no element matched')
    expect(result.failureScreenshot).toBeUndefined()
  })
})

describe('runFlow onStep (the run video\'s timeline)', () => {
  it('marks each step\'s start and end, the failure, and nothing for skipped steps', async () => {
    const marks: unknown[] = []
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new Error('no such app') })
    await runFlow(parseFlow('steps:\n  - pressKey: Enter\n  - openUrl: "app://x"\n  - pressKey: Enter\n', 't.yaml'), driver, {
      pollIntervalMs: 1, defaultTimeoutMs: 20, onStep: (m) => marks.push(m),
    })
    expect(marks).toEqual([
      { index: 0, name: expect.any(String), phase: 'start', label: 'pressKey(Enter)' },
      { index: 0, name: expect.any(String), phase: 'end', status: 'passed' },
      { index: 1, name: expect.any(String), phase: 'start', label: 'openUrl' },
      { index: 1, name: expect.any(String), phase: 'end', status: 'failed' },
    ])
  })
})

describe('runFlow — hardware buttons, long press and pinch', () => {
  it('presses a button by name', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - pressButton: home\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['pressButton', 'home']])
  })

  it('waits for the element, then holds its center for the step\'s time', async () => {
    const driver = fakeDriver([[], [el({ label: 'Save' })]])
    const result = await runFlow(flowOf('steps:\n  - longPressOn: { on: "Save", durationMs: 1500 }\n'), driver, { ...OPTS, defaultTimeoutMs: 1000 })
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['longPress', 0.5, 0.55, 1500]])
    expect(result.steps[0]!.name).toBe('longPressOn("Save", 1500ms)')
  })

  // The scale is what the person meant, so it is kept exactly; the spacing is what adapts to the screen.
  it('pinches about the element\'s center by exactly the scale, fingers mirrored and on the screen', async () => {
    for (const [yaml, scale] of [['scale: 2', 2], ['scale: 0.5', 0.5], ['scale: 10', 10]] as const) {
      const driver = fakeDriver([[el({ label: 'Map', frame: { x: 0.2, y: 0.3, width: 0.6, height: 0.4 } })]])
      const result = await runFlow(flowOf(`steps:\n  - pinch: { on: Map, ${yaml} }\n`), driver, OPTS)
      expect(result.status).toBe('passed')
      const [, start, end, ms] = driver.calls[0] as [string, PinchFingers, PinchFingers, number]
      expect(ms).toBe(500)
      const gap = (f: PinchFingers) => Math.hypot(f[1][0] - f[0][0], f[1][1] - f[0][1])
      expect(gap(end) / gap(start)).toBeCloseTo(scale, 6)
      for (const f of [start, end]) {
        expect((f[0][0] + f[1][0]) / 2).toBeCloseTo(0.5, 6)
        expect((f[0][1] + f[1][1]) / 2).toBeCloseTo(0.5, 6)
        for (const [x, y] of f) for (const v of [x, y]) expect(v >= 0 && v <= 1).toBe(true)
      }
    }
  })

  it('fits the fingers to a point near an edge by spreading them along the other axis', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - pinch: { on: [0.95, 0.5], scale: 3 }\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    const [, start, end] = driver.calls[0] as [string, PinchFingers, PinchFingers]
    for (const f of [start, end]) for (const [x, y] of f) {
      expect(x).toBeCloseTo(0.95, 6)
      expect(y >= 0 && y <= 1).toBe(true)
    }
  })

  it('fails a pinch it cannot fit on the screen, and says why, without touching the device', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - pinch: { on: [0.99, 0.01], scale: 2 }\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/too close to the edge of the screen/)
    expect(driver.calls).toEqual([])
  })

  it('names the steps for watchers', async () => {
    const marks: Record<string, unknown>[] = []
    const driver = fakeDriver([[el({ label: 'Map' })]])
    await runFlow(flowOf('steps:\n  - pressButton: volume_up\n  - longPressOn: Map\n  - pinch: { on: Map, scale: 2 }\n  - pinch: { on: [0.5, 0.5], scale: 0.5 }\n'), driver, { ...OPTS, onStep: (m) => marks.push(m) })
    expect(marks.filter((m) => m['phase'] === 'start').map((m) => m['label'])).toEqual([
      'pressButton(volume_up)', 'longPressOn("Map", 1000ms)', 'pinch("Map", ×2)', 'pinch([0.5,0.5], ×0.5)',
    ])
  })
})

// D1: a flow pressing a button the device lacks is refused before its first step, rather than answered with a press
// that did nothing and failed one step later under the wrong name.
describe('runFlow — a button the device lacks', () => {
  const backFlow = 'steps:\n  - tapOn: ok\n  - pressButton: back\n  - assertVisible: Home\n'

  it('refuses a platform\'s missing button before anything reaches the device', async () => {
    const driver = fakeDriver([[el({ label: 'ok' })]])
    const result = await runFlow(flowOf(backFlow), driver, { ...OPTS, platform: 'ios' })
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failedBeforeRun).toBe(true)
    expect(result.failureMessage).toMatch(/^pressButton\(back\): iOS has no "back" button/)
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'failed', 'skipped'])
    expect(driver.calls).toEqual([])
    expect(driver.screenshot).not.toHaveBeenCalled()
  })

  it('runs the same flow where the button exists', async () => {
    const driver = fakeDriver([[el({ label: 'ok' }), el({ label: 'Home' })]])
    const result = await runFlow(flowOf(backFlow), driver, { ...OPTS, platform: 'android' })
    expect(result.status).toBe('passed')
    expect(result.failedBeforeRun).toBeUndefined()
  })

  it('asks an iOS device\'s chrome about a button that depends on it', async () => {
    const has = fakeDriver([[]])
    has.chrome = vi.fn(async () => iosChrome(chromeButton('power', 48)))
    expect((await runFlow(flowOf('steps:\n  - pressButton: lock\n'), has, { ...OPTS, platform: 'ios' })).status).toBe('passed')

    const lacks = fakeDriver([[]])
    lacks.chrome = vi.fn(async () => iosChrome(chromeButton('power', 0)))
    const refused = await runFlow(flowOf('steps:\n  - pressButton: lock\n'), lacks, { ...OPTS, platform: 'ios' })
    expect(refused.failureMessage).toMatch(/this device has no "lock" button/)
    expect(refused.failedBeforeRun).toBe(true)
    expect(lacks.calls).toEqual([])
  })

  it('fails as the environment when the device never says which buttons it has', async () => {
    const driver = fakeDriver([[]])
    driver.chrome = vi.fn(async () => null)
    const result = await runFlow(flowOf('steps:\n  - pressButton: volume_up\n'), driver, { ...OPTS, platform: 'ios' })
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toMatch(/did not report its buttons/)
    // Not the flow's fault, so not marked as one: a device that will not describe itself may be a device to leave.
    expect(result.failedBeforeRun).toBeUndefined()
    expect(driver.calls).toEqual([])
  })

  it('marks the press it could not check, not an earlier one that needed no checking', async () => {
    const driver = fakeDriver([[]])
    driver.chrome = vi.fn(async () => null)
    const result = await runFlow(flowOf('steps:\n  - pressButton: home\n  - pressButton: volume_up\n'), driver, { ...OPTS, platform: 'ios' })
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'failed'])
  })

  // A session that ends while its chrome is awaited is a result for this flow, so the run can record it and go on.
  it('reports a session lost while asking for the chrome as the flow\'s environment failure, not a rejection', async () => {
    const driver = fakeDriver([[]])
    driver.chrome = vi.fn(async () => { throw new Error('device chrome failed: the relay ended this session') })
    const result = await runFlow(flowOf('steps:\n  - pressButton: lock\n'), driver, { ...OPTS, platform: 'ios' })
    expect(result).toMatchObject({ status: 'failed', failureKind: 'environment' })
    expect(result.failureMessage).toMatch(/could not be checked: device chrome failed: the relay ended this session/)
    expect(result.failedBeforeRun).toBeUndefined()
  })

  it('does not ask the chrome for a flow that presses nothing, nor check a platform it has no table for', async () => {
    const driver = fakeDriver([[el({ label: 'ok' })]])
    driver.chrome = vi.fn(async () => null)
    expect((await runFlow(flowOf('steps:\n  - tapOn: ok\n'), driver, { ...OPTS, platform: 'ios' })).status).toBe('passed')
    expect((await runFlow(flowOf('steps:\n  - pressButton: back\n'), driver, { ...OPTS, platform: 'tvos' })).status).toBe('passed')
    expect((await runFlow(flowOf('steps:\n  - pressButton: back\n'), driver, OPTS)).status).toBe('passed')
    expect(driver.chrome).not.toHaveBeenCalled()
  })
})

describe('runFlow — orientation and posture', () => {
  it('asks the driver to turn and fold, with the step timeout, and names the steps', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - setOrientation: landscape\n  - setPosture: unfolded\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['setOrientation', 'landscape', 20], ['setPosture', 'unfolded', 20]])
    expect(result.steps.map((s) => s.name)).toEqual(['setOrientation(landscape)', 'setPosture(unfolded)'])
  })

  // A device that cannot fold is not a broken device: the flow fails as the environment's, and the device is kept.
  it('marks a step the device cannot do as deviceLacks, and an ordinary environment failure not', async () => {
    const lacks = fakeDriver([[]])
    lacks.setPosture = vi.fn(async () => { throw new DeviceLacksError('setPosture: no postures') })
    const a = await runFlow(flowOf('steps:\n  - setPosture: folded\n'), lacks, OPTS)
    expect(a).toMatchObject({ status: 'failed', failureKind: 'environment', deviceLacks: true })

    const broken = fakeDriver([[]])
    broken.setOrientation = vi.fn(async () => { throw new EnvironmentStepError('did not turn') })
    const b = await runFlow(flowOf('steps:\n  - setOrientation: landscape\n'), broken, OPTS)
    expect(b.failureKind).toBe('environment')
    expect(b.deviceLacks).toBeUndefined()
  })
})

describe('points and secrets', () => {
  it('taps and holds a point as written, without reading the tree for it', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: [0.4, 0.6]\n  - longPressOn: { on: [0.1, 0.2], durationMs: 700 }\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.4, 0.6], ['longPress', 0.1, 0.2, 700]])
    expect(result.steps.map((s) => s.name)).toEqual(['tapOn([0.4,0.6])', 'longPressOn([0.1,0.2], 700ms)'])
  })

  it('types a secret it was given, and names it nowhere by value', async () => {
    const driver = fakeDriver([[]])
    const marks: Array<{ name: string; label?: string }> = []
    const result = await runFlow(flowOf('steps:\n  - inputText: { secret: PASSWORD }\n'), driver,
      { ...OPTS, secrets: { PASSWORD: 'hunter2' }, onStep: (m) => marks.push(m) })
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['inputText', 'hunter2']])
    expect(result.steps[0]!.name).toBe('inputText(secret PASSWORD)')
    expect(marks[0]!.label).toBe('inputText (secret)')
    expect(JSON.stringify({ result, marks })).not.toContain('hunter2')
  })

  it('refuses a flow naming a secret it was not given, before anything reaches the device', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: [0.4, 0.6]\n  - inputText: { secret: PASSWORD }\n'), driver,
      { ...OPTS, secrets: { OTHER: 'x' } })
    expect(driver.calls).toEqual([])
    expect(result.failureKind).toBe('environment')
    expect(result.failedBeforeRun).toBe(true)
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'failed'])
    expect(result.failureMessage).toMatch(/secret PASSWORD was not given to this run.*--secret PASSWORD/)
  })

  it('keeps the value out of a failure whose driver quoted it, and keeps the failure\'s kind', async () => {
    const driver = fakeDriver([[]])
    vi.mocked(driver.inputText).mockRejectedValueOnce(markEnvironmentFailure(new Error('Command failed: adb shell input text hunter2')))
    const result = await runFlow(flowOf('steps:\n  - inputText: { secret: PASSWORD }\n'), driver, { ...OPTS, secrets: { PASSWORD: 'hunter2' } })
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toBe('inputText(secret PASSWORD): typing the secret PASSWORD failed')
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  it('names no input\'s or secure element\'s label among the candidates of an ambiguous match', async () => {
    const driver = fakeDriver([[el({ role: 'input', label: 'hunter2', identifier: 'pw' }), el({ role: 'other', label: '••••', secure: true, identifier: 'pw' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: { id: pw }\n'), driver, OPTS)
    expect(result.failureMessage).toMatch(/candidates/)
    expect(result.failureMessage).not.toMatch(/hunter2|••••/)
  })

  it('refuses it with no secrets at all, as run_flow runs', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - inputText: { secret: TAPFLOW_TOKEN }\n'), driver, OPTS)
    expect(driver.calls).toEqual([])
    expect(result.failedBeforeRun).toBe(true)
  })
})
