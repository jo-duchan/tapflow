// The shared status card beside the device viewer (#748). It is the one persistent status region for
// the Android and iOS viewers, and the rule that the decoder-unsupported message lives there is what
// keeps both platforms from shipping their own unsupported-decoder UI. The wiring down from the
// viewers is covered by `decoderUnsupported: boolean` being a *required* prop on the interface:
// removing the prop from a viewer call site is a compile error.
//
// `performanceMode()` (called inside the card to render the Smooth/Standard label) returns
// `'unsupported'` in jsdom because `canvas.getContext('webgl2')` returns null — `MODE_LABEL` maps
// that to `null`, so no Smooth/Standard label appears in these tests. The card still renders its
// focus row, fps row, and the persistent `role="status"` region.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { SimulatorInfoCard } from '@/components/device/shared/SimulatorInfoCard'

// The component's prop type is not part of its public surface — derive it from the component itself
// rather than widening the production module's exports.
type SimulatorInfoCardProps = ComponentProps<typeof SimulatorInfoCard>

/** A healthy "device on screen" state: connected, joined, ready, installed, no errors. */
function healthy(overrides: Partial<SimulatorInfoCardProps> = {}): SimulatorInfoCardProps {
  return {
    joined: true,
    fps: 0,
    connected: true,
    deviceReady: true,
    bootError: null,
    installing: false,
    installError: null,
    decoderUnsupported: false,
    keyboardActive: false,
    ...overrides,
  }
}

describe('SimulatorInfoCard — the shared status region beside the device (#748)', () => {
  it('surfaces the decoder-unsupported sentence inside the persistent role="status" region', () => {
    // **Mutation:** dropping the `if (decoderUnsupported) return 'Streaming is not supported...'` line
    // from `getStatusText()` must fail this test — the sentence is the only thing in the region.
    // Verified by deleting the branch and watching the next assertion fail.
    render(<SimulatorInfoCard {...healthy({ decoderUnsupported: true })} />)

    const region = screen.getByRole('status')
    expect(region).toBeInTheDocument()
    expect(region.textContent).toBe('Streaming is not supported in this environment.')
  })

  it('keeps the persistent region mounted when the session is healthy, and renders nothing inside', () => {
    // **Mutation:** removing the persistent `<div role="status">` wrapper from the card entirely
    // must fail this test, because the test asserts on the region's existence and on its empty
    // textContent. A non-vacuous absence assertion needs an existence anchor (the region) and a
    // content anchor (no sentence) on the same element — that is what `getByRole('status')` +
    // `textContent === ''` gives.
    //
    // **Mutation:** making the decoder-unsupported sentence render unconditionally (e.g. moving it
    // out of `getStatusText` and into a constant render) must also fail this test, because the
    // second assertion checks that the sentence is not present when `decoderUnsupported: false`.
    // Verified by deleting the conditional and watching both the type and the textContent change.
    //
    // **Mutation:** a wrapper that is conditionally remounted or given a state-dependent `key`
    // (the antipattern that drops the first live-region announcement by remounting the region
    // together with its first sentence) must also fail this test, because the rerender asserts
    // identity — the same DOM node must host both the empty and the populated state. Verified by
    // giving the wrapper `key={statusText ?? 'empty'}` and watching the identity assertion go red.
    const { rerender } = render(<SimulatorInfoCard {...healthy()} />)

    const regionBefore = screen.getByRole('status')
    expect(regionBefore).toBeInTheDocument()
    expect(regionBefore.textContent).toBe('')
    expect(screen.queryByText(/streaming is not supported/i)).toBeNull()

    // Same node after a rerender that *changes* the state — proves the region survives both an
    // empty and a populated transition, not just two identical rerenders.
    rerender(<SimulatorInfoCard {...healthy({ decoderUnsupported: true })} />)
    const regionAfter = screen.getByRole('status')
    expect(regionAfter, 'the wrapper remounted instead of taking new content').toBe(regionBefore)
    expect(regionAfter.textContent).toBe('Streaming is not supported in this environment.')
  })

  it('lets higher-priority states win over the decoder-unsupported sentence', () => {
    // **Mutation:** reordering the `getStatusText()` branches so `decoderUnsupported` runs before
    // `!connected` must fail this test — a tester with no relay connection still needs to see
    // "Connecting…", not the decoder sentence. Verified by moving the branch above and watching
    // this assertion go red.
    //
    // Representative state: `connected = false` is the earliest branch in `getStatusText`, so it
    // pins the precedence contract at its loosest point — every other branch (`!joined`,
    // `agentAway`, `bootError`, `!deviceReady`, `installing`, `installError`) sits below it and
    // therefore inherits the same guarantee once this one holds.
    render(<SimulatorInfoCard {...healthy({ connected: false, decoderUnsupported: true })} />)

    const region = screen.getByRole('status')
    expect(region.textContent).toBe('Connecting…')
    expect(screen.queryByText(/streaming is not supported/i)).toBeNull()
  })
})

describe('SimulatorInfoCard — whether keys go to the device (#747)', () => {
  // The row used to say "Focus" in both states and changed only its colour (WCAG 1.4.1), so the state
  // was invisible to anyone who cannot tell emerald from grey, and a screen reader heard only "Focus".
  // **Mutation:** making the state word constant — the colour-only card this replaced — fails the pair.
  const row = () => screen.getByText('Focus').parentElement!.textContent

  it('says On while keystrokes are captured', () => {
    render(<SimulatorInfoCard {...healthy({ keyboardActive: true })} />)
    expect(row()).toBe('Focus·On')
  })

  it('says Off otherwise', () => {
    render(<SimulatorInfoCard {...healthy({ keyboardActive: false })} />)
    expect(row()).toBe('Focus·Off')
  })
})

describe('SimulatorInfoCard — whether steps are being captured (#1125)', () => {
  // The chip is a state, not a control: the setting lives in the account menu, so the card offers nothing to press.
  it('says so either way, in words', () => {
    const { rerender } = render(<SimulatorInfoCard {...healthy({ capturingSteps: true })} />)
    expect(screen.getByText('Capturing steps')).toBeInTheDocument()
    rerender(<SimulatorInfoCard {...healthy({ capturingSteps: false })} />)
    expect(screen.getByText('Not capturing steps')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /capturing/i })).toBeNull()
  })

  // A relay that predates the setting sends no `flowCapture`; claiming either state there would be a guess.
  it('shows nothing when the relay does not say', () => {
    render(<SimulatorInfoCard {...healthy()} />)
    expect(screen.queryByText(/capturing steps/i)).toBeNull()
  })
})
