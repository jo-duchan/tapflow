import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * **What a recorded frame is turned by, while it is being recorded.**
 *
 * `composeFrame` draws each recorded frame into the record canvas and reads the turn *per frame*
 * rather than inferring it from the canvas — an aspect ratio cannot tell 90 from 270 and cannot
 * see 180 at all. That is the whole reason `AndroidViewer` mirrors `totalTurn` and
 * `streamRotation` into refs: `MediaRecorder` took `composeFrame` when recording started, and a
 * rotation after that has to reach the frames anyway.
 *
 * None of it was covered. `composeFrame` and `startClientRecording` appeared in no test in this
 * package, so rotating mid-recording — an ordinary thing to do while testing — was held by nothing.
 * It is held here because the mirroring is what the React Compiler refuses to compile, and any
 * rewrite of it has to keep this true.
 *
 * **What this file does not hold: that registration is a layout effect rather than a passive one.**
 * The production comment gives a measured reason — `requestAnimationFrame` fires between the
 * layout effects and the paint, so a passive effect would draw the first frame after a rotation
 * with the old turn — and nothing here can fail if that changes. Every point these tests act at is
 * inside `act()`, which flushes passive effects synchronously, so jsdom cannot tell the two apart.
 * Holding it would mean ordering rAF against React's passive flush, which jsdom does not model;
 * that is a decision to take deliberately rather than a missing assertion. Recorded because a
 * green suite beside a stated reason reads as having held it.
 */

type Compose = () => void

const { recordCanvas, captured } = vi.hoisted(() => ({
  recordCanvas: { current: null as HTMLCanvasElement | null },
  captured: {
    compose: null as Compose | null,
    started: false,
    onResize: null as ((s: { width: number; height: number }) => void) | null,
    onDecoderReady: null as ((d: { surface: unknown }) => void) | null,
  },
}))

// **Stable, like the real one.** `useClientRecording` builds these with `useCallback(…, [])`, and
// a mock that rebuilds them every render makes every dependency array containing them change every
// render — which silently re-runs the registration effect and hides a missing dependency. Measured:
// with unstable mocks, removing `composeFrame` from that effect's deps failed nothing.
const stableSetComposeFrame = (compose: Compose) => { captured.compose = compose }
const stableStart = () => { captured.started = true }
const stableStop = () => {}

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle',
    recordCanvasRef: recordCanvas,
    // The recorder keeps whichever composer was registered last, and its frame loop reads that on
    // every tick. Capturing the registration is how this test gets hold of the newest one — which
    // is the behaviour under test, not an implementation detail of the mock.
    setComposeFrame: stableSetComposeFrame,
    startClientRecording: stableStart,
    stopClientRecording: stableStop,
  }),
}))

vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: {
    onResize: (s: { width: number; height: number }) => void
    onDecoderReady: (d: { surface: unknown }) => void
  }) => {
    captured.onResize = opts.onResize
    captured.onDecoderReady = opts.onDecoderReady
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { AndroidViewer } from '@/components/device/AndroidViewer'

/** Angles `ctx.rotate` was called with, in degrees, in order. */
const rotations: number[] = []
/** Filters the recording's context was given, in order. */
const filters: string[] = []

function stubCanvasContext() {
  const ctx = {
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), rect: vi.fn(), clip: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), setTransform: vi.fn(),
    getTransform: vi.fn(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })), createLinearGradient: vi.fn(() => ({ addColorStop() {} })),
    set filter(f: string) { filters.push(f) },
    rotate: vi.fn((rad: number) => { rotations.push(Math.round((rad * 180) / Math.PI)) }),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
  }
  HTMLCanvasElement.prototype.getContext =
    vi.fn(() => ctx) as unknown as HTMLCanvasElement['getContext']
}

