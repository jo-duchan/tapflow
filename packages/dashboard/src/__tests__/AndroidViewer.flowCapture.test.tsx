import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

/**
 * Android's half of `viewerFlowCapture.test.tsx` (#1125): while Flow Capture's dialog is open the viewer sends nothing
 * for a key, a shortcut or a copy. The two viewers carry the guard separately, so each is held separately.
 */

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle', recordCanvasRef: { current: null },
    setComposeFrame: () => {}, startClientRecording: () => {}, stopClientRecording: () => {},
  }),
}))
vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { AndroidViewer } from '@/components/device/AndroidViewer'

function renderViewer(over: Record<string, unknown> = {}) {
  const send = vi.fn()
  const props = {
    sessionId: 's1', send, openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, androidButtons: null,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
    screenWidth: 1080, screenHeight: 2400, streamRotation: 0,
    ...over,
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof AndroidViewer>
  return { ...render(<AndroidViewer {...props} />), send }
}

/** A press on the picture, which is what turns keyboard capture on. The picture is the first layer of the screen. */
function pressScreen(container: HTMLElement) {
  const screen = container.querySelector<HTMLElement>('div[style*="background-color: rgb(1, 1, 1)"] > div')
  if (!screen) throw new Error('no picture to press')
  fireEvent.pointerDown(screen, { pointerId: 1, button: 0, clientX: 50, clientY: 100 })
  fireEvent.pointerUp(screen, { pointerId: 1, button: 0, clientX: 50, clientY: 100 })
}

const turnShortcut = () => fireEvent.keyDown(window, { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true })
const typedKey = () => fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
// The clipboard bridge listens on the document, apart from the viewer's own handler on the window.
const copyChord = () => fireEvent.keyDown(document, { code: 'KeyC', key: 'c', metaKey: true })
const keyFor = (send: ReturnType<typeof vi.fn>, code: string) =>
  send.mock.calls.some(([m]) => m.type === 'input:key' && m.payload?.code === code)

describe('the Android viewer while Flow Capture is open', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    )
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('types and copies after a press on the screen when the dialog is closed', () => {
    const { send, container } = renderViewer()
    pressScreen(container)
    send.mockClear()
    typedKey()
    copyChord()
    expect(keyFor(send, 'KeyA')).toBe(true)
    expect(keyFor(send, 'KeyC')).toBe(true)
  })

  it('sends nothing for a shortcut, a key or a copy while the dialog is open', () => {
    const { send, container } = renderViewer({ captureOpen: true })
    pressScreen(container)
    send.mockClear()
    turnShortcut()
    typedKey()
    copyChord()
    expect(send).not.toHaveBeenCalled()
  })
})
