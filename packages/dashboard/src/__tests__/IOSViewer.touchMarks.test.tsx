import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

/**
 * **A person's pointer on the iOS viewer is drawn by the shared touch marks** (`lib/touchMarks`): the same layer an
 * agent's touches are drawn by, in white. The layer is a canvas; it keeps where its marks start on `data-anchor`,
 * which is what this file reads. Android's half is in `AndroidViewer.composeFrame.test.tsx`.
 */

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle', recordCanvasRef: { current: null },
    setComposeFrame: () => {}, startClientRecording: () => {}, stopClientRecording: () => {},
  }),
}))
vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'
import { PointerTouchMarks } from '@/lib/touchMarks'

const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

function renderViewer() {
  const send = vi.fn()
  const props = {
    sessionId: 's1', send, openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, chrome,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(),
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  return { ...render(<IOSViewer {...props} />), send }
}

describe('IOSViewer — the pointer\'s touch marks', () => {
  afterEach(() => { vi.restoreAllMocks() })
  // jsdom lays nothing out and captures no pointers: give the device a box (the composite's half size) and capture a no-op.
  const laidOut = () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 320, height: 620, right: 320, bottom: 620, x: 0, y: 0, toJSON: () => ({}) })
    Element.prototype.setPointerCapture ??= () => {}
  }
  const marks = () => screen.getByTestId('touch-marks')
  const discs = () => marks().dataset.anchor?.split(';').length ?? 0

  it('draws in the person\'s colour, over the device and hidden from assistive tech', () => {
    renderViewer()
    expect(marks().dataset.tone).toBe('person')
    expect(marks().getAttribute('aria-hidden')).toBe('true')
  })

  // The user: Option alone shows the pinch guide where the pointer already is. Mutation: drop `pointerMarks.option(true)`.
  it('shows a pinch guide\'s two discs as soon as Option is held, and one when it is let go', () => {
    laidOut()
    const { container } = renderViewer()
    const device = container.querySelector<HTMLElement>('[style*="rotate("]')!
    fireEvent.pointerMove(device, { clientX: 160, clientY: 310, pointerId: 1 })
    expect(discs()).toBe(1)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft' })) })
    expect(discs()).toBe(2)
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft' })) })
    expect(discs()).toBe(1)
  })

  it('draws a press where it went down, and keeps drawing it after the pointer leaves', () => {
    laidOut()
    const { container } = renderViewer()
    const device = container.querySelector<HTMLElement>('[style*="rotate("]')!
    fireEvent.pointerDown(device, { clientX: 160, clientY: 310, pointerId: 1, buttons: 1 })
    expect(discs()).toBe(1)
    fireEvent.pointerLeave(device, { pointerId: 1 })
    // Still drawn: a press plays out after the pointer leaves.
    expect(discs()).toBe(1)
  })

  // The mark splits into a drag only when the device is sent one: under the input's threshold (2 % of the screen) the
  // device takes a tap, and a swipe drawn there showed something that did not happen (review). Mutation: draw the
  // drag before the threshold check.
  it('draws a drag only once the press has moved far enough to be sent as one', () => {
    laidOut()
    const drag = vi.spyOn(PointerTouchMarks.prototype, 'drag')
    const { container } = renderViewer()
    const device = container.querySelector<HTMLElement>('[style*="rotate("]')!
    fireEvent.pointerDown(device, { clientX: 160, clientY: 310, pointerId: 1, buttons: 1 })
    // 3 px across a 280 px screen is about 1 %: still a tap.
    fireEvent.pointerMove(device, { clientX: 163, clientY: 310, pointerId: 1, buttons: 1 })
    expect(drag).not.toHaveBeenCalled()
    // 30 px is over 10 %: a drag, drawn and sent.
    fireEvent.pointerMove(device, { clientX: 190, clientY: 310, pointerId: 1, buttons: 1 })
    expect(drag).toHaveBeenCalledTimes(1)
  })
})
