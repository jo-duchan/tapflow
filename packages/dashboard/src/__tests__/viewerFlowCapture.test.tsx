import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Flow Capture's button, and the viewer going quiet while its dialog is open (#1125): a modal stops the pointer, but
 * the viewer's shortcuts listen on the window, and one pressed mid-replay (⌘⇧O turns the device) would wreck the match.
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

const sideButton = (name: string, title: string, y: number) => ({
  name, accessibilityTitle: title, anchor: 'left', onTop: false,
  normalOffset: { x: 10, y }, rolloverOffset: { x: 8, y },
  buttonW: 12, buttonH: 100, usagePage: 0, usage: 0, buttonPng: 'AA==',
})

const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844,
  buttons: [sideButton('action', 'Action', 300), sideButton('volume_up', 'Volume Up', 500)],
}

function renderViewer(over: Record<string, unknown> = {}) {
  const send = vi.fn()
  const props = {
    sessionId: 's1', send, openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, chrome,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(),
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
    ...over,
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  return { ...render(<IOSViewer {...props} />), send }
}


/** A press on the screen, which is what turns keyboard capture on. The screen is the frame buttons' layer. */
function pressScreen(container: HTMLElement) {
  const area = container.querySelector('[data-frame-button]')?.parentElement
  if (!area) throw new Error('no screen area to press')
  fireEvent.pointerDown(area, { pointerId: 1, button: 0 })
  fireEvent.pointerUp(area, { pointerId: 1, button: 0 })
}

const turnShortcut = () => fireEvent.keyDown(window, { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true })
const typedKey = () => fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
// The clipboard bridge listens on the document, apart from the viewer's own handler on the window.
const copyChord = () => fireEvent.keyDown(document, { code: 'KeyC', key: 'c', metaKey: true })

describe('the viewer while Flow Capture is open', () => {
  it('offers Capture flow in the Capture group when given the handler, and opens it on a press', async () => {
    const onCaptureFlow = vi.fn()
    renderViewer({ onCaptureFlow })
    const group = screen.getByRole('group', { name: 'Capture' })
    await userEvent.click(group.querySelector('button[aria-label="Capture flow"]')!)
    expect(onCaptureFlow).toHaveBeenCalledTimes(1)
  })

  it('has no Capture flow button without the handler', () => {
    renderViewer()
    expect(screen.queryByRole('button', { name: 'Capture flow' })).toBeNull()
  })

  it('turns the device on its shortcut when the dialog is closed', () => {
    const { send } = renderViewer()
    turnShortcut()
    expect(send.mock.calls.map(([m]) => (m as { type: string }).type)).toContain('input:rotate')
  })

  it('copies through the bridge when the dialog is closed', () => {
    const { send, container } = renderViewer()
    pressScreen(container)
    send.mockClear()
    copyChord()
    expect(send.mock.calls.map(([m]) => m)).toContainEqual(expect.objectContaining({
      type: 'input:key', payload: expect.objectContaining({ code: 'KeyC' }),
    }))
  })

  it('sends nothing for a shortcut, a key or a copy while the dialog is open', () => {
    const { send, container } = renderViewer({ captureOpen: true })
    // Keyboard capture is on as it would be after a click on the screen; the dialog still wins.
    pressScreen(container)
    send.mockClear()
    turnShortcut()
    typedKey()
    copyChord()
    expect(send).not.toHaveBeenCalled()
  })
})