function renderViewer(streamRotation: 0 | 90 | 180 | 270 = 0) {
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
    androidButtons: null,
    binaryFrameHandlerRef: { current: undefined },
    clipboardHandlerRef: { current: undefined },
    clipboardSupported: true,
    networkHandlerRef: { current: undefined },
    networkSupported: false,
    rebootPending: false,
    onReboot: vi.fn(),
    restartButtonRef: { current: null },
    screenWidth: 1080,
    screenHeight: 2400,
    streamRotation,
  // The prop surface is wide and none of it is what this file is about; the casts keep the
  // fixture from restating types the component already owns.
  } as unknown as React.ComponentProps<typeof AndroidViewer>
  const view = render(<AndroidViewer {...props} />)
  type Props = React.ComponentProps<typeof AndroidViewer>
  return {
    ...view,
    send,
    rotateStream: (next: 0 | 90 | 180 | 270) =>
      view.rerender(<AndroidViewer {...props} streamRotation={next} />),
    /** Anything else the agent can report in one go — a fold moves the turn and the screen together. */
    rerenderWith: (patch: Partial<Props>) =>
      view.rerender(<AndroidViewer {...props} {...patch} />),
  }
}

/** The `input:rotate` messages `send` was given, in order. */
const rotateCalls = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:rotate')

/** The state `composeFrame` needs before it will draw anything: a surface, a size, a canvas. */
function readyToCompose() {
  const rc = document.createElement('canvas')
  rc.width = 1080; rc.height = 2400
  recordCanvas.current = rc
  act(() => {
    captured.onDecoderReady?.({ surface: document.createElement('canvas') })
    captured.onResize?.({ width: 1080, height: 2400 })
  })
}

/** The first `rotate` of a compose pass is the frame's own turn; the second is overlay space. */
const frameTurn = () => rotations[0]
/**
 * The turn the pointer overlay is drawn in — `totalTurn - streamRotation`, the user's own quarter
 * with the stream's correction taken back out.
 *
 * **Asserted separately because the two move independently.** A test that reads only the frame's
 * turn is blind to the overlay's arguments: passing `0` for `streamRotation` to `overlaySpace`,
 * or dropping it from `composeFrame`'s dependency list, leaves index 0 untouched and index 1
 * wrong. Both were measured green across all 681 tests before this existed — and drawing the
 * cursor in the wrong space is the defect the comment beside that call says has already shipped
 * twice, once against the frame and once against the picture.
 */
const overlayTurn = () => rotations[1]

describe('AndroidViewer — the turn a recorded frame is composed with', () => {
  beforeEach(() => {
    rotations.length = 0
    captured.compose = null; captured.started = false
    captured.onResize = null; captured.onDecoderReady = null
    recordCanvas.current = null
    stubCanvasContext()
  })
  afterEach(() => vi.restoreAllMocks())

  it('registers a composer, and starts the recorder', async () => {
    renderViewer()
    readyToCompose()
    expect(captured.compose).toBeTypeOf('function')
    await userEvent.click(screen.getByRole('button', { name: /record/i }))
    expect(captured.started).toBe(true)
  })

  it('draws the frame with the turn in force now, not the one recording began with', async () => {
    // **The reason the refs exist.** The recorder captured `composeFrame` at start; a rotation
    // after that must still reach the frames it draws.
    const { rotateStream } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(0)

    rotations.length = 0
    act(() => { rotateStream(90) })
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    // The stream turned the frame, so the overlay is already square with the screen.
    expect(overlayTurn()).toBe(0)
  })

  it('follows the rotate button too, which the stream never hears about', async () => {
    // **The other half, and the one only this test can see.** A turn reaches `composeFrame` two
    // ways: the agent reports a new `streamRotation`, or the tester presses rotate and the viewer
    // adds a CSS quarter of its own (`needsCSSRotation`) for a portrait-locked app that will never
    // report one. The tests above drive the first, which moves a prop `composeFrame` already
    // depends on — so they pass even if the composed turn is not a dependency at all. Measured:
    // dropping `totalTurn` from that dependency list failed nothing until this test existed.
    renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(0)

    rotations.length = 0
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    // The quarter is the tester's alone this time, so the overlay carries all of it — the opposite
    // reading from the stream-driven test above, which is what makes the pair discriminating.
    expect(overlayTurn()).toBe(90)
  })

  it('keeps the overlay square when the stream takes over a turn the tester was holding', async () => {
    // **The one case that separates the two dependencies.** Unfolding turns the screen landscape,
    // so the viewer's own CSS quarter drops away at the same moment the stream starts correcting
    // by one — `totalTurn` holds at 90 while `streamRotation` goes 0 → 90. The frame is drawn
    // identically either way; only the overlay space moves. Every other test here moves both at
    // once, which is why dropping `streamRotation` from `composeFrame`'s dependencies was green.
    const { rerenderWith } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(90)
    expect(overlayTurn()).toBe(90)

    rotations.length = 0
    act(() => { rerenderWith({ streamRotation: 90, screenWidth: 2400, screenHeight: 1080 }) })
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    expect(overlayTurn()).toBe(0)
  })

  it('follows a turn the other way too, so the reading is the angle and not merely "changed"', async () => {
    // 180 is the case an aspect-ratio inference cannot see at all, and 270 is the one it cannot
    // tell from 90. Asserting the angle rather than a difference is what makes this test able to
    // fail for the right reason.
    const { rotateStream } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    for (const turn of [180, 270] as const) {
      rotations.length = 0
      act(() => { rotateStream(turn) })
      act(() => captured.compose?.())
      expect(frameTurn()).toBe(turn)
    }
  })
})

