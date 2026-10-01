import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * **Both viewers put the hardware buttons in the Device group's "⋯" menu** (#785 follow-up).
 *
 * iOS's volume, power and Action were reachable only on the device frame, which deliberately has no
 * name or focus (`packages/dashboard/AGENTS.md` → "The streamed device is out of scope"; the fix it
 * names is toolbar parity). The Device group was already at the "about four" line, so the buttons
 * arrive in a menu, and Android's move into the same menu so the two toolbars keep one layout.
 * `ToolbarOverflowMenu.test.tsx` holds the menu itself; this holds what each viewer puts in it and sends.
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
import { AndroidViewer } from '@/components/device/AndroidViewer'

const common = (send: ReturnType<typeof vi.fn>) => ({
  sessionId: 's1', send, openUrl: vi.fn(), launchApp: vi.fn(),
  connected: true, joined: true, deviceReady: true, installing: false, installed: true,
  installError: null, bootError: null, launching: false,
  binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
  clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
  rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
})

const input = (name: string, title: string, usagePage: number, usage: number, anchor: string, x: number, y: number) => ({
  name, accessibilityTitle: title, anchor, onTop: false,
  normalOffset: { x, y }, rolloverOffset: { x, y }, buttonW: 24, buttonH: 100, usagePage, usage,
})
const chromeWith = (buttons: unknown[], w = 640, h = 1240) => ({
  framePng: '', bezelWidth: 600, bezelHeight: 1200, compositeWidth: w, compositeHeight: h,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: w - 80, height: h - 80 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons,
})
// iPhone 15 Pro's inputs, by HID usage as Apple's chrome states them.
const IPHONE_15_PRO = [
  input('action', 'Action', 11, 45, 'left', 16, 300),
  input('volume-up', 'Volume Up', 12, 233, 'left', 16, 420),
  input('volume-down', 'Volume Down', 12, 234, 'left', 16, 560),
  input('power', 'Sleep/Wake', 12, 48, 'right', 624, 500),
]
// An older iPhone: a ring/silent switch where the Action button would be.
const IPHONE_WITH_MUTE = [
  input('mute', 'Mute', 11, 46, 'left', 16, 300),
  ...IPHONE_15_PRO.slice(1),
]

function renderIOS(buttons: unknown[], over: Record<string, unknown> = {}) {
  const send = vi.fn()
  const props = {
    ...common(send), chrome: chromeWith(buttons),
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(), ...over,
  } as unknown as React.ComponentProps<typeof IOSViewer>
  render(<IOSViewer {...props} />)
  return { send, user: userEvent.setup() }
}

const menuNames = () => screen.getAllByRole('menuitem').map((m) => m.textContent)
const buttonsSent = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([m]) => m as { type: string; payload?: { name?: string; phase?: string } })
    .filter((m) => m.type === 'input:button')

describe('iOS — hardware buttons in the Device group menu', () => {
  // Mutations: pick by name instead of HID usage; leave Action out; put mute in.
  it('offers volume, power and Action, in that order, named as the chrome names them', async () => {
    const { user } = renderIOS(IPHONE_15_PRO)
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    expect(menuNames()).toEqual(['Volume Up', 'Volume Down', 'Sleep/Wake', 'Action'])
  })

  // A ring/silent switch is a toggle; "press it once" does not mean anything clear.
  it('leaves out a mute switch, and has no Action on a device without one', async () => {
    const { user } = renderIOS(IPHONE_WITH_MUTE)
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    expect(menuNames()).toEqual(['Volume Up', 'Volume Down', 'Sleep/Wake'])
  })

  // One press, no phase — the agent's single-press path. Volume keeps the menu open.
  //
  // Mutation: send a `down` phase, which leaves the HID button held.
  it('presses the chrome button once, and keeps the menu open for volume', async () => {
    const { send, user } = renderIOS(IPHONE_15_PRO)
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    await user.click(screen.getByRole('menuitem', { name: 'Volume Up' }))
    await user.click(screen.getByRole('menuitem', { name: 'Volume Up' }))
    expect(buttonsSent(send).map((m) => [m.payload?.name, m.payload?.phase])).toEqual([['volume-up', undefined], ['volume-up', undefined]])
    await user.click(screen.getByRole('menuitem', { name: 'Sleep/Wake' }))
    expect(buttonsSent(send).at(-1)?.payload?.name).toBe('power')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // An iPad's volume follows orientation (#911): the names match the tooltips on the frame, and
  // the press still sends the physical button.
  //
  // Mutation: use `accessibilityTitle` for the menu.
  it('names an iPad\'s volume by what it does once turned', async () => {
    const tablet = [
      input('volume-up', 'Volume Up', 12, 233, 'right', 630, 200),
      input('volume-down', 'Volume Down', 12, 234, 'right', 630, 330),
      input('power', 'Sleep/Wake', 12, 48, 'top', 500, 0),
    ]
    const { send, user } = renderIOS(tablet, { formFactor: 'tablet' })
    await user.click(screen.getByRole('button', { name: /rotate the device/i }))
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    expect(menuNames().slice(0, 2)).toEqual(['Volume Down', 'Volume Up'])
    await user.click(screen.getByRole('menuitem', { name: 'Volume Down' }))
    expect(buttonsSent(send).at(-1)?.payload?.name).toBe('volume-up')
  })

  it('offers no menu when the chrome has none of these buttons', () => {
    renderIOS([])
    expect(screen.queryByRole('button', { name: 'More device buttons' })).toBeNull()
  })
})

describe('Android — the same menu, in place of the inline buttons', () => {
  const ANDROID_BUTTONS = [
    { name: 'home', accessibilityTitle: 'Home', keyCode: 3 },
    { name: 'back', accessibilityTitle: 'Back', keyCode: 4 },
    { name: 'recent_apps', accessibilityTitle: 'Recent apps', keyCode: 187 },
    { name: 'volume_up', accessibilityTitle: 'Volume up', keyCode: 24 },
    { name: 'volume_down', accessibilityTitle: 'Volume down', keyCode: 25 },
    { name: 'power', accessibilityTitle: 'Power', keyCode: 26 },
  ]
  function renderAndroid() {
    const send = vi.fn()
    const props = {
      ...common(send), androidButtons: ANDROID_BUTTONS, screenWidth: 1080, screenHeight: 2400, streamRotation: 0,
    } as unknown as React.ComponentProps<typeof AndroidViewer>
    render(<AndroidViewer {...props} />)
    return { send, user: userEvent.setup() }
  }

  // Mutation: keep the inline buttons too. Volume would then be in the toolbar twice.
  it('moves volume and power into the menu, and leaves navigation where it was', async () => {
    const { user } = renderAndroid()
    expect(screen.queryByRole('button', { name: 'Volume up' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    expect(menuNames()).toEqual(['Volume up', 'Volume down', 'Power'])
  })

  it('sends what the inline buttons sent', async () => {
    const { send, user } = renderAndroid()
    await user.click(screen.getByRole('button', { name: 'More device buttons' }))
    await user.click(screen.getByRole('menuitem', { name: 'Power' }))
    expect(buttonsSent(send).map((m) => m.payload)).toEqual([{ name: 'power' }])
  })
})
