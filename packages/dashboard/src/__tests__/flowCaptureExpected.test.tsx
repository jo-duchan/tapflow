import { useReducer } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CapturedFlow, CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import type { UIElement } from '@tapflowio/protocol'
import { EditScreen } from '@/components/flow-capture/screens'
import { editedCapture, flowOf, yamlOf } from '@/lib/flowCapture/flow'
import { initialState, reduce, type CaptureState } from '@/lib/flowCapture/machine'

// 1b-3c: what a person expects a tap to bring, picked on the screen the tap left, written as an `assertVisible` after it.
afterEach(cleanup)

const raw = (kind: string): RawStep => ({ at: 0, endAt: 0, outcome: 'landed', messages: [], kind, point: [0.5, 0.5] }) as unknown as RawStep
const el = (label: string, over: Partial<UIElement> = {}): UIElement => ({ role: 'text', label, frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 }, enabled: true, ...over })
const captured: CapturedFlow = {
  launchAdded: false,
  secrets: {},
  steps: [
    { raw: raw('launch'), step: { type: 'launchApp' } } as CapturedStep,
    { raw: raw('tap'), step: { type: 'tapOn', selector: { text: 'Place order' } }, tree: [el('Place order')] } as CapturedStep,
    { raw: raw('tap'), step: { type: 'tapOn', selector: { label: 'Row', index: 2 } } } as CapturedStep,
    { raw: raw('text'), step: { type: 'inputText', text: 'alice@x.com', replace: true } } as CapturedStep,
  ],
}
const afterScreen = { tree: [el('Order complete'), el('Total ₩32,000', { identifier: 'cart.total', frame: { x: 0.1, y: 0.4, width: 0.5, height: 0.05 } }), el('Place order', { frame: { x: 0.1, y: 0.6, width: 0.5, height: 0.05 } })], screenshot: 'blob:after' }
const edit: CaptureState = reduce(
  { ...initialState, phase: 'edit', captured, name: 'Order', reached: 3, screenshots: ['blob:0', 'blob:1', 'blob:2', 'blob:3'], verify: { status: 'passed', done: 4, live: [] } },
  { type: 'step-after', index: 1, after: afterScreen },
)
const total = { id: 'cart.total', label: 'Total ₩32,000', exact: true as const }

describe('what the flow gets', () => {
  it('writes an expected element as an exact assertVisible right after its tap, and drops the last verification', () => {
    const added = reduce(edit, { type: 'add-expected', index: 1, selector: total })
    expect(added.verify).toBeNull()
    const steps = editedCapture(added)!.steps.map((s) => s.step?.type)
    expect(steps).toEqual(['launchApp', 'tapOn', 'assertVisible', 'tapOn', 'inputText'])
    expect(yamlOf(flowOf(added, 'com.example')!)).toMatch(/assertVisible:\s*\n\s*id: cart\.total\s*\n\s*label: Total ₩32,000\s*\n\s*exact: true/)
  })

  it('goes with its tap when the tap is removed, and with a new replay', () => {
    const added = reduce(edit, { type: 'add-expected', index: 1, selector: total })
    expect(editedCapture(reduce(added, { type: 'remove-step', index: 1 }))!.steps.map((s) => s.step?.type)).toEqual(['launchApp', 'tapOn', 'inputText'])
    const again = reduce(added, { type: 'match-started', total: 4 })
    expect(again.expected).toEqual({})
    expect(again.after).toEqual({})
  })

  // Design review of 1b-3c: a secret made after the element was picked must still keep its value out of the file.
  it('leaves out an expected element whose text holds a secret, whenever the secret was made', () => {
    const signedIn = { label: 'Signed in as alice@x.com', exact: true as const }
    const added = reduce(edit, { type: 'add-expected', index: 1, selector: signedIn })
    expect(editedCapture(added)!.steps.some((s) => s.step?.type === 'assertVisible')).toBe(true)
    const secret = reduce(added, { type: 'make-secret', index: 3 })
    expect(editedCapture(secret)!.steps.some((s) => s.step?.type === 'assertVisible')).toBe(false)
  })

  // CodeRabbit on #1158: removing the step made a secret does not let its value back into the file.
  it('keeps a made secret\'s value out of the file after its step is removed', () => {
    const signedIn = { label: 'Signed in as alice@x.com', exact: true as const }
    const gone = reduce(reduce(reduce(edit, { type: 'add-expected', index: 1, selector: signedIn }), { type: 'make-secret', index: 3 }), { type: 'remove-step', index: 3 })
    expect(editedCapture(gone)!.steps.some((s) => s.step?.type === 'assertVisible')).toBe(false)
  })

  it('takes one element once, and removes it by its place', () => {
    const twice = reduce(reduce(edit, { type: 'add-expected', index: 1, selector: total }), { type: 'add-expected', index: 1, selector: total })
    expect(twice.expected[1]).toHaveLength(1)
    expect(reduce(twice, { type: 'remove-expected', index: 1, n: 0 }).expected[1]).toEqual([])
  })
})