describe('AndroidViewer — putting the device back the way it was found', () => {
  beforeEach(() => {
    rotations.length = 0
    captured.compose = null; captured.started = false
    captured.onResize = null; captured.onDecoderReady = null
    recordCanvas.current = null
    stubCanvasContext()
  })
  afterEach(() => vi.restoreAllMocks())

  // **Held here because removing a suppression is not a refactor if nothing watched the code
  // under it.** The cleanup that undoes a rotation runs once, on unmount, so its dependency list
  // has to be empty — and an empty list closing over `send` and `sessionId` is what
  // `react-hooks/exhaustive-deps` was suppressed for. The React Compiler skips a whole file that
  // carries a suppression, whichever rule it names, so the suppression had to go; these say the
  // behaviour came through it. Nothing in this package asserted on `input:rotate` before.
  it('rotates the device back when the viewer goes away in landscape', async () => {
    const { send, unmount } = renderViewer(0)
    readyToCompose()

    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    expect(rotateCalls(send)).toHaveLength(1)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
    // The session the message is addressed to, not only that a message went out: the cleanup reads
    // `sessionId` at unmount now rather than capturing it at mount, and a count cannot tell a
    // rotate sent to this device from one sent to nobody.
    expect(rotateCalls(send)[1][0]).toEqual({ type: 'input:rotate', sessionId: 's1', payload: { orientation: 'portrait' } })
  })

  it('leaves a device it never turned alone', () => {
    const { send, unmount } = renderViewer(0)
    readyToCompose()
    unmount()
    expect(rotateCalls(send)).toHaveLength(0)
  })

  it('does not undo a rotation the tester already undid', async () => {
    // Two presses is back where it started, and a third message on unmount would turn a device
    // the tester left upright.
    const { send, unmount } = renderViewer(0)
    readyToCompose()
    const rotate = screen.getByRole('button', { name: /rotate the device/i })
    await userEvent.click(rotate)
    await userEvent.click(rotate)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
  })

  // #910: the agent is sent a target, not "turn". Two presses inside one render still have to go
  // landscape then portrait — read from the state, both would say landscape.
  //
  // Mutation: compute the target from the state instead of the ref.
  it('sends where to turn, in order, even before a re-render', () => {
    const { send } = renderViewer(0)
    readyToCompose()
    const chord = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true }))
    act(() => { chord(); chord() })
    expect(rotateCalls(send).map(([m]) => (m as { payload?: { orientation?: string } }).payload?.orientation))
      .toEqual(['landscape', 'portrait'])
  })

  // A held chord repeats every few dozen milliseconds, and each repeat would be another turn.
  //
  // Mutation: drop the `e.repeat` check.
  it('ignores a held chord repeating', () => {
    const { send } = renderViewer(0)
    readyToCompose()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', metaKey: true, shiftKey: true, repeat: true }))
    })
    expect(rotateCalls(send)).toHaveLength(1)
  })
})

