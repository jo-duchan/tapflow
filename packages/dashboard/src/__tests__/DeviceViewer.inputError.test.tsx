import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen, fireEvent } from '@testing-library/react'
import type { InputErrorReason } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'
import { INPUT_ERROR_NOTICE } from '@/lib/inputErrorNotice'

// #485. The relay forwards `input:done` / `input:error` to the browser and the dashboard used to drop
// both. After #484/#488/#490 the agents tell the truth about a dropped input, and the truth was being
// thrown away before it reached a human.
//
// There is no session-level state behind this on purpose — a latch was designed, reviewed and
// discarded (see the plan). Two of the tests below are regression guards for that decision rather
// than for the feature.
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
const toastError = vi.fn()
const toastDismiss = vi.fn()
const toastInfo = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: toastInfo, dismiss: toastDismiss },
}))
/** Every surface a latch could be rebuilt on. A guard that watched only `dismiss` would pass a latch
 *  implemented as a second toast. */
const quiet = () => [toastDismiss, toastInfo, toastSuccess].forEach((f) => expect(f).not.toHaveBeenCalled())

// The dialog itself is not what is tested here, only that the viewer knows it is open.
vi.mock('@/components/flow-capture/FlowCaptureDialog', () => ({ default: () => null }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

function mounted() {
  render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
}

/** An `input:error` as the agents send it. `reason` is typed loosely so a test can post a value this
 *  build does not know about — the case the unknown-reason rule exists for. */
function inputError(reason?: string, message = 'input channel not ready') {
  act(() => {
    deliver!({ type: 'input:error', sessionId: 's1', message, reason } as unknown as BrowserInbound)
  })
}

/** The same message with no prose at all. Legal since #491 demoted `message` to optional, and this
 *  fixture is the only thing between that and a toast reading "(undefined)" to a PO or a designer —
 *  a template literal takes `string | undefined` without complaint and no lint rule here forbids it. */
function inputErrorWithoutMessage(reason: string) {
  act(() => {
    deliver!({ type: 'input:error', sessionId: 's1', reason } as unknown as BrowserInbound)
  })
}

const opts = () => toastError.mock.calls.map(([, o]) => o as { id: string; description: string; duration: number })

describe('DeviceViewer — input:error (#485)', () => {
  beforeEach(() => { [toastError, toastDismiss, toastInfo, toastSuccess].forEach((f) => f.mockClear()); deliver = null })

  it('tells the tester when input is not reaching the device', () => {
    mounted()
    inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(opts()[0]!.id).toBe('input:s1:channel-unavailable')
    // The lifetime IS the state here — it is what makes the notice disappear once inputs stop
    // failing, with nothing on the wire to clear it. `Infinity` would make the toast permanent, which
    // is the opposite of the design, so this is pinned rather than left to a default.
    expect(opts()[0]!.duration).toBe(6000)
    expect(opts()[0]!.duration).toBeGreaterThan(4000) // sonner's default, short enough to lapse between two unhurried taps
  })

  // **#491 made `message` optional, and this is where its absence reaches a person.** A producer that
  // sends only a reason is legal now, and the description used to interpolate the field unguarded —
  // so the tester would read "Start it again to continue testing. (undefined)". Nothing else could
  // catch it: a template literal accepts `string | undefined`, `restrict-template-expressions` is
  // configured nowhere in this repo, and every other fixture here defaults `message` to a string.
  it('drops the parenthetical when the producer sent no prose', () => {
    mounted()
    inputErrorWithoutMessage('not-booted')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(opts()[0]!.description).toBe(INPUT_ERROR_NOTICE['not-booted']!.action)
    expect(opts()[0]!.description).not.toMatch(/undefined|\(\s*\)/)
  })

  // And the prose is still shown when there is some — the guard must not have turned it off.
  it('still shows the prose when the producer sent it', () => {
    mounted()
    inputError('not-booted', 'simulator is shutting down')
    expect(opts()[0]!.description).toContain('simulator is shutting down')
  })

  // A dead channel produces one error per tap, at whatever rate the tester taps. Nothing dedupes
  // them here — every call carries the same `id`, and sonner refreshes that toast rather than
  // stacking a new one, which is also what keeps it on screen while the taps continue.
  it('reuses one toast id across a burst so repeats refresh rather than stack', () => {
    mounted()
    for (let i = 0; i < 5; i++) inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(5)
    expect(new Set(opts().map((o) => o.id)).size).toBe(1)
  })

  // The protocol prescribes a different action for this than for `channel-unavailable` — boot the
  // device, rather than reconnect — so one shared line would be wrong for one of them.
  it('gives not-booted its own copy', () => {
    mounted()
    inputError('not-booted')
    inputError('channel-unavailable')
    const [notBooted, unavailable] = toastError.mock.calls.map(([t]) => t as string)
    expect(notBooted).not.toBe(unavailable)
    expect(notBooted).toBe(INPUT_ERROR_NOTICE['not-booted']!.title)
    // Both halves, not just the headline: sharing the *action* would still give one of the two the
    // wrong instruction, which is the entire reason this reason is not folded into the other.
    expect(opts()[0]!.description).toContain(INPUT_ERROR_NOTICE['not-booted']!.action)
    expect(opts()[1]!.description).toContain(INPUT_ERROR_NOTICE['channel-unavailable']!.action)
  })

  it('carries the wire message as diagnostic detail, not as the headline', () => {
    mounted()
    inputError('unsupported', 'unknown key code: KeyFoo')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE.unsupported!.title)
    expect(opts()[0]!.description).toContain('unknown key code: KeyFoo')
    // What to do about it has to survive the trip too — the wire message alone is a symptom.
    expect(opts()[0]!.description).toContain(INPUT_ERROR_NOTICE.unsupported!.action)
  })

  // Android's default emulator backend answers an unreachable emulator with this, not with
  // `channel-unavailable`: the RPC rejects (measured 4ms, `ECONNREFUSED`) while `isReady()` still
  // reports true, because on that backend it only means "we have not closed it".
  it('surfaces dispatch-failed', () => {
    mounted()
    inputError('dispatch-failed', 'the device rejected the input')
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('surfaces malformed — a dashboard bug is never silent', () => {
    mounted()
    inputError('malformed', 'this input does not fit what the device is doing')
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it.each(['channel-starting', 'no-gesture'])('shows nothing for %s — it fixes itself', (reason) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    mounted()
    inputError(reason, 'no gesture is in progress to complete — start a new one')
    expect(toastError).not.toHaveBeenCalled()
    quiet()
    // Shown nowhere is not the same as dropped: the reason still has to be findable, or a silent cell
    // becomes indistinguishable from a handler that forgot the case.
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain(reason)
    debug.mockRestore()
  })

  // Absence means unknown, never fine: an agent older than #490 omits the field. Every in-repo
  // producer sends one now — the relay was the last that did not (#492) — so the fixture below is an
  // old agent rather than any current sender.
  it('treats an absent reason as channel-unavailable', () => {
    mounted()
    inputError(undefined, 'agent offline')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(opts()[0]!.id).toBe('input:s1:channel-unavailable')
  })

  // A newer agent against this build. Silence would be the dangerous direction — the reason exists
  // because something went wrong, and a build that cannot name it still must not imply "fine".
  it('treats a reason it does not know as channel-unavailable, under one id', () => {
    mounted()
    inputError('some-future-reason')
    inputError('another-future-reason')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(new Set(opts().map((o) => o.id)).size).toBe(1)
  })

  // Normalising an unknown reason is right for the tester and lossy for everyone else: without a
  // trace, a dashboard running behind its agents looks identical to one seeing a genuinely dead
  // channel. The name it did not recognise is the only clue that the union has moved on.
  it('leaves a trace of a reason it did not recognise', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    mounted()
    inputError('some-future-reason')
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('some-future-reason')
    debug.mockRestore()
  })

  // An agent older than #490 omits the field on every single input. Logging that would be noise about
  // a state the protocol documents as normal.
  it('does not log for an absent reason', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    mounted()
    inputError(undefined, 'agent offline')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
    debug.mockRestore()
  })

  it('does not read a prototype key as a notice', () => {
    mounted()
    inputError('toString')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
  })

  it('ignores an input:error for another session', () => {
    mounted()
    act(() => {
      deliver!({ type: 'input:error', sessionId: 'other', requestId: 'rq-other', message: 'x', reason: 'channel-unavailable' })
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  // While the agent is away the *relay* answers every terminal input itself, so a
  // tapping tester would keep this toast alive indefinitely — with advice that contradicts the status
  // card, which already says the relay is holding the session and waiting. `device:boot-error`
  // suppresses in the same state for the same kind of reason.
  it('stays quiet while the agent is away', () => {
    mounted()
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })
    inputError(undefined, 'agent offline')
    inputError('channel-unavailable')
    expect(toastError).not.toHaveBeenCalled()
  })

  // --- regression guards for the discarded latch design ---

  // `input:done` was only ever needed to release a latch. Handling it would mean the latch is back,
  // and the review found three independent sequences in which that latch lies.
  it('does nothing on input:done', () => {
    mounted()
    inputError('channel-unavailable')
    act(() => { deliver!({ type: 'input:done', sessionId: 's1', requestId: 'rq-done' }) })
    quiet()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  // The sequence both review channels found independently: on Android a button always takes the adb
  // path while touch takes the pointer channel, so a tester checking "is input dead at all?" with
  // Home gets a success — which under the latch design erased the warning about the dead touch
  // channel. Here the success changes nothing and the next failure speaks for itself.
  it('lets a success between two failures change nothing', () => {
    mounted()
    inputError('channel-unavailable')
    act(() => { deliver!({ type: 'input:done', sessionId: 's1', requestId: 'rq-done' }) })
    inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(2)
    quiet()
  })
})

describe('INPUT_ERROR_NOTICE', () => {
  // The Record is what forces a decision per reason; this only pins that no entry was left as an
  // empty string, which the type cannot express. A new reason fails at `tsc`, not here.
  const shown = (Object.entries(INPUT_ERROR_NOTICE) as Array<[InputErrorReason, typeof INPUT_ERROR_NOTICE[InputErrorReason]]>)
    .filter((e): e is [InputErrorReason, NonNullable<typeof e[1]>] => e[1] !== null)

  it('gives every non-silent reason both a title and an action', () => {
    for (const [reason, notice] of shown) {
      expect(notice.title.trim(), reason).not.toBe('') // `.length > 0` would accept a single space
      expect(notice.action.trim(), reason).not.toBe('')
    }
  })

  // The reason a reason exists is that a consumer must do something different. Two of them sharing
  // wording means one is being given the other's instruction — the defect `not-booted` was split out
  // to avoid — and `tsc` cannot see it, because a `Record` only checks that every key is present.
  it('gives no two shown reasons the same wording', () => {
    for (const field of ['title', 'action'] as const) {
      const values = shown.map(([, n]) => n[field])
      expect(new Set(values).size, field).toBe(values.length)
    }
  })
})

// Flow Capture's dialog replays and verifies through the same socket, and a step that does not land answers with
// `input:error`. The dialog says so itself; a toast behind it would be hidden from a screen reader and repeat the
// dialog's own message to everyone else.
describe('DeviceViewer — input:error while Flow Capture is open', () => {
  beforeEach(() => { [toastError, toastDismiss, toastInfo, toastSuccess].forEach((f) => f.mockClear()); deliver = null })

  const CHROME = {
    framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
    compositeWidth: 100, compositeHeight: 200,
    padding: { left: 0, right: 0, top: 0, bottom: 0 },
    screenRect: { x: 0, y: 0, width: 100, height: 200 },
    screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
  }

  function capturing() {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} capturingSteps />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME } as unknown as BrowserInbound) })
  }

  it('toasts while the dialog is closed', () => {
    capturing()
    inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('does not toast while the dialog is open', () => {
    capturing()
    fireEvent.click(screen.getByRole('button', { name: 'Capture flow' }))
    inputError('channel-unavailable')
    expect(toastError).not.toHaveBeenCalled()
  })
})
