import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * **The iOS half of the recording and rotation contract.**
 *
 * `IOSViewer` took the same two changes `AndroidViewer` did — the recorder is handed its composer
 * through `setComposeFrame` instead of through `startClientRecording`, and the cleanup that puts a
 * rotated simulator back upright keeps its body in a ref so its dependency list is honestly empty.
 * Neither was held by anything: `input:rotate` appeared in no test in this package, and the four
 * files that render this component through `DeviceViewer` never record.
 *
 * Both mutations were measured green across all 681 tests before this file existed. The second is
 * the worse one, and it is this branch that made it quiet: `startClientRecording(composeFrame)`
 * used to require the composer, so losing it was a type error. Now a cleanup pass that deletes the
 * registration effect and its unused destructure leaves a green typecheck, a silent lint, and a
 * recording of a black canvas.
 */

type Compose = () => void

const { recordCanvas, captured } = vi.hoisted(() => ({
  recordCanvas: { current: null as HTMLCanvasElement | null },
  captured: { compose: null as Compose | null, started: false, recordState: 'idle' as 'idle' | 'recording' },
}))

// Stable, like the real hook's `useCallback(…, [])` — see the note in
// `AndroidViewer.composeFrame.test.tsx`: unstable mocks make every dependency array containing
// them change every render, which hides a missing dependency.
const stableSetComposeFrame = (compose: Compose) => { captured.compose = compose }
const stableStart = () => { captured.started = true }
const stableStop = () => {}

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    get recordState() { return captured.recordState },
    recordCanvasRef: recordCanvas,
    setComposeFrame: stableSetComposeFrame,
    startClientRecording: stableStart,
    stopClientRecording: stableStop,
  }),
}))

vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'

const chrome = {
  framePng: 'data:image/png;base64,', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

function renderViewer(over: Record<string, unknown> = {}) {
  const send = vi.fn()
  const props = {
    sessionId: 's1',
    send,
    openUrl: vi.fn(),
    launchApp: vi.fn(),
    connected: true,
    joined: true,
    deviceReady: true,
    installing: false,
    installed: true,
    installError: null,
    bootError: null,
    launching: false,
    chrome,
    binaryFrameHandlerRef: { current: undefined },
    clipboardHandlerRef: { current: undefined },
    clipboardSupported: true,
    networkHandlerRef: { current: undefined },
    networkSupported: false,
    swKeyboardVisible: false,
    swKeyboardPending: false,
    onKbdToggle: vi.fn(),
    rebootPending: false,
    onReboot: vi.fn(),
    restartButtonRef: { current: null },
    ...over,
  // The prop surface is wide and none of it is what this file is about; the cast keeps the fixture
  // from restating types the component already owns.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  return { ...render(<IOSViewer {...props} />), send, props }
}

/** The `input:rotate` messages `send` was given, in order. */
const rotateCalls = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:rotate')

const rotateButton = () => screen.getByRole('button', { name: /rotate the device/i })

/** Runs `body` with every element laid out at 300×600 — jsdom lays out nothing. */
function withLaidOutDevice(body: () => void) {
  const size = { clientWidth: 300, clientHeight: 600 }
  const saved = Object.fromEntries(Object.keys(size).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]))
  for (const [k, v] of Object.entries(size)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  try { body() } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
    }
  }
}

