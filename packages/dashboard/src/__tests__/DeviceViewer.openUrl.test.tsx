import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInbound } from '@/lib/types'

// A reply does not go to whoever asked — the relay forwards it to whichever socket holds the session — so
// before `open-url` carried a `requestId` this viewer toasted "Deeplink opened" for an `mcp-server`
// deeplink it knew nothing about. The viewer mints and records the id now and toasts only its own.
//
// These tests exist because the change shipped without them once. The agent side was covered and the
// browser side was not, which is the same gap that let the whole thing pass the iOS suite.
//
// They drive the **real path** — ⌘K, type, Enter — rather than calling `openUrl` directly, so what is
// pinned is that the id recorded is the id sent. Calling the callback would pass even if the two came
// apart.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('sonner', () => ({ toast }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** ⌘K → type → Enter, and hand back the `requestId` that actually went out. */
function sendDeeplink(url: string): string {
  fireEvent.keyDown(window, { code: 'KeyK', metaKey: true })
  const input = screen.getByLabelText('Deeplink URL')
  fireEvent.change(input, { target: { value: url } })
  fireEvent.keyDown(input, { key: 'Enter' })
  const call = send.mock.calls.map(([m]) => m).filter((m) => m.type === 'open-url').at(-1)
  expect(call, 'no open-url was sent').toBeDefined()
  return call.requestId as string
}

/** Brings a viewer to a state where the deeplink dialog is reachable. The chrome matters: the ⌘K handler
 *  lives in `IOSViewer`, which `DeviceViewer` renders only once `session:chrome` has arrived. */
function live(platform: 'ios' | 'android' = 'ios') {
  const sessionId = 'mine'
  render(<><button>Previous control</button><DeviceViewer sessionId={sessionId} deviceId="dev-1" /></>)
  act(() => { deliver!({ type: 'session:joined', sessionId, capabilities: [] }) })
  const payload = platform === 'ios' ? CHROME : { buttons: [], streamType: 'h264' as const }
  act(() => { deliver!({ type: 'session:chrome', sessionId, payload }) })
  act(() => { deliver!({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1' } }) })
}

describe('DeviceViewer only toasts the deeplink replies it asked for', () => {
  beforeEach(() => {
    send.mockClear()
    toast.success.mockClear()
    toast.error.mockClear()
    deliver = null
  })

  it('sends a requestId and toasts the reply carrying it', async () => {
    live()
    const id = sendDeeplink('myapp://home')
    expect(id).toMatch(/^[0-9a-f]{32}$/)

    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: id }) })
    expect(toast.success).toHaveBeenCalledWith('Deeplink opened')
  })

  it('ignores a reply for a deeplink it did not send', async () => {
    live()
    sendDeeplink('myapp://home')

    // Same session, different request — an `mcp-server` deeplink on a session this tab holds. This is
    // the case the change exists for.
    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: 'someone-elses' }) })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('toasts an error reply carrying its id, with the producer prose', async () => {
    live()
    const id = sendDeeplink('myapp://home')

    act(() => { deliver!({ type: 'open-url:error', sessionId: 'mine', requestId: id, message: 'no handler' }) })
    expect(toast.error).toHaveBeenCalledWith('no handler')
  })

  it('toasts once when the same reply arrives twice', async () => {
    live()
    const id = sendDeeplink('myapp://home')

    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: id }) })
    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: id }) })
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('still toasts after a rejoin — the record survives a socket blip', async () => {
    live()
    const id = sendDeeplink('myapp://home')

    // `session:joined` fires again on a reconnect. It resets several flags; it must not discard the
    // record of a request that is still in flight, or the reply that follows is dropped in silence.
    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })
    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: id }) })
    expect(toast.success).toHaveBeenCalledWith('Deeplink opened')
  })

  it('gives each deeplink its own id', async () => {
    live()
    const first = sendDeeplink('myapp://one')
    const second = sendDeeplink('myapp://two')
    expect(second).not.toBe(first)

    act(() => { deliver!({ type: 'open-url:done', sessionId: 'mine', requestId: first }) })
    act(() => { deliver!({ type: 'open-url:error', sessionId: 'mine', requestId: second, message: 'nope' }) })
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('nope')
  })
})

describe.each(['ios', 'android'] as const)('DeepLinkDialog focus on %s', (platform) => {
  it.each([
    ['toolbar', 'Escape'], ['toolbar', 'Enter'], ['toolbar', 'Open'],
    ['shortcut', 'Escape'], ['shortcut', 'Enter'], ['shortcut', 'Open'],
  ])('restores focus after opening from %s and closing with %s', async (opening, closing) => {
    const user = userEvent.setup()
    send.mockClear()
    live(platform)
    const previous = screen.getByRole('button', { name: 'Previous control' })
    const toolbar = screen.getByRole('button', { name: 'Open a deeplink' })
    previous.focus()
    expect(previous).toHaveFocus()

    // A pointer click need not focus the button (Safari), so the opener must come from the event.
    if (opening === 'toolbar') fireEvent.click(toolbar)
    else await user.keyboard('{Meta>}k{/Meta}')

    const input = screen.getByRole('textbox', { name: 'Deeplink URL' })
    await waitFor(() => expect(input).toHaveFocus())
    if (closing === 'Escape') await user.keyboard('{Escape}')
    else {
      await user.type(input, 'myapp://home')
      if (closing === 'Enter') await user.keyboard('{Enter}')
      else await user.click(screen.getByRole('button', { name: 'Open' }))
      const requests = send.mock.calls.map(([message]) => message).filter(({ type }) => type === 'open-url')
      expect(requests).toEqual([expect.objectContaining({ payload: { url: 'myapp://home' } })])
    }

    await waitFor(() => expect(opening === 'toolbar' ? toolbar : previous).toHaveFocus())
  })
})

it('keeps the toolbar opener when Cmd+K reopens the dialog during its exit animation', async () => {
  const real = window.getComputedStyle.bind(window)
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo)
    if (!(element instanceof HTMLElement) || element.getAttribute('role') !== 'dialog') return style
    // Radix rereads the animation name on close from the style object it saved on mount.
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'animationName') return element.dataset.state === 'closed' ? 'exit' : 'enter'
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  try {
    const user = userEvent.setup()
    live()
    const toolbar = screen.getByRole('button', { name: 'Open a deeplink' })
    await user.click(toolbar)
    const dialog = screen.getByRole('dialog', { name: 'Open Deeplink' })
    const input = screen.getByRole('textbox', { name: 'Deeplink URL' })
    await user.type(input, 'myapp://home')
    await user.tab()
    const submit = screen.getByRole('button', { name: 'Open' })
    expect(submit).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(dialog).toHaveAttribute('data-state', 'closed')
    expect(submit).toHaveFocus()
    await user.keyboard('{Meta>}k{/Meta}')
    expect(dialog).toHaveAttribute('data-state', 'open')
    const reopenedInput = screen.getByRole('textbox', { name: 'Deeplink URL' })
    await waitFor(() => expect(reopenedInput).toHaveFocus())
    expect(reopenedInput).toHaveValue('')

    await user.keyboard('{Escape}')
    const end = new Event('animationend', { bubbles: true })
    Object.defineProperty(end, 'animationName', { value: 'exit' })
    fireEvent(dialog, end)
    await waitFor(() => expect(toolbar).toHaveFocus())
  } finally {
    styles.mockRestore()
  }
})