describe('AndroidViewer — a frame ahead of its description (#845)', () => {
  beforeEach(() => {
    captured.onResize = null; captured.onDecoderReady = null
    recordCanvas.current = null
    stubCanvasContext()
  })

  it('hides a frame the description has not caught up with, and shows it once the description moves on', () => {
    const v = renderViewer(0)
    readyToCompose()
    expect(screen.queryByText(/Changing posture…|Waiting for stream…/)).toBeNull()

    // A fold: the stream changes shape before the agent describes the new screen. Drawn into the old
    // box it would flash stretched, so it waits.
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
    expect(screen.getByText('Changing posture…')).toBeInTheDocument()

    // The description moves on — to a screen this frame does not match either. The frame is no longer
    // the newer of the two, so the last one is shown rather than a wait with nothing to end it.
    v.rerenderWith({ screenWidth: 1200, screenHeight: 2000 })
    expect(screen.queryByText(/Changing posture…|Waiting for stream…/)).toBeNull()
  })

  it('does not hide the frame again when the description comes back to where it was', () => {
    // A fold that flaps: the description leaves and returns with no new frame. Keyed on "ahead of this
    // description", the frame counted as ahead again and the picture stayed hidden until a resize.
    const v = renderViewer(0)
    readyToCompose()
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
    v.rerenderWith({ screenWidth: 1200, screenHeight: 2000 })
    v.rerenderWith({ screenWidth: 1080, screenHeight: 2400 })
    expect(screen.queryByText(/Changing posture…|Waiting for stream…/)).toBeNull()
  })
})