describe('IOSViewer — the recorder gets a composer, and the simulator gets put back', () => {
  beforeEach(() => { captured.compose = null; captured.started = false; captured.recordState = 'idle'; recordCanvas.current = null })
  afterEach(() => vi.restoreAllMocks())

  it('hands the recorder a composer on mount', () => {
    // Deleting the registration effect is a silent black recording, not a build failure — which is
    // exactly what the move from an argument to a setter cost. This is what says it happened.
    renderViewer()
    expect(captured.compose).toBeTypeOf('function')
  })

  // A recording is the device as it is shown. It used to be the device as it is drawn before the turn — an
  // unfolded Duo, or any iPhone turned on its side, was recorded sideways. Mutations: compose unturned; size
  // the canvas to the unturned device.
  it('records the device turned the way it is shown', () => {
    const rotations: number[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => k === 'rotate'
        ? (rad: number) => { rotations.push(Math.round((rad * 180) / Math.PI)) }
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => { t[k as string] = v; return true },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    withLaidOutDevice(() => {
      recordCanvas.current = document.createElement('canvas')
      renderViewer({ chrome: { ...chrome, streamRotation: 90 } })
      expect([recordCanvas.current.width, recordCanvas.current.height]).toEqual([600, 300])
      captured.compose!()
      expect(rotations[0]).toBe(90)
    })
  })

  // `MediaRecorder` fixed the size when the take started; the composer fits the device into it. Mutation:
  // resize the canvas mid-take.
  it('keeps the recording\'s size when the device turns during a take', () => {
    withLaidOutDevice(() => {
      recordCanvas.current = document.createElement('canvas')
      const { rerender, props } = renderViewer({ chrome: { ...chrome, streamRotation: 0 } })
      expect([recordCanvas.current.width, recordCanvas.current.height]).toEqual([300, 600])
      captured.recordState = 'recording'
      rerender(<IOSViewer {...props} chrome={{ ...chrome, streamRotation: 90 }} />)
      expect([recordCanvas.current.width, recordCanvas.current.height]).toEqual([300, 600])
    })
  })

  // A recording is sized at the stream's resolution, not the page's: it used to be the laid-out device, so a phone
  // shown 300 px wide recorded 300 px wide from a 1206-px stream. Mutations: drop the stream scale; drop the cap;
  // let the scale fall below 1 (the browser's default 300x150 canvas before a frame would halve it — the two tests
  // above).
  it('records at the stream\'s resolution, held to the longest side a browser encodes', () => {
    withLaidOutDevice(() => {
      renderViewer({ chrome: { ...chrome, streamRotation: 0 } })
      const screenCanvas = [...document.querySelectorAll('canvas')].find((c) => c !== recordCanvas.current)!
      screenCanvas.width = 600; screenCanvas.height = 1200 // a decoded frame, twice the laid-out 300x600
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      expect(captured.started).toBe(true)
      expect([recordCanvas.current!.width, recordCanvas.current!.height]).toEqual([600, 1200])

      captured.started = false
      screenCanvas.width = 1206; screenCanvas.height = 2622 // 4.37x: 1311x2622, over the 1920 cap
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      expect([recordCanvas.current!.width, recordCanvas.current!.height]).toEqual([960, 1920])

      // The scale is the screen's, not the device's: the screen sits inside the frame, smaller than the whole. With
      // the screen laid out at 250x500 and decoded at 500x1000 (2x), the 300x600 device records at 600x1200; dividing
      // by the device instead (1.67x) would record it at 500x1000. Mutation: the container as the denominator.
      Object.defineProperty(screenCanvas, 'clientWidth', { configurable: true, value: 250 })
      Object.defineProperty(screenCanvas, 'clientHeight', { configurable: true, value: 500 })
      screenCanvas.width = 500; screenCanvas.height = 1000
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      expect([recordCanvas.current!.width, recordCanvas.current!.height]).toEqual([600, 1200])
    })
  })

  // A swipe's moving dot blurs the frame under it, and in a recording that frame is on the same canvas: the composer
  // asks the renderer for it. Mutation: drop `backdrop` from the composer's call, and nothing is blurred.
  it('blurs the frame under a swipe\'s moving dot in the recording', () => {
    const filters: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => k === 'getTransform' ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
        : k === 'createLinearGradient' ? () => ({ addColorStop() {} })
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => { if (k === 'filter') filters.push(v as string); t[k as string] = v; return true },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 320, height: 620, right: 320, bottom: 620, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    withLaidOutDevice(() => {
      recordCanvas.current = document.createElement('canvas')
      const { container } = renderViewer({ chrome: { ...chrome, streamRotation: 0 } })
      const surface = container.querySelector<HTMLElement>('[style*="rotate("]')!
      fireEvent.pointerDown(surface, { clientX: 90, clientY: 455, pointerId: 1, buttons: 1 })
      fireEvent.pointerMove(surface, { clientX: 90, clientY: 200, pointerId: 1, buttons: 1 })
      filters.length = 0
      captured.compose!()
      expect(filters.some((f) => f.startsWith('blur('))).toBe(true)
    })
  })

  // The recording draws the pointer where the page does: in the device's space, through the screen canvas's box. The
  // page's own placement is held by `IOSViewer.touchMarks.test.tsx`; this is the recording's half (review: nothing
  // held it, and swapping x and y here passed every test). Mutation: drop the screen's offset, or swap the axes.
  it('records a press where the pointer is, in the screen\'s box', () => {
    const arcs: [number, number][] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => k === 'arc'
        ? (x: number, y: number) => { arcs.push([x, y]) }
        : k === 'createLinearGradient' ? () => ({ addColorStop() {} })
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => { t[k as string] = v; return true },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 320, height: 620, right: 320, bottom: 620, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    withLaidOutDevice(() => {
      recordCanvas.current = document.createElement('canvas')
      const { container } = renderViewer({ chrome: { ...chrome, streamRotation: 0 } })
      const screenCanvas = [...container.querySelectorAll('canvas')].find((c) => c !== recordCanvas.current && !c.dataset.testid)!
      Object.defineProperty(screenCanvas, 'offsetLeft', { configurable: true, value: 10 })
      Object.defineProperty(screenCanvas, 'offsetTop', { configurable: true, value: 20 })
      // A quarter across and three quarters down — not the middle, where swapped axes land on the same point. The
      // composite is 320x620 with the screen at (20, 20) and 280x580.
      fireEvent.pointerDown(container.querySelector<HTMLElement>('[style*="rotate("]')!, { clientX: 90, clientY: 455, pointerId: 1, buttons: 1 })
      arcs.length = 0
      captured.compose!()
      // The screen canvas laid out at 300x600, offset (10, 20): (10 + 0.25 × 300, 20 + 0.75 × 600).
      expect(arcs.at(-1)).toEqual([85, 470])
    })
  })

  it('rotates the simulator back when the viewer goes away in landscape', async () => {
    const { send, unmount } = renderViewer()

    await userEvent.click(rotateButton())
    expect(rotateCalls(send)).toHaveLength(1)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
    // The session it is addressed to, not only that something went out — the cleanup reads
    // `sessionId` at unmount now rather than capturing it at mount.
    expect(rotateCalls(send)[1][0]).toEqual({ type: 'input:rotate', sessionId: 's1', payload: { orientation: 'portrait' } })
  })

  it('leaves a simulator it never turned alone', () => {
    const { send, unmount } = renderViewer()
    unmount()
    expect(rotateCalls(send)).toHaveLength(0)
  })

  it('does not undo a rotation the tester already undid', async () => {
    // Two presses is back where it started, and a third message on unmount would turn a simulator
    // the tester left upright.
    const { send, unmount } = renderViewer()
    await userEvent.click(rotateButton())
    await userEvent.click(rotateButton())

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
  })

  // #910: the agent is sent a target, not "turn". Two presses inside one render still have to go
  // landscape then portrait — read from the state, both would say landscape.
  //
  // Mutation: compute the target from the state instead of the ref.
  it('sends where to turn, in order, even before a re-render', () => {
    const { send } = renderViewer()
    const chord = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true }))
    act(() => { chord(); chord() })
    expect(rotateCalls(send).map(([m]) => (m as { payload?: { orientation?: string } }).payload?.orientation))
      .toEqual(['landscape', 'portrait'])
  })

  // A held chord repeats every few dozen milliseconds, and each repeat would be another turn.
  //
  // Mutation: drop the `e.repeat` check.
  it('ignores a held chord repeating', () => {
    const { send } = renderViewer()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true, repeat: true }))
    })
    expect(rotateCalls(send)).toHaveLength(1)
  })
})

