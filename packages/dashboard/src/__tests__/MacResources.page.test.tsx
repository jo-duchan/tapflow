import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { focusManager, notifyManager } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import { MacResources } from '@/src/pages/MacResources'
import { withQuery } from './withQuery'
import { HISTORY_POLL_MS, flowIntervalMs, type Range } from '@/lib/resource-chart'
import { SKELETON_DELAY_MS } from '@/hooks/useShownAfter'

/** Skeleton bars on screen — laid out but `invisible` ones hold space without being seen. */
const visibleBars = () => [...document.querySelectorAll('.animate-pulse')].filter((el) => !el.closest('.invisible'))
const allBars = () => document.querySelectorAll('.animate-pulse')
import type { AgentResources, BrowserInbound, SessionInfo } from '@/lib/types'

// The page is where the chart's inputs change over time — the clock, the history, the live report — and
// each of those used to be read once. `AreaChartInner` is pure and tested on its own; this file holds the
// wiring that feeds it, which is where #751 lived.

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
let deliver: ((msg: BrowserInbound) => void) | null = null
vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
// `ParentSize` measures 0 in jsdom and renders nothing, so without a size the page has no chart to assert on.
vi.mock('@visx/responsive', () => ({
  ParentSize: ({ children }: { children: (size: { width: number; height: number }) => ReactNode }) =>
    children({ width: 600, height: 220 }),
}))

// A whole-hour zone, so which tick sits nearest an edge does not depend on the machine running this.
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Asia/Seoul'
  // TanStack Query hands results to React on a timer of its own. Under this file's fake timers that timer
  // ran whenever the event loop happened to turn, so a result could land or not depending on the tests
  // before it. A microtask is flushed by every `advanceTimersByTimeAsync`, which makes the order fixed.
  notifyManager.setScheduler(queueMicrotask)
})
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0))
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

const T = Date.parse('2026-08-18T02:56:01.000Z')

interface Row { cpu_percent: number; mem_percent: number; recorded_at: string }
type Reply = Promise<{ ok: boolean; json: () => Promise<unknown> }>

const rows = (cpu: number, n = 5): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    cpu_percent: cpu,
    mem_percent: 50,
    recorded_at: new Date(Date.now() - 60_000 - (n - 1 - i) * 60_000).toISOString(),
  }))
const ok = (body: unknown): Reply => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
function deferred() {
  let resolve!: (body: unknown) => void
  const promise: Reply = new Promise((r) => { resolve = (body) => r({ ok: true, json: () => Promise.resolve(body) }) })
  return { promise, resolve }
}

