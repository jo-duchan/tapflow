import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Volume2, Volume1, Power } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToolbarOverflowMenu, type OverflowItem } from '@/components/device/shared/ToolbarOverflowMenu'

/**
 * **The toolbar's "⋯" menu** — where a group's less-used buttons go once it outgrows about four
 * (`packages/dashboard/AGENTS.md` → "When a group gets too long"). Generic on purpose: the items carry
 * their own action, so the menu does not know whether it holds hardware buttons or anything else.
 *
 * Keyboard behaviour is the WAI-ARIA menu pattern, which Radix supplies; these tests hold that it is
 * wired, not that Radix works.
 */

function setup(items: OverflowItem[]) {
  const user = userEvent.setup()
  render(<TooltipProvider><ToolbarOverflowMenu label="More device buttons" items={items} /></TooltipProvider>)
  return { user, trigger: () => screen.getByRole('button', { name: 'More device buttons' }) }
}

const items = () => {
  const up = vi.fn(); const down = vi.fn(); const power = vi.fn()
  const list: OverflowItem[] = [
    { key: 'up', label: 'Volume Up', icon: <Volume2 />, keepOpen: true, onSelect: up },
    { key: 'down', label: 'Volume Down', icon: <Volume1 />, keepOpen: true, onSelect: down },
    { key: 'power', label: 'Sleep/Wake', icon: <Power />, onSelect: power },
  ]
  return { list, up, down, power }
}

describe('ToolbarOverflowMenu', () => {
  // Mutation: render the trigger regardless. An empty menu is a control that does nothing.
  it('renders nothing when it has nothing to offer', () => {
    render(<TooltipProvider><ToolbarOverflowMenu label="More device buttons" items={[]} /></TooltipProvider>)
    expect(screen.queryByRole('button', { name: 'More device buttons' })).toBeNull()
  })

  // An icon-only control needs a name (a11y core); the label is it.
  it('opens a menu of its items, in order, by name', async () => {
    const { user, trigger } = setup(items().list)
    await user.click(trigger())
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Volume Up', 'Volume Down', 'Sleep/Wake'])
  })

  // Pressing volume three times should not mean opening the menu three times.
  //
  // Mutation: drop the `preventDefault` on a keepOpen item.
  it('stays open after an item that keeps it open', async () => {
    const { list, up } = items()
    const { user, trigger } = setup(list)
    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: 'Volume Up' }))
    await user.click(screen.getByRole('menuitem', { name: 'Volume Up' }))
    expect(up).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  // Mutation: keep every item open. Power changes the screen, so the menu gets out of the way.
  it('closes after an item that does not', async () => {
    const { list, power } = items()
    const { user, trigger } = setup(list)
    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: 'Sleep/Wake' }))
    expect(power).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  // The whole reason these buttons are in the toolbar: the frame's are out of reach of a keyboard.
  it('works from the keyboard, and Escape hands focus back to the trigger', async () => {
    const { list, down } = items()
    const { user, trigger } = setup(list)
    trigger().focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeTruthy()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(down).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})
