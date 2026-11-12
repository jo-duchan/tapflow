import { useReducer } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { CapturedFlow, CapturedStep, RawStep } from '@tapflowio/flow-runner/browser'
import { EditScreen } from '@/components/flow-capture/screens'
import { editedCapture, flowOf, secretRename, yamlOf } from '@/lib/flowCapture/flow'
import { initialState, reduce, type CaptureState } from '@/lib/flowCapture/machine'

// 1b-3c: typed text the app does not mark as hidden (a card number, an API key) is written into the file as typed,
// unless the person makes it a secret in Edit; and a password typed twice, into a field and its confirmation, is one.
afterEach(cleanup)

const raw = { at: 0, endAt: 0, outcome: 'landed', messages: [], kind: 'text', text: '' } as unknown as RawStep
const row = (step: CapturedStep['step']): CapturedStep => ({ raw, step })
const captured: CapturedFlow = {
  launchAdded: false,
  steps: [
    row({ type: 'tapOn', selector: { id: 'form.card' } }),
    row({ type: 'inputText', text: '4111111111111111', replace: true }),
    row({ type: 'inputSecret', name: 'PASSWORD', replace: true }),
    row({ type: 'inputSecret', name: 'PASSWORD_2', replace: true }),
    row({ type: 'inputText', text: 'sk_live_123' }),
  ],
  secrets: { PASSWORD: 'hunter2!', PASSWORD_2: 'hunter2!' },
}
const edit: CaptureState = { ...initialState, phase: 'edit', captured, name: 'Sign up', reached: 3, verify: { status: 'passed', done: 5, live: [] } }

describe('Make secret', () => {
  it('takes the value out of the file and keeps it for Verify, under a name no secret has', () => {
    const made = reduce(edit, { type: 'make-secret', index: 1 })
    const edited = editedCapture(made)!
    expect(edited.steps[1]!.step).toEqual({ type: 'inputSecret', name: 'SECRET', replace: true })
    expect(edited.secrets).toMatchObject({ SECRET: '4111111111111111' })
    const yaml = yamlOf(flowOf(made, 'com.example')!)
    expect(yaml).not.toContain('4111111111111111')
    expect(yaml).toContain('secret: SECRET')
    // A different flow now: the last verification no longer says anything about it.
    expect(made.verify).toBeNull()
    const both = reduce(made, { type: 'make-secret', index: 4 })
    expect(editedCapture(both)!.steps[4]!.step).toEqual({ type: 'inputSecret', name: 'SECRET_2' })
  })

  it('keeps it as text again, and forgets a rename it was given', () => {
    const renamed = reduce(reduce(edit, { type: 'make-secret', index: 1 }), { type: 'rename-secret', from: 'SECRET', to: 'CARD' })
    expect(editedCapture(renamed)!.secrets).toMatchObject({ CARD: '4111111111111111' })
    const kept = reduce(renamed, { type: 'keep-as-text', index: 1 })
    expect(editedCapture(kept)!.steps[1]!.step).toEqual({ type: 'inputText', text: '4111111111111111', replace: true })
    expect(kept.renamed).toEqual({})
  })

  it('makes only typed text a secret', () => {
    expect(reduce(edit, { type: 'make-secret', index: 0 })).toBe(edit)
    expect(reduce(edit, { type: 'make-secret', index: 2 })).toBe(edit)
  })

  // A made secret is the replay's step: a new replay's own `SECRET` must not take its rename.
  it('goes with a new replay, and so does its rename', () => {
    const renamed = reduce(reduce(reduce(edit, { type: 'make-secret', index: 1 }), { type: 'rename-secret', from: 'SECRET', to: 'CARD' }),
      { type: 'rename-secret', from: 'PASSWORD', to: 'LOGIN' })
    const again = reduce(renamed, { type: 'match-started', total: 5 })
    expect(again.made).toEqual({})
    expect(again.renamed).toEqual({ PASSWORD: 'LOGIN' })
  })
})

