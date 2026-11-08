import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Stepper } from '@/components/ui/stepper'

// Capture flow's progress (#1125): a list taken in order, not tabs. Only a step the task can go to is a button.
const steps = ['Range', 'Match', 'Edit', 'Verify', 'Export'].map((title) => ({ title }))

describe('Stepper', () => {
  it('is a named list that marks the current step and says which are done', () => {
    render(<Stepper steps={steps} current={2} label="Progress" />)
    const list = screen.getByRole('list', { name: 'Progress' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[2]).toHaveAttribute('aria-current', 'step')
    expect(items.filter((li) => li.hasAttribute('aria-current'))).toHaveLength(1)
    expect(items[0]).toHaveTextContent('Range, completed')
    expect(items[3]).not.toHaveTextContent('completed')
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers only the completed steps the task can go to, and goes on a press', async () => {
    const onGoTo = vi.fn()
    render(<Stepper steps={steps} current={2} label="Progress" canGoTo={(i) => i === 0} onGoTo={onGoTo} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName('Range, completed')
    await userEvent.click(buttons[0]!)
    expect(onGoTo).toHaveBeenCalledWith(0)
  })

  it('shows the steps reached past the current one as completed, and offers them forward', async () => {
    const onGoTo = vi.fn()
    render(<Stepper steps={steps} current={0} reached={3} label="Progress" canGoTo={(i) => i !== 1} onGoTo={onGoTo} />)
    const items = within(screen.getByRole('list', { name: 'Progress' })).getAllByRole('listitem')
    expect(items[3]).toHaveTextContent('Verify, completed')
    expect(items[4]).not.toHaveTextContent('completed')
    // Only a completed step is offered, whatever the task says: Export was never reached.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit, completed', 'Verify, completed'])
    await userEvent.click(screen.getByRole('button', { name: 'Verify, completed' }))
    expect(onGoTo).toHaveBeenCalledWith(3)
  })
})
