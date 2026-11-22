import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { CapturedFlow, CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import { EditScreen } from '@/components/flow-capture/screens'
import { initialState, type CaptureState } from '@/lib/flowCapture/machine'
import { copy } from '@/lib/flowCapture/copy'

// #1178: a step Match waved through as mostly different says so in Edit, under the `fragile` badge a step that may not
// do what was recorded already carries — and beside a fragile reason it has of its own, not in place of it.
afterEach(cleanup)

const raw = (kind: string): RawStep => ({ at: 0, endAt: 0, outcome: 'landed', messages: [], kind, point: [0.5, 0.5] }) as unknown as RawStep
const tap = (text: string, over: Partial<CapturedStep> = {}): CapturedStep =>
  ({ raw: raw('tap'), step: { type: 'tapOn', selector: { text } }, ...over }) as CapturedStep
const captured: CapturedFlow = {
  launchAdded: false,
  secrets: {},
  steps: [
    { raw: raw('launch'), step: { type: 'launchApp' } } as CapturedStep,
    tap('Menu'),
    tap('Truck', { notCompared: true }),
    tap('Forecast', { fragile: 'not-centre', notCompared: true }),
    tap('Hold', { skipped: 'hold-drag', notCompared: true }),
  ],
}
const state: CaptureState = { ...initialState, phase: 'edit', captured, name: 'Order', reached: 3, screenshots: [] }

// The row's own button: its name is the step's label, where Remove's begins with "Remove".
const rowOf = (text: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^#\\d+.*${text}`) }).closest('li')!

describe('Edit, a step whose screen was not compared', () => {
  const draw = () => render(<EditScreen state={state} dispatch={vi.fn()} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />)

  it('is marked fragile and says why', () => {
    draw()
    const row = rowOf('Truck')
    expect(row.textContent).toContain(copy.fragile)
    expect(row.textContent).toContain(copy.notComparedReason)
  })

  it('keeps a fragile reason of its own, first, under one badge', () => {
    draw()
    const row = rowOf('Forecast')
    const text = row.textContent ?? ''
    expect(text.split(copy.fragile)).toHaveLength(2)
    expect(text.indexOf(copy.fragileReasons['not-centre'])).toBeGreaterThan(-1)
    expect(text.indexOf(copy.fragileReasons['not-centre'])).toBeLessThan(text.indexOf(copy.notComparedReason))
  })

  // Design review: a step left out of the flow says only why, with no fragile badge beside "not in the flow".
  it('says only why a step left out is not in the flow', () => {
    draw()
    const text = rowOf('Hold').textContent ?? ''
    expect(text).toContain(copy.skipReasons['hold-drag'])
    expect(text).not.toContain(copy.fragile)
    expect(text).not.toContain(copy.notComparedReason)
  })

  it('leaves a step that was compared as it was', () => {
    draw()
    const text = rowOf('Menu').textContent ?? ''
    expect(text).not.toContain(copy.fragile)
    expect(text).not.toContain(copy.notComparedReason)
  })
})