// A multi-panel device (iPhone Duo) reports how its lit panel is turned, because SpringBoard turns it
// and the tester's Rotate is carried out on the device. The viewer asks from that, not from its own
// last press, and does not turn a shared device back when it leaves.
describe('IOSViewer — a device that reports its own turn', () => {
  afterEach(() => vi.restoreAllMocks())
  const turned = (streamRotation: number) => ({ ...chrome, streamRotation })

  // DeviceHub's rotate button: a quarter clockwise from the way the device is held, whichever that is.
  // Mutations: send a portrait/landscape target; count the second press from the device's report instead
  // of from the turn still on its way.
  it('sends a quarter clockwise, and counts a second quick press from the first', () => {
    vi.useFakeTimers()
    try {
      const { send, container } = renderViewer({ chrome: turned(90) })
      fireEvent.click(rotateButton())
      fireEvent.click(rotateButton())
      act(() => { vi.advanceTimersByTime(350) })
      expect(rotateCalls(send).map(([m]) => (m as { payload?: unknown }).payload)).toEqual([{ direction: 'clockwise' }, { direction: 'clockwise' }])
      expect(shownDeg(container)).toBe(270)
    } finally { vi.useRealTimers() }
  })

  // DeviceHub's order: the frame, then the screen. Sent at the press, a quick device turned its screen
  // while the frame was still turning. Mutation: send at the press.
  it('sends the turn once the frame has finished turning', () => {
    vi.useFakeTimers()
    try {
      const { send } = renderViewer({ chrome: turned(0) })
      fireEvent.click(rotateButton())
      act(() => { vi.advanceTimersByTime(300) })
      expect(rotateCalls(send)).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(50) })
      expect(rotateCalls(send)).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  // Mutations: drop the guard in the unmount cleanup; drop the turn still waiting for the frame (the
  // press would be lost with the viewer).
  it('does not turn the device back when the viewer leaves', async () => {
    const { send, unmount } = renderViewer({ chrome: turned(0) })
    await userEvent.click(rotateButton())
    unmount()
    expect(rotateCalls(send)).toHaveLength(1)
  })

  // DeviceHub's order: the frame turns at the press and the screen inside follows when the device does.
  // Mutation: drop the pending turn (the device would stay drawn where it was until the agent answers).
  const shownDeg = (root: HTMLElement) => {
    const el = root.querySelector<HTMLElement>('[style*="rotate("]')!
    return ((Number(el.style.transform.match(/rotate\((-?\d+)deg\)/)![1]) % 360) + 360) % 360
  }

  it('turns the device on screen at the press, ahead of the device', () => {
    const { container } = renderViewer({ chrome: turned(90) })
    expect(shownDeg(container)).toBe(90)
    fireEvent.click(rotateButton())
    expect(shownDeg(container)).toBe(180)
  })

  // Mutation: no deadline (a device that never turns would stay drawn turned for good).
  it('puts it back where the device says it is when the device never answers', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderViewer({ chrome: turned(90) })
      fireEvent.click(rotateButton())
      expect(shownDeg(container)).toBe(180)
      act(() => { vi.advanceTimersByTime(8_000) })
      expect(shownDeg(container)).toBe(90)
    } finally { vi.useRealTimers() }
  })

  // Mutation: release only at the deadline. The press would then hide a turn made right after it
  // (DeviceHub's picker, an app) until the 8 s were up.
  it('hands back to the device as soon as it reports the turn, so the next one shows at once', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender, props } = renderViewer({ chrome: turned(90) })
      fireEvent.click(rotateButton())
      rerender(<IOSViewer {...props} chrome={turned(180) as typeof props.chrome} />)
      act(() => { vi.advanceTimersByTime(0) })
      expect(shownDeg(container)).toBe(180)
      rerender(<IOSViewer {...props} chrome={turned(270) as typeof props.chrome} />)
      expect(shownDeg(container)).toBe(270)
    } finally { vi.useRealTimers() }
  })

  // A turn the device has reported is done: the next press counts from the device again, even inside the
  // first one's deadline. A fold moves the reported turn a quarter. Mutation: keep the ref after the release —
  // the next press counts from the old target, and the frame goes half round from where the device is.
  it('counts the next press from the device once the last turn has landed', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender, props } = renderViewer({ chrome: turned(90) })
      fireEvent.click(rotateButton())
      rerender(<IOSViewer {...props} chrome={turned(180) as typeof props.chrome} />)
      act(() => { vi.advanceTimersByTime(0) })
      // Unfolded meanwhile: the same hold reads a quarter back.
      rerender(<IOSViewer {...props} chrome={{ ...turned(90), framePng: 'unfolded' } as typeof props.chrome} />)
      act(() => { vi.advanceTimersByTime(1_000) })
      fireEvent.click(rotateButton())
      expect(shownDeg(container)).toBe(180)
    } finally { vi.useRealTimers() }
  })

  // Mutation: drop the gate. A point taken while the device turns lands somewhere else.
  it('takes no touch while the device is turning, and takes it again after', () => {
    // jsdom lays nothing out and captures no pointers: give the device a box and capture a no-op.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 320, height: 620, right: 320, bottom: 620, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    const { send, container } = renderViewer({ chrome: turned(90) })
    const touches = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:touch:start')
    fireEvent.click(rotateButton())
    const device = container.querySelector<HTMLElement>('[style*="rotate("]')!
    fireEvent.pointerDown(device, { clientX: 160, clientY: 310, pointerId: 1 })
    expect(touches()).toHaveLength(0)
    now.mockReturnValue(2_000)
    fireEvent.pointerDown(device, { clientX: 160, clientY: 310, pointerId: 2 })
    expect(touches()).toHaveLength(1)
  })

  it('offers the fold, and sends it', async () => {
    const postures = { postures: [{ id: 'closed', label: 'Folded' }, { id: 'open', label: 'Unfolded' }], currentId: 'closed' }
    const { send } = renderViewer({ chrome: turned(0), postures })
    await userEvent.click(screen.getByRole('button', { name: /^Unfold/ }))
    expect(send).toHaveBeenCalledWith({ type: 'input:posture', sessionId: 's1', payload: { postureId: 'open' } })
  })

  // A fold takes the Duo 4–6 s; the screen says so rather than looking stuck. Mutations: leave `folding` off
  // the screen; name the direction from the ids rather than the list's order.
  it('says the device is unfolding from the press', async () => {
    const postures = { postures: [{ id: 'closed', label: 'Folded' }, { id: 'open', label: 'Unfolded' }], currentId: 'closed' }
    renderViewer({ chrome: turned(0), postures })
    expect(screen.queryByText('Unfolding...')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Unfold/ }))
    expect(screen.getByTestId('screen-waiting')).toHaveTextContent('Unfolding...')
  })

  it('offers no fold for a device with no postures', () => {
    renderViewer()
    expect(screen.queryByRole('button', { name: /^(Posture|Unfold|Fold)/ })).toBeNull()
  })
})