let knownAgents: string[] = []
let respond: (range: string, agent: string) => Reply = () => ok(rows(20))
const resourceCalls: string[] = []
/** Each history request's abort signal, in the order they were sent. */
const signals: AbortSignal[] = []

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T)
  knownAgents = ['studio-mac']
  respond = () => ok(rows(20))
  resourceCalls.length = 0
  signals.length = 0
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/v1/agents') return ok(knownAgents)
    if (init?.signal) signals.push(init.signal)
    const m = /^\/api\/v1\/agents\/([^/]+)\/resources\?range=(\w+)$/.exec(input)
    if (!m) return Promise.reject(new Error(`unexpected fetch ${input}`))
    const agent = decodeURIComponent(m[1]!)
    resourceCalls.push(`${agent}:${m[2]}`)
    return respond(m[2]!, agent)
  }))
})
afterEach(() => {
  setVisibility('visible')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const flush = () => advance(0)
async function mount({ gcTime = 0 }: { gcTime?: number } = {}) {
  const utils = render(withQuery(<BreadcrumbProvider><MacResources /></BreadcrumbProvider>, { gcTime }))
  await flush()
  await flush()
  return utils
}
const cpuChart = (c: HTMLElement) => c.querySelector('svg[aria-label^="CPU %"]')
const tickXs = (c: HTMLElement) =>
  [...(cpuChart(c)?.querySelectorAll('.visx-axis-bottom text') ?? [])].map((t) => Number(t.getAttribute('x')))
/** One tick's x, found by its label — not by position in the list, which shifts when the oldest tick leaves
 *  the window. 15:00 is mid-window on 24h in Seoul at `T`, far from either edge. */
const xOfTick = (c: HTMLElement, label: string) =>
  Number([...(cpuChart(c)?.querySelectorAll('.visx-axis-bottom text') ?? [])].find((t) => t.textContent === label)?.getAttribute('x'))
/** The live value each chart ends at: its dot drawn, and its value in the chart's name — the value is
 *  printed nowhere on the plot, so the reading is where it is found. */
const heads = (c: HTMLElement) =>
  [...c.querySelectorAll('svg[role="group"]')].flatMap((s) => {
    const now = /Now ([\d.]+%)/.exec(s.getAttribute('aria-label') ?? '')?.[1]
    return now && s.querySelector('.live-head') ? [now] : []
  })
async function selectRange(r: Range) {
  // Radix activates a tab on mousedown, not click.
  await act(async () => { fireEvent.mouseDown(screen.getByRole('tab', { name: r }), { button: 0 }) })
  await flush()
}
const report = (over: Partial<AgentResources> = {}): AgentResources => ({
  cpuPercent: 42.34, memUsedMB: 8000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: Date.now() - 5_000, ...over,
})
const listed = (sessions: SessionInfo[]) => act(async () => { deliver!({ type: 'agents:listed', sessions }) })
const agent = (agentName: string, resources?: AgentResources): SessionInfo => ({
  agentName, platform: 'ios', capabilities: [], admission: { booting: false, overloaded: false, memoryRefuses: [] }, devices: [], resources,
})

it('names the resource history tabs Time range', async () => {
  await mount()
  expect(screen.getByRole('tablist', { name: 'Time range' })).toBeInTheDocument()
})

describe('the history refreshes without the chart going blank', () => {
  it('polls on the cadence chosen for each range', () => {
    // The relay writes a row a minute, so polling faster re-fetches identical data; the long ranges
    // re-send thousands of rows to gain one, and the live head covers the recent end of them anyway.
    expect(HISTORY_POLL_MS).toEqual({ '1h': 60_000, '6h': 60_000, '24h': 300_000, '7d': 900_000 })
  })

  it.each(['1h', '6h', '24h', '7d'] as const)('re-fetches %s history once per interval, and no sooner', async (r) => {
    await mount()
    if (r !== '24h') await selectRange(r)
    const calls = () => resourceCalls.filter((c) => c === `studio-mac:${r}`).length
    expect(calls()).toBe(1)
    await advance(HISTORY_POLL_MS[r] - 1)
    expect(calls()).toBe(1)
    await advance(1)
    expect(calls(), 'the history was never fetched again — the chart is frozen where it loaded').toBe(2)
  })

  it('keeps the chart up while a refresh is in flight', async () => {
    const { container } = await mount()
    const pending = deferred()
    respond = () => pending.promise
    await advance(HISTORY_POLL_MS['24h'])
    expect(resourceCalls).toHaveLength(2)
    expect(screen.queryByText('Loading…'), 'a background refresh replaced the chart with a spinner').toBeNull()
    expect(cpuChart(container)).not.toBeNull()

    await act(async () => {
      pending.resolve(rows(70))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cpuChart(container)!.getAttribute('aria-label')).toContain('Latest 70%')
  })

  it.each([
    ['an error status', (): Reply => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) })],
    ['a network failure', (): Reply => Promise.reject(new TypeError('Failed to fetch'))],
  ])('keeps the last good history through %s', async (_, fail) => {
    const { container } = await mount()
    respond = fail
    await advance(HISTORY_POLL_MS['24h'])
    expect(resourceCalls).toHaveLength(2)
    expect(screen.queryByText(/No data yet/), 'one failed refresh emptied the chart').toBeNull()
    expect(cpuChart(container)!.getAttribute('aria-label')).toContain('Latest 20%')
  })

  it('still settles on the empty state when the first load fails, rather than loading forever', async () => {
    respond = () => Promise.reject(new TypeError('Failed to fetch'))
    await mount()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText(/No data yet/)).toBeInTheDocument()
  })

  it('shows loading when the range changes, until that range answers', async () => {
    await mount()
    const pending = deferred()
    respond = () => pending.promise
    await selectRange('7d')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await act(async () => {
      pending.resolve(rows(70))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('ignores a response for a range the reader has already left', async () => {
    const slow = deferred()
    respond = (range) => (range === '24h' ? slow.promise : ok(rows(70)))
    const { container } = await mount()
    await selectRange('7d')
    expect(cpuChart(container)!.getAttribute('aria-label')).toMatch(/last 7d\. Latest 70%/)

    await act(async () => {
      slow.resolve(rows(20))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cpuChart(container)!.getAttribute('aria-label'), 'the abandoned 24h response replaced the 7d history')
      .toMatch(/last 7d\. Latest 70%/)
  })

  it('keeps the newer of two refreshes that answer out of order', async () => {
    const { container } = await mount()
    const slow = deferred()
    respond = () => slow.promise
    await advance(HISTORY_POLL_MS['24h'])
    respond = () => ok(rows(70))
    await advance(HISTORY_POLL_MS['24h'])
    expect(cpuChart(container)!.getAttribute('aria-label')).toContain('Latest 70%')

    await act(async () => {
      slow.resolve(rows(20))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cpuChart(container)!.getAttribute('aria-label'), 'an older refresh overwrote a newer one').toContain('Latest 70%')
  })
})

describe('the axis flows with time', () => {
  it.each(['1h', '6h', '24h', '7d'] as const)('advances %s by itself, once per interval', async (r) => {
    // #751: the window's edge was the moment of the fetch, so an open page kept that moment forever. Every
    // range, because the cadence is chosen per range and the page is what hands it to the clock.
    const { container } = await mount()
    if (r !== '24h') await selectRange(r)
    const labelled = () =>
      new Map([...(cpuChart(container)?.querySelectorAll('.visx-axis-bottom text') ?? [])].map((t) => [t.textContent ?? '', Number(t.getAttribute('x'))]))
    const mid = [...labelled()].filter(([, x]) => x > 50 && x < 600 - 40 - 24 - 50)
    const [label, x] = mid[Math.floor(mid.length / 2)]!
    await advance(flowIntervalMs(r) - 1)
    expect(labelled().get(label), `the ${r} axis moved before its interval`).toBe(x)
    await advance(1)
    expect(labelled().get(label), `the ${r} axis did not move on its interval`).toBeLessThan(x)
  })

  it('stops while the tab is hidden, and catches up the moment it is shown', async () => {
    const { container } = await mount()
    await act(async () => { setVisibility('hidden') })
    const before = tickXs(container)
    const at1500 = xOfTick(container, '15:00')

    await advance(HISTORY_POLL_MS['24h'] * 2)
    expect(resourceCalls, 'history was fetched for a tab nobody can see').toHaveLength(1)
    expect(tickXs(container), 'the axis kept advancing in a hidden tab').toEqual(before)

    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resourceCalls, 'showing the tab did not refresh the history').toHaveLength(2)
    // Ten minutes on 24h is ~3.4px: the tick must have moved by that, not merely by something.
    expect(at1500 - xOfTick(container, '15:00'), 'showing the tab did not bring the axis up to now')
      .toBeCloseTo((HISTORY_POLL_MS['24h'] * 2 / 86_400_000) * (600 - 40 - 24), 3)
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('does not re-fetch on return when the history is younger than its interval', async () => {
    // Switching tabs is not a reason to re-send the whole window — about 10,080 rows on 7d. The live head
    // covers the recent end, so the history waits out the rest of its interval.
    await mount()
    await act(async () => { setVisibility('hidden') })
    await advance(60_000)
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resourceCalls, 'returning to the tab re-fetched a history a minute old').toHaveLength(1)
    await advance(HISTORY_POLL_MS['24h'] - 60_000 - 1)
    expect(resourceCalls).toHaveLength(1)
    await advance(1)
    expect(resourceCalls, 'the rest of the interval never came due').toHaveLength(2)
  })

  it('draws two chart skeletons while history loads, only after the delay', async () => {
    const slow = deferred()
    respond = () => slow.promise
    await mount()
    expect(screen.getByText('Loading…')).toHaveClass('sr-only')
    expect(visibleBars()).toHaveLength(0)
    // Two cards' worth of space is held from the start, so the page does not collapse during the wait.
    expect(allBars()).toHaveLength(6)
    await act(async () => { await vi.advanceTimersByTimeAsync(SKELETON_DELAY_MS) })
    // Dot, title and plot in each of the two cards.
    expect(visibleBars()).toHaveLength(6)
  })

  it('keeps the skeleton up when the range changes during a load, rather than blanking it', async () => {
    // The skeleton is the same for every range, so a second wait would only blink it off and on.
    respond = () => deferred().promise
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(SKELETON_DELAY_MS) })
    expect(visibleBars()).toHaveLength(6)
    await selectRange('6h')
    expect(visibleBars()).toHaveLength(6)
  })

  it('loads at once on return if hiding the tab cut the first load short', async () => {
    // A history's age is taken from when a load finished. Taken from when it started, a first load aborted
    // by hiding the tab would count as fresh, and the page would sit on Loading for the rest of the interval.
    const slow = deferred()
    respond = () => slow.promise
    await mount()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await act(async () => { setVisibility('hidden') })
    respond = () => ok(rows(20))
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resourceCalls).toHaveLength(2)
    expect(screen.queryByText('Loading…'), 'the page waited out an interval for a load that never finished').toBeNull()
  })
})

describe('the live head', () => {
  it('ends both lines at the selected Mac\'s latest report', async () => {
    const { container } = await mount()
    expect(heads(container)).toEqual([])
    await listed([agent('studio-mac', report())])
    expect(heads(container)).toEqual(['42.3%', '50%'])
  })

  it('goes away once the Mac stops reporting, without waiting for the next listing', async () => {
    const { container } = await mount()
    await listed([agent('studio-mac', report())])
    expect(heads(container)).toHaveLength(2)
    // Reported 5s ago. The clock it is judged against ticks every 10s on 24h, so it survives to 25s old and
    // is gone at the tick after it turns 30 — within 40s, the bound the QA Session cards give.
    await advance(20_000)
    expect(heads(container), 'dropped before it was stale').toHaveLength(2)
    await advance(10_000)
    expect(heads(container), 'a Mac that went silent kept a live value').toEqual([])
  })

  it('never shows one Mac\'s live value on another Mac\'s chart', async () => {
    knownAgents = ['studio-mac', 'lab-mac']
    const { container } = await mount()
    await listed([agent('studio-mac', report({ cpuPercent: 88 }))])
    expect(heads(container)).toContain('88%')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /lab-mac/ })) })
    await flush()
    expect(cpuChart(container), 'lab-mac\'s history did not load').not.toBeNull()
    expect(heads(container)).toEqual([])
  })

  it('does not stand in for history that has not been written yet', async () => {
    respond = () => ok([])
    const { container } = await mount()
    await listed([agent('studio-mac', report())])
    expect(screen.getByText(/No data yet/)).toBeInTheDocument()
    expect(heads(container)).toEqual([])
  })
})