// Body mode (gRPC emulators report `bodyRotation`): the frame is drawn as the body is held, Rotate turns the body
// a quarter clockwise, and a touch goes on the wire in the screen Android draws.
describe('AndroidViewer — a device that reports its body', () => {
  beforeEach(() => { stubCanvasContext() })
  afterEach(() => { vi.restoreAllMocks() })

  // Mutations: send a portrait/landscape target; count the second press from the report, not the turn on its way.
  // Mutation: send a portrait/landscape target.
  it('sends a quarter clockwise for every press', async () => {
    const { send, rerenderWith } = renderViewer(0)
    rerenderWith({ bodyRotation: 0 })
    const rotate = screen.getByRole('button', { name: /rotate the device/i })
    await userEvent.click(rotate)
    await userEvent.click(rotate)
    await vi.waitFor(() => expect(rotateCalls(send).map(([m]) => (m as { payload: unknown }).payload)).toEqual([{ direction: 'clockwise' }, { direction: 'clockwise' }]))
  })

  // The next frame is the turned body, so nothing is held back: not by the press, and not while the description
  // (0.6–3.6 s behind) still describes the body before. Mutations: hold the picture on a press; frame the shell by
  // the description, so a landscape frame waits behind "Changing posture…".
  it('shows the turned frame at once, before the description catches up', async () => {
    const { rerenderWith, container } = renderViewer(0)
    rerenderWith({ bodyRotation: 0 })
    readyToCompose()
    const held = () => container.querySelector('.animate-pulse') !== null
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    expect(held()).toBe(false)
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) }) // the turned body's frame, description still portrait
    expect(held()).toBe(false)
    expect(container.textContent).not.toContain('Changing posture')
  })

  // The corners are the panel's, which no turn changes: the frame flips at once while the description is a turn
  // behind, and choosing a side of the shell by that description made them jump. Mutation: radius from a side
  // chosen by `streamRotation`.
  it('keeps the screen\'s corners while the frame turns ahead of the description', () => {
    const { rerenderWith, container } = renderViewer(0)
    rerenderWith({ bodyRotation: 0, cornerRadius: 0.1 })
    readyToCompose()
    const radius = () => (container.querySelector('div[style*="overflow: hidden"]') as HTMLElement).style.borderRadius
    const before = radius()
    // 0.1 of a 1080-px width is 108 device px; the shell's long side is 720 of the device's 2400.
    expect(before).toBe(`${Math.round((108 * 720) / 2400)}px`)
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) }) // turned frame, description still portrait
    expect(radius()).toBe(before)
    // A quality tier shrinks the stream; the corner is the panel's, so it does not move.
    act(() => { captured.onResize?.({ width: 1280, height: 576 }) })
    expect(radius()).toBe(before)
    rerenderWith({ bodyRotation: 90, streamRotation: 270, screenWidth: 1080, screenHeight: 2400, cornerRadius: 0.1 })
    expect(radius()).toBe(before)
  })

  // The cursor shows where the pointer is whatever the description says. Mutation: show it only when the frame and
  // the description agree — it vanished on every turn and stayed gone until the mouse moved.
  it('keeps the cursor on screen while the description lags the frame', () => {
    const { rerenderWith, container } = renderViewer(0)
    rerenderWith({ bodyRotation: 0 })
    readyToCompose()
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    act(() => { host.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 })) })
    // The hover disc is drawn: the layer says where. Mutation: drop the point while the description lags.
    expect(screen.getByTestId('touch-marks').dataset.anchor).toBeTruthy()
  })

  // A touch goes out in the frame's space and the agent turns it by the frame it holds, so nothing waits on the
  // description (0.6–3.6 s behind a turn). Dropping touches until it caught up was the first version, and it was
  // felt as input stalling after every turn. Mutation: refuse the touch while the two disagree.
  it('takes a touch at once while the description lags the frame', () => {
    const { send, rerenderWith, container } = renderViewer(0)
    rerenderWith({ bodyRotation: 0 })
    readyToCompose()
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    const touches = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:touch:start')
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 24, clientY: 10, bubbles: true, pointerId: 1 })) })
    expect(touches().map(([m]) => (m as { payload: unknown }).payload)).toEqual([{ x: 0.1, y: 0.1, space: 'frame' }])
  })

  // **A press spins the device first and sends the turn once the spin is done; the turned frame ends the spin.**
  describe('the spin on a press', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })
    const bezel = (c: HTMLElement) => c.querySelector('div[style*="translate(-50%, -50%) rotate("]') as HTMLElement
    const area = (c: HTMLElement) => bezel(c).parentElement as HTMLElement
    const press = () => fireEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    const ready = () => {
      const view = renderViewer(0)
      view.rerenderWith({ bodyRotation: 0 })
      readyToCompose()
      return view
    }

    // Mutations: send at the press; spin without animating.
    it('spins a quarter, animated, and sends the turn when the spin has finished', () => {
      const { send, container } = ready()
      press()
      expect(bezel(container).style.transform).toContain('rotate(90deg)')
      expect(bezel(container).className).toContain('transition-transform')
      // The area takes the turned shape with it, so the toolbar moves rather than being run over.
      expect(parseFloat(area(container).style.width)).toBeGreaterThan(parseFloat(area(container).style.height))
      expect(rotateCalls(send)).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(350) })
      expect(rotateCalls(send)).toHaveLength(1)
    })

    // The turned body's frame is the picture the spin ended on, so it replaces the spin with no motion.
    // Mutations: end the spin on the description; animate the swap back.
    it('ends on the frame whose sides swapped, without moving', () => {
      const { container } = ready()
      press()
      act(() => { vi.advanceTimersByTime(350) })
      act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
      expect(bezel(container).style.transform).toContain('rotate(0deg)')
      expect(bezel(container).className).not.toContain('transition-transform')
    })

    // A quality tier scales the frame without turning it. Mutation: count any resize as the turn.
    it('is not ended by a frame that only changed size', () => {
      const { container } = ready()
      press()
      act(() => { captured.onResize?.({ width: 540, height: 1200 }) })
      expect(bezel(container).style.transform).toContain('rotate(90deg)')
    })

    // Mutation: count presses by whether one is pending, so a second press is lost.
    it('spins a quarter more for each press, and pays a quarter per turned frame', () => {
      const { container } = ready()
      press(); press()
      expect(bezel(container).style.transform).toContain('rotate(180deg)')
      act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
      expect(bezel(container).style.transform).toContain('rotate(90deg)')
      act(() => { captured.onResize?.({ width: 1080, height: 2400 }) })
      expect(bezel(container).style.transform).toContain('rotate(0deg)')
    })

    // Mutation: leave the device turned when its frame never comes.
    it('turns back when the frame never comes', () => {
      const { container } = ready()
      press()
      act(() => { vi.advanceTimersByTime(4_000) })
      expect(bezel(container).style.transform).toContain('rotate(0deg)')
      expect(bezel(container).className).toContain('transition-transform')
    })

    // The way back is drawn as a turn too, so input stays closed until it has landed. Mutation: reopen input the
    // moment nothing is owed.
    it('takes no touch while a turn whose frame never came is undone', () => {
      const { send, container } = ready()
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 240, right: 100, bottom: 240, x: 0, y: 0, toJSON: () => ({}) })
      Element.prototype.setPointerCapture ??= () => {}
      const host = container.querySelector('div[style*="cursor: none"]') as Element
      const touches = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:touch:start')
      press()
      act(() => { vi.advanceTimersByTime(4_000) })
      act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 24, bubbles: true, pointerId: 1 })) })
      expect(touches()).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(350) })
      act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 24, bubbles: true, pointerId: 2 })) })
      expect(touches()).toHaveLength(1)
    })

    // A point on a device caught mid-turn lands nowhere it was aimed. Mutation: take it anyway.
    it('takes no touch while the device spins, and takes one once the frame has come', () => {
      const { send, container } = ready()
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 240, right: 100, bottom: 240, x: 0, y: 0, toJSON: () => ({}) })
      Element.prototype.setPointerCapture ??= () => {}
      const host = container.querySelector('div[style*="cursor: none"]') as Element
      const touches = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:touch:start')
      press()
      act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 24, bubbles: true, pointerId: 1 })) })
      expect(touches()).toHaveLength(0)
      act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
      act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 24, bubbles: true, pointerId: 2 })) })
      expect(touches()).toHaveLength(1)
    })

    // A turn somebody else made arrives as a frame with nothing owed, and is drawn as it comes — spinning it would
    // turn a picture that has already turned. Mutation: spin on any turned frame.
    it('does not spin for a turn this viewer did not ask for', () => {
      const { container } = ready()
      act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
      expect(bezel(container).style.transform).toContain('rotate(0deg)')
    })
  })

  // The body's turn is the device's, shared with every viewer. Mutation: undo it on unmount as the toggle does.
  it('does not turn the device back when the viewer leaves', async () => {
    const { send, unmount, rerenderWith } = renderViewer(0)
    rerenderWith({ bodyRotation: 0 })
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    unmount()
    expect(rotateCalls(send)).toHaveLength(1)
  })

  // The wire carries the frame's own point and says so; the agent turns it into the screen. The cursor and the
  // recording's overlay are in the screen, turned by the correction: body a quarter clockwise over a
  // portrait-locked screen (correction 270), the frame's top-left is the screen's bottom-left. Mutations: send the
  // screen's point; drop `space`, so the agent reads a frame point as the screen.
  it('sends a touch in the frame\'s space, and says so', () => {
    const { send, rerenderWith, container } = renderViewer(270)
    rerenderWith({ bodyRotation: 90, streamRotation: 270 })
    // The surface host — the picture, under `cursor: none` — where the pointer handlers are.
    const host = container.querySelector('div[style*="cursor: none"]')
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const target = (host ?? container.firstElementChild) as Element
    act(() => { target.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true, pointerId: 1 })) })
    const start = send.mock.calls.map(([m]) => m as { type: string; payload?: { x: number; y: number } }).find((m) => m.type === 'input:touch:start')
    expect(start?.payload).toEqual({ x: 0, y: 0, space: 'frame' })
  })

  // Without a body the picture is the screen, and the wire says nothing more — the space every other sender uses.
  // Mutation: mark every touch as the frame's.
  it('sends no space where the picture is the screen', () => {
    const { send, container } = renderViewer(0)
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 240, right: 100, bottom: 240, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 24, bubbles: true, pointerId: 1 })) })
    const start = send.mock.calls.map(([m]) => m as { type: string; payload?: unknown }).find((m) => m.type === 'input:touch:start')
    expect(start?.payload).toEqual({ x: 0.1, y: 0.1 })
  })

  // A pinch is the same: both fingers in the frame, said once. The hint is drawn from the screen's pair, turned
  // back onto the picture, so it sits under the pointer. Mutation: send the screen's fingers.
  it('sends a pinch in the frame\'s space', () => {
    const { send, rerenderWith, container } = renderViewer(270)
    rerenderWith({ bodyRotation: 90, streamRotation: 270 })
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft' })) })
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 48, clientY: 20, bubbles: true, pointerId: 1 })) })
    const pinch = send.mock.calls.map(([m]) => m as { type: string; payload?: unknown }).find((m) => m.type === 'input:pinch:start')
    expect(pinch?.payload).toEqual({ f0: { x: 0.8, y: 0.8 }, f1: { x: 0.2, y: 0.2 }, space: 'frame' })
    // The hint is kept in the screen and turned back onto the picture: the second finger sits under the pointer.
    // Mutation: turn it by the correction instead of its inverse — every test at correction 0 passes that.
    const at = screen.getByTestId('touch-marks').dataset.anchor!.split(';').map((p) => p.split(',').map((n) => Math.round(Number(n))))
    expect(at).toEqual([[80, 80], [20, 20]])
  })

  // Portrait content held landscape with no body to turn (scrcpy, a real device): the picture is turned a quarter by CSS
  // inside a landscape box, and the mark must be put back in that box. Review: the box's top right was drawn at its
  // top left. Mutation: drop the quarter from the overlay's placement.
  it('draws the pointer under it when portrait content is held landscape', async () => {
    const { container } = renderViewer(0)
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    act(() => { host.dispatchEvent(new PointerEvent('pointermove', { clientX: 216, clientY: 10, bubbles: true, pointerId: 1 })) })
    expect(screen.getByTestId('touch-marks').dataset.anchor).toBe('90,10')
  })

  // The recording's half of the case above (re-review: the page's placement was tested, the video's was not). The
  // composer turns its overlay by the CSS quarter and draws the portrait point in it: the box's (0.9, 0.3) is the screen's
  // (0.3, 0.1), drawn at the page's 324x720 — not a symmetric point, where swapped axes land on the same spot.
  // Mutations: drop the quarter from the overlay's turn; swap the axes.
  it('records the pointer under it when portrait content is held landscape', async () => {
    const { container } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 216, clientY: 30, bubbles: true, pointerId: 1 })) })
    const ctx = document.createElement('canvas').getContext('2d') as unknown as { arc: ReturnType<typeof vi.fn> }
    ctx.arc.mockClear(); rotations.length = 0
    captured.compose?.()
    expect(overlayTurn()).toBe(90)
    const [x, y] = ctx.arc.mock.calls.at(-1) as [number, number]
    expect(x).toBeCloseTo(97.2)
    expect(y).toBeCloseTo(72)
  })

  // A swipe's moving dot blurs the frame under it, which a recording has on its own canvas. Mutation: drop `backdrop`
  // from the composer's call.
  it('blurs the frame under a swipe\'s moving dot in the recording', () => {
    const { container } = renderViewer(0)
    readyToCompose()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 240, right: 100, bottom: 240, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 200, bubbles: true, pointerId: 1, buttons: 1 })) })
    act(() => { host.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 60, bubbles: true, pointerId: 1, buttons: 1 })) })
    filters.length = 0
    captured.compose?.()
    expect(filters.some((f) => f.startsWith('blur('))).toBe(true)
  })

  // The user: Option alone shows the pinch guide where the pointer already is, no move needed; letting go shows one
  // disc again. Mutation: drop the viewer's `pointerMarks.option(true)` on the key.
  it('shows a pinch guide\'s two discs as soon as Option is held, and one when it is let go', () => {
    const { container } = renderViewer(0)
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 240, right: 100, bottom: 240, x: 0, y: 0, toJSON: () => ({}) })
    const discs = () => screen.getByTestId('touch-marks').dataset.anchor?.split(';').length ?? 0
    act(() => { host.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 48, bubbles: true, pointerId: 1 })) })
    expect(discs()).toBe(1)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft' })) })
    expect(discs()).toBe(2)
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft' })) })
    expect(discs()).toBe(1)
  })

  // The recording's overlay is drawn in the screen Android draws, so the cursor is kept there: a tap at the frame's
  // top-left, on a body a quarter clockwise over a portrait-locked screen, is the screen's bottom-left. Mutation:
  // keep the frame's point for the cursor.
  it('records the cursor in the screen\'s space on a turned body', () => {
    const { rerenderWith, container } = renderViewer(270)
    rerenderWith({ bodyRotation: 90, streamRotation: 270 })
    readyToCompose()
    act(() => { captured.onResize?.({ width: 2400, height: 1080 }) })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 240, height: 100, right: 240, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
    const host = container.querySelector('div[style*="cursor: none"]') as Element
    act(() => { host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true, pointerId: 1 })) })
    const ctx = document.createElement('canvas').getContext('2d') as unknown as { arc: ReturnType<typeof vi.fn> }
    ctx.arc.mockClear()
    captured.compose?.()
    const [x, y] = ctx.arc.mock.calls.at(-1) as [number, number]
    expect(x).toBe(0)
    expect(y).toBeGreaterThan(0)
  })
})