describe('one secret for one value', () => {
  it('joins a secret of the same value, and refuses one of another', () => {
    const edited = editedCapture(edit)!
    expect(secretRename(edited, 'PASSWORD_2', 'PASSWORD')).toBe('joins')
    expect(secretRename(edited, 'PASSWORD_2', 'FREE')).toBeNull()
    const made = editedCapture(reduce(edit, { type: 'make-secret', index: 1 }))!
    expect(secretRename(made, 'PASSWORD_2', 'SECRET')).toBe('taken')
  })

  it('writes the two steps under one name with one value, and keeps them together through a later rename', () => {
    const joined = reduce(edit, { type: 'rename-secret', from: 'PASSWORD_2', to: 'PASSWORD' })
    const edited = editedCapture(joined)!
    expect(edited.steps.slice(2, 4).map((s) => s.step)).toEqual([
      { type: 'inputSecret', name: 'PASSWORD', replace: true }, { type: 'inputSecret', name: 'PASSWORD', replace: true },
    ])
    expect(edited.secrets).toEqual({ PASSWORD: 'hunter2!' })
    const later = editedCapture(reduce(joined, { type: 'rename-secret', from: 'PASSWORD', to: 'LOGIN' }))!
    expect(later.steps.slice(2, 4).map((s) => s.step?.type === 'inputSecret' && s.step.name)).toEqual(['LOGIN', 'LOGIN'])
  })
})

// CodeRabbit on #1156.
describe('joined secrets, renamed and replayed', () => {
  it('renames both when the one that joined is renamed, not only when the other is', () => {
    const joined = reduce(edit, { type: 'rename-secret', from: 'PASSWORD_2', to: 'PASSWORD' })
    const later = editedCapture(reduce(joined, { type: 'rename-secret', from: 'PASSWORD_2', to: 'LOGIN' }))!
    expect(later.steps.slice(2, 4).map((s) => s.step?.type === 'inputSecret' && s.step.name)).toEqual(['LOGIN', 'LOGIN'])
    expect(later.secrets).toEqual({ LOGIN: 'hunter2!' })
  })

  it('parts a join a replay gave two values, and keeps one it did not', () => {
    const joined = reduce(edit, { type: 'rename-secret', from: 'PASSWORD_2', to: 'PASSWORD' })
    const replayed = (secrets: Record<string, string>) =>
      reduce(reduce(joined, { type: 'match-started', total: 5 }), { type: 'match-finished', captured: { ...captured, secrets } }).renamed
    expect(replayed({ PASSWORD: 'hunter2!', PASSWORD_2: 'other' })).toEqual({})
    expect(replayed({ PASSWORD: 'hunter2!', PASSWORD_2: 'hunter2!' })).toEqual({ PASSWORD_2: 'PASSWORD' })
  })

  // CodeRabbit on #1156: a name given back by a parted join can be one another secret was renamed to since.
  it('asks again after parting a join, until no name has two values', () => {
    const three = { ...captured, steps: [...captured.steps, row({ type: 'inputSecret', name: 'PASSWORD_3' })], secrets: { ...captured.secrets, PASSWORD_3: 'other' } }
    let state = reduce({ ...edit, captured: three }, { type: 'rename-secret', from: 'PASSWORD_2', to: 'PASSWORD' })
    state = reduce(state, { type: 'rename-secret', from: 'PASSWORD', to: 'LOGIN' })
    state = reduce(state, { type: 'rename-secret', from: 'PASSWORD_3', to: 'PASSWORD' })
    const after = reduce(reduce(state, { type: 'match-started', total: 6 }),
      { type: 'match-finished', captured: { ...three, secrets: { PASSWORD: 'hunter2!', PASSWORD_2: 'changed', PASSWORD_3: 'other' } } })
    expect(after.renamed).toEqual({})
    const edited = editedCapture(after)!
    expect(edited.secrets).toEqual({ PASSWORD: 'hunter2!', PASSWORD_2: 'changed', PASSWORD_3: 'other' })
  })

  it('takes no value from a removed step', () => {
    // Reached only through the reducer: Edit's own check would refuse the join, the values differing.
    const removed = reduce(reduce(reduce(edit, { type: 'make-secret', index: 1 }), { type: 'rename-secret', from: 'SECRET', to: 'PASSWORD' }),
      { type: 'remove-step', index: 1 })
    expect(editedCapture(removed)!.secrets.PASSWORD).toBe('hunter2!')
  })
})