describe('what moving the history to TanStack Query had to keep (#845)', () => {
  it('abandons the request in flight when the tab is hidden', async () => {
    // About 10,080 rows on 7d: a tab nobody can see should not keep receiving them.
    const slow = deferred()
    respond = () => slow.promise
    await mount()
    expect(signals.at(-1)?.aborted).toBe(false)
    await act(async () => { setVisibility('hidden') })
    expect(signals.at(-1)?.aborted, 'hiding the tab left the history request running').toBe(true)
  })

  it('replaces a first load that hangs on the next tick, instead of loading forever', async () => {
    // `cancelRefetch` only replaces a refetch of a query that has rows; a first load that never answers
    // was joined by every tick, and the chart said Loading until the tab was hidden.
    respond = () => new Promise(() => {})
    await mount()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    respond = () => ok(rows(20))
    await advance(HISTORY_POLL_MS['24h'])
    expect(resourceCalls).toHaveLength(2)
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('asks again at once for a range that has only ever failed', async () => {
    respond = (range) => (range === '24h' ? Promise.reject(new TypeError('Failed to fetch')) : ok(rows(20)))
    // The app keeps a key's state for five minutes after leaving it; the failure has to still be there.
    await mount({ gcTime: 5 * 60_000 })
    expect(screen.getByText(/No data yet/)).toBeInTheDocument()
    await selectRange('1h')
    respond = () => ok(rows(20))
    await selectRange('24h')
    expect(resourceCalls.filter((c) => c.endsWith(':24h'))).toHaveLength(2)
    expect(screen.queryByText(/No data yet/)).toBeNull()
  })

  it('does not move the default chart when the window regains focus', async () => {
    // The relay lists Macs alphabetically, and only once one has reported; refetched on focus, a new
    // name sorting first would have become the default.
    knownAgents = ['studio-mac']
    await mount()
    knownAgents = ['a-new-mac', 'studio-mac']
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await flush()
    expect(screen.getByRole('heading', { level: 2, name: 'studio-mac' })).toBeInTheDocument()
    focusManager.setFocused(undefined)
  })

  it('keeps the Mac it defaulted to when another one connects', async () => {
    // The sidebar lists connected Macs first; a default taken from that order would move the chart to
    // whichever Mac connected last, without anyone picking it.
    knownAgents = ['studio-mac', 'lab-mac']
    await mount()
    expect(screen.getByRole('heading', { level: 2, name: 'studio-mac' })).toBeInTheDocument()
    await listed([agent('lab-mac', report())])
    await flush()
    expect(screen.getByRole('heading', { level: 2, name: 'studio-mac' })).toBeInTheDocument()
    expect(resourceCalls.every((c) => c.startsWith('studio-mac:'))).toBe(true)
  })
})