describe('Edit, a tap and the screen it left', () => {
  const draw = (state: CaptureState) => {
    const dispatch = vi.fn()
    render(<EditScreen state={state} dispatch={dispatch} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />)
    return dispatch
  }
  const row = (n: number) => screen.getAllByRole('listitem')[n]!
  const pick = (n: number) => fireEvent.click(within(row(n)).getAllByRole('button')[0]!)

  it('switches a tap\'s picture to the screen it left, and back when another step is chosen', () => {
    draw(edit)
    pick(1)
    expect(screen.getByRole('img', { name: 'tapOn("Place order")' })).toHaveAttribute('src', 'blob:1')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    expect(screen.getByRole('img', { name: 'The screen after #2' })).toHaveAttribute('src', 'blob:after')
    pick(0)
    expect(screen.getByRole('tab', { name: 'After this tap' })).toBeDisabled()
    pick(1)
    expect(screen.getByRole('tab', { name: 'At this tap' })).toHaveAttribute('aria-selected', 'true')
  })

  it('offers a picked element as what the tap should bring, exact, warning when it was there before', () => {
    const dispatch = draw(edit)
    pick(1)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' }))
    expect(screen.getByText('Expect “Total ₩32,000” after this tap')).toBeInTheDocument()
    expect(screen.getByText('Matches 1 element here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'add-expected', index: 1, selector: total })
    fireEvent.click(screen.getByRole('button', { name: 'Expect “Place order”' }))
    expect(screen.getByText(/It was on the screen before this tap too/)).toBeInTheDocument()
  })

  // Review of 1b-3c's design pass: Escape takes back the offer, not the dialog, and focus stays on the element.
  it('closes an offer with Escape and keeps focus on the element it was about', () => {
    draw(edit)
    pick(1)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    const total = screen.getByRole('button', { name: 'Expect “Total ₩32,000”' })
    fireEvent.click(total)
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add.closest('[data-escape-local]')).not.toBeNull()
    fireEvent.keyDown(add, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(total)
    expect(total.closest('[data-escape-local]')).toBeNull()
  })

  it('keeps the screen after a tap when the chosen step is chosen again, and drops what was shown on At', () => {
    draw(reduce(edit, { type: 'add-expected', index: 1, selector: total }))
    pick(1)
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Show “Total ₩32,000” on the screen after this tap' }))
    pick(1)
    expect(screen.getByRole('tab', { name: 'After this tap' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' })).toHaveClass('z-10')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'At this tap' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    expect(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' })).not.toHaveClass('z-10')
  })

  it('uses line tabs, whose press moves the label and not the underline', () => {
    draw(edit)
    pick(1)
    expect(screen.getByRole('tab', { name: 'At this tap' })).toHaveAttribute('data-press-label')
  })

  // Design review of 1b-3c: an element already expected is not offered again.
  it('says an element is already expected instead of offering it again', () => {
    draw(reduce(edit, { type: 'add-expected', index: 1, selector: total }))
    pick(1)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' }))
    expect(screen.getByText('Already expected after this tap.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('shows what is expected on the chosen tap, and how many on the rest', () => {
    const added = reduce(edit, { type: 'add-expected', index: 1, selector: total })
    draw(added)
    expect(within(row(1)).getByText('1 expected')).toBeInTheDocument()
    pick(1)
    expect(within(row(1)).getByRole('button', { name: 'Show “Total ₩32,000” on the screen after this tap' })).toBeInTheDocument()
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Show “Total ₩32,000” on the screen after this tap' }))
    expect(screen.getByRole('tab', { name: 'After this tap' })).toHaveAttribute('aria-selected', 'true')
    // Design review: + Add leaves the element shown, so the whole screen can be picked from again.
    expect(screen.getByRole('button', { name: 'Expect “Order complete”' })).not.toHaveClass('z-10')
    expect(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' })).toHaveClass('z-10')
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Add what this tap should bring' }))
    expect(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' })).not.toHaveClass('z-10')
  })

  // Review of 1b-3c: the control pressed goes away; focus must not fall to the page.
  it('keeps focus on the row: the chip just added, or + Add after a removal', async () => {
    function Harness() {
      const [state, dispatch] = useReducer(reduce, edit)
      return <EditScreen state={state} dispatch={dispatch} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />
    }
    render(<Harness />)
    pick(1)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'After this tap' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expect “Total ₩32,000”' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show “Total ₩32,000” on the screen after this tap' })))
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Total ₩32,000” from what this tap should bring' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add what this tap should bring' })))
  })

  // CodeRabbit on #1158: what the file leaves out is not shown as expected.
  it('strikes out an expected element the flow leaves out for a secret, and does not count it', () => {
    const signedIn = { label: 'Signed in as alice@x.com', exact: true as const }
    const struck = reduce(reduce(edit, { type: 'add-expected', index: 1, selector: signedIn }), { type: 'make-secret', index: 3 })
    draw(struck)
    expect(within(row(1)).queryByText('1 expected')).not.toBeInTheDocument()
    expect(within(row(1)).queryByText(/expected/)).toBeNull()
    pick(1)
    expect(within(row(1)).getByRole('button', { name: /left out of the flow/ })).toBeInTheDocument()
    expect(within(row(1)).getByText(/so the flow leaves it out/)).toBeInTheDocument()
  })

  it('takes the YAML away when an expected element is asked for', () => {
    draw(reduce(edit, { type: 'add-expected', index: 1, selector: total }))
    pick(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show YAML' }))
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Show “Total ₩32,000” on the screen after this tap' }))
    expect(screen.getByRole('img', { name: 'The screen after #2' })).toBeInTheDocument()
  })

  it('marks a step found by its place among elements alike', () => {
    draw(edit)
    expect(within(row(2)).getByText('by position')).toBeInTheDocument()
    expect(within(row(1)).queryByText('by position')).not.toBeInTheDocument()
  })
})