describe('Edit, a typed step', () => {
  const draw = (state: CaptureState, check: (current: string, to: string) => { error?: string; note?: string } = () => ({})) => {
    const dispatch = vi.fn()
    render(<EditScreen state={state} dispatch={dispatch} flow={null} renameCheck={check} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />)
    return dispatch
  }
  // The details of the row at `index` in the list (a secret's label carries no name, so rows are told apart by place).
  const open = (index: number) => fireEvent.click(within(screen.getAllByRole('listitem')[index]!).getByRole('button', { name: /^Details of / }))

  it('says the value goes into the file, and offers Make secret', () => {
    const dispatch = draw(edit)
    open(1)
    expect(screen.getByText('The value goes into the file.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make secret' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'make-secret', index: 1 })
  })

  it('draws a made secret as a secret, with its name, the docs and Keep as text', () => {
    const dispatch = draw(reduce(edit, { type: 'make-secret', index: 1 }))
    open(1)
    expect(screen.getByLabelText('Secret name')).toHaveValue('SECRET')
    expect(screen.getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', 'https://www.tapflow.dev/automation/flows#secrets')
    fireEvent.click(screen.getByRole('button', { name: 'Keep as text' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'keep-as-text', index: 1 })
  })

  // Review of 1b-3c: a join, both rows open, the one renamed; the other's field held the old name and, losing focus,
  // renamed the pair back.
  it('does not rename a joined secret back from a field still open on the old name', () => {
    let latest = edit
    function Harness() {
      const [state, dispatch] = useReducer(reduce, edit)
      latest = state
      return <EditScreen state={state} dispatch={dispatch} flow={null} renameCheck={() => ({})} onVerify={vi.fn()} onBackToRange={vi.fn()} verifyRef={{ current: null }} />
    }
    render(<Harness />)
    open(3)
    const second = within(screen.getAllByRole('listitem')[3]!).getByLabelText('Secret name')
    fireEvent.change(second, { target: { value: 'PASSWORD' } })
    fireEvent.blur(second)
    open(2)
    const first = within(screen.getAllByRole('listitem')[2]!).getByLabelText('Secret name')
    fireEvent.change(first, { target: { value: 'LOGIN' } })
    fireEvent.blur(first)
    fireEvent.blur(within(screen.getAllByRole('listitem')[3]!).getByLabelText('Secret name'))
    const names = editedCapture(latest)!.steps.slice(2, 4).map((s) => s.step?.type === 'inputSecret' && s.step.name)
    expect(names).toEqual(['LOGIN', 'LOGIN'])
  })

  it('tells a joining rename beside the field, where a screen reader reads it', () => {
    draw(edit, () => ({ note: 'Same value as PASSWORD: one secret.' }))
    open(3)
    const field = screen.getByLabelText('Secret name')
    fireEvent.change(field, { target: { value: 'PASSWORD' } })
    expect(field).toHaveAccessibleDescription(/Same value as PASSWORD: one secret\./)
  })

  it('says a rename joins another secret, and refuses one that would mix two values', () => {
    draw(edit, (_current, to) => (to === 'PASSWORD' ? { note: 'Same value as PASSWORD: one secret.' } : { error: 'Another secret has this name, with a different value.' }))
    open(3)
    const field = screen.getByLabelText('Secret name')
    fireEvent.change(field, { target: { value: 'PASSWORD' } })
    expect(screen.getByText('Same value as PASSWORD: one secret.')).toBeInTheDocument()
    fireEvent.change(field, { target: { value: 'OTHER' } })
    expect(screen.getByText('Another secret has this name, with a different value.')).toBeInTheDocument()
  })
})
