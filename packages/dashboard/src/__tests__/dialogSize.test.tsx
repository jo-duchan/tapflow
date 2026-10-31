import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

// The dialog widths are three sizes (design/components/dialog.md), not one per call site.
function widthOf(size?: 'sm' | 'md' | 'lg', className?: string) {
  render(
    <Dialog open>
      <DialogContent size={size} className={className} aria-describedby={undefined}><DialogTitle>t</DialogTitle></DialogContent>
    </Dialog>,
  )
  return (screen.getByRole('dialog').className.match(/\bmax-w-\S+/g) ?? []).join(' ')
}

describe('DialogContent size', () => {
  it.each([['sm', 'max-w-sm'], ['md', 'max-w-md'], ['lg', 'max-w-lg']] as const)('%s is %s, and only that', (size, cls) => {
    expect(widthOf(size)).toBe(cls)
  })

  it('is lg when not given', () => {
    expect(widthOf()).toBe('max-w-lg')
  })

  // The deeplink bar sets its own width; tailwind-merge keeps the call site's, not the default's.
  it('yields to a width the call site sets', () => {
    expect(widthOf(undefined, 'max-w-[500px]')).toBe('max-w-[500px]')
  })
})
