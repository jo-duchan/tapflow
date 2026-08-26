import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

// #679 — the simulator viewer kept its desktop sizing on narrow (mobile) viewports and forced
// horizontal scroll. `widthBudget` (measured by QASession around the viewer) lets IOSViewer /
// AndroidViewer shrink below their height-only cap when the available width is the tighter
// constraint. These drive the real DeviceViewer → IOSViewer/AndroidViewer path so what's pinned is
// the actual rendered box, not just the pure `widthFitScale` math (covered separately in
// coordinate-transform.test.ts).
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send: vi.fn(), connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

// compositeLogicalW/H = 390/844 — iPhone-14-scale, so MAX_DISPLAY_H's height-only cap and the
// width budget can actually compete the way they would on a real phone.
const IOS_CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 780, compositeHeight: 1688,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 780, height: 1688 },
  screenCornerRadius: 0, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

const ANDROID_CHROME = {
  buttons: [], streamType: 'h264' as const,
  screenWidth: 1080, screenHeight: 2400, cornerRadius: 0,
}

function renderWithChrome(chrome: typeof IOS_CHROME | typeof ANDROID_CHROME, widthBudget?: number) {
  const view = render(<DeviceViewer sessionId="mine" deviceId="dev-1" widthBudget={widthBudget} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: chrome }) })
  return view
}

describe('DeviceViewer width budget — iOS', () => {
  beforeEach(() => { deliver = null })

  it('a spacious budget leaves the height-only cap in charge (desktop regression)', () => {
    renderWithChrome(IOS_CHROME, 1200)
    const width = Number(screen.getByTestId('ios-screen-area').style.width.replace('px', ''))
    // heightScale = min(1, 750/844); displayW = round(390 * heightScale)
    expect(width).toBe(Math.round(390 * Math.min(1, 750 / 844)))
  })

  it('a narrow budget shrinks the viewer below the height-only cap', () => {
    const spacious = renderWithChrome(IOS_CHROME, 1200)
    const spaciousWidth = Number(screen.getByTestId('ios-screen-area').style.width.replace('px', ''))
    spacious.unmount()

    // 200 is well under fitsSideBySide's threshold, so the toolbar/card stack instead of
    // competing with the device for this budget — the device gets (almost) the whole 200.
    renderWithChrome(IOS_CHROME, 200)
    const narrowWidth = Number(screen.getByTestId('ios-screen-area').style.width.replace('px', ''))

    expect(narrowWidth).toBeLessThan(spaciousWidth)
    expect(narrowWidth).toBeLessThanOrEqual(200)
  })

  it('no budget measured yet (0) falls back to the unconstrained desktop size', () => {
    renderWithChrome(IOS_CHROME, 0)
    const width = Number(screen.getByTestId('ios-screen-area').style.width.replace('px', ''))
    expect(width).toBe(Math.round(390 * Math.min(1, 750 / 844)))
  })
})

describe('DeviceViewer width budget — Android', () => {
  beforeEach(() => { deliver = null })

  it('a narrow budget shrinks the viewer below the long-side cap', () => {
    const spacious = renderWithChrome(ANDROID_CHROME, 1200)
    const spaciousWidth = Number(screen.getByTestId('android-screen-area').style.width.replace('px', ''))
    spacious.unmount()

    // 200 is well under fitsSideBySide's threshold, so the toolbar/card stack instead of
    // competing with the device for this budget.
    renderWithChrome(ANDROID_CHROME, 200)
    const narrowWidth = Number(screen.getByTestId('android-screen-area').style.width.replace('px', ''))

    expect(narrowWidth).toBeLessThan(spaciousWidth)
    expect(narrowWidth).toBeLessThanOrEqual(200)
  })

  it("reserves its always-present bezel padding, not just the screen area (CodeRabbit on #680)", () => {
    // Naive screen-only width at this budget would round up to exactly 200 with no bezel
    // reserved; reserving the real 24px bezel must bring it below that.
    renderWithChrome(ANDROID_CHROME, 200)
    const width = Number(screen.getByTestId('android-screen-area').style.width.replace('px', ''))
    expect(width).toBeLessThan(200)
  })
})

describe('DeviceViewer width budget — the toolbar/card row itself (#680)', () => {
  beforeEach(() => { deliver = null })

  // CodeRabbit on #680: at a 1024px viewport with a 320px session panel beside the viewer, the
  // measured budget is ~607px — comfortably more than the device box alone needs, but not enough
  // for the full toolbar+device+card row once everything unstacks at the same `lg` breakpoint.
  const BORDERLINE_BUDGET = 607

  it('iOS: stacks the toolbar/card row instead of overflowing at a borderline budget', () => {
    renderWithChrome(IOS_CHROME, BORDERLINE_BUDGET)
    const row = screen.getByTestId('ios-screen-area').parentElement!
    expect(row.className).toMatch(/\bflex-col\b/)
  })

  it('iOS: a spacious budget keeps the row side by side', () => {
    renderWithChrome(IOS_CHROME, 1200)
    const row = screen.getByTestId('ios-screen-area').parentElement!
    expect(row.className).not.toMatch(/\bflex-col\b/)
  })

  it('Android: stacks the toolbar/card row instead of overflowing at a borderline budget', () => {
    renderWithChrome(ANDROID_CHROME, BORDERLINE_BUDGET)
    const row = screen.getByTestId('android-screen-area').parentElement!.parentElement!
    expect(row.className).toMatch(/\bflex-col\b/)
  })
})
