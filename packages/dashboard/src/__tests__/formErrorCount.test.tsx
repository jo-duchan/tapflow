// #824. A field's error used to be both its input's description and a polite live region, so the field
// focus lands on after a refused submit was read twice. Now the message is the description only, and one
// hidden region per form says how many fields need attention. Nothing on screen changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { withQuery } from './withQuery'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: null, role: 'Viewer' }, loading: false }),
}))

import { Setup } from '@/src/pages/Setup'
import { DefaultSettings } from '@/src/pages/settings/Default'
import { invalidFieldCount } from '@/components/ui/form-error-count'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ initialized: false, canInitialize: true }), { status: 200 }),
  )
})
afterEach(() => vi.restoreAllMocks())

async function renderSetup() {
  const view = render(withQuery(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes><Route path="/setup" element={<Setup />} /></Routes>
    </MemoryRouter>,
  ))
  await screen.findByLabelText(/admin email/i)
  return view
}

/** The form's count region: the one polite live region the page has. */
function countRegion(container: HTMLElement) {
  const regions = container.querySelectorAll('[aria-live="polite"]')
  expect(regions).toHaveLength(1)
  return regions[0] as HTMLElement
}

const submit = () => userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

describe('a refused submit', () => {
  it('says how many fields need attention, in a region nobody sees', async () => {
    const { container } = await renderSetup()
    const region = countRegion(container)
    expect(region).toHaveTextContent('')
    await submit()

    // Email and password; the confirm rule is a refine that zod runs only once the rest parses.
    await waitFor(() => expect(region.textContent?.trim()).toBe('2 fields need attention'))
    expect(region).toHaveClass('sr-only')
  })

  it('leaves each field error a description only, looking as it did', async () => {
    await renderSetup()
    await submit()

    const email = screen.getByLabelText(/admin email/i)
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
    const error = document.getElementById(email.getAttribute('aria-describedby')!)!
    expect(error).toHaveTextContent('Enter a valid email')
    expect(error).not.toHaveAttribute('aria-live')
    expect(error).not.toHaveAttribute('role')
    expect(error).toHaveClass('text-sm', 'text-destructive')
    expect(error).not.toHaveClass('sr-only')
  })

  it('does not count down while the fields are being fixed', async () => {
    const { container } = await renderSetup()
    const region = countRegion(container)
    await submit()
    await waitFor(() => expect(region.textContent?.trim()).toBe('2 fields need attention'))

    await userEvent.type(screen.getByLabelText(/admin email/i), 'someone@example.com')
    await waitFor(() => expect(screen.queryByText('Enter a valid email')).toBeNull())
    expect(region.textContent?.trim()).toBe('2 fields need attention')
  })

  it('empties the region and refills it on a second refusal with the same count', async () => {
    // Clear, then set in a later task (W3C ARIA19): the same text written twice is not a change a screen
    // reader is obliged to announce, and a whitespace difference is not a reliable one either.
    const { container } = await renderSetup()
    const region = countRegion(container)
    await submit()
    await waitFor(() => expect(region).toHaveTextContent('2 fields need attention'))

    const texts: string[] = []
    const observer = new MutationObserver(() => texts.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    await submit()
    await waitFor(() => expect(texts.at(-1)).toBe('2 fields need attention'))
    observer.disconnect()
    expect(texts).toContain('')
  })
})

// CodeRabbit on #890: react-hook-form focuses the first invalid field *before* it publishes the errors,
// so focus arrived at an input with no description yet, and its own retry re-focuses an element that
// already has focus, which fires nothing. With the field's live region gone that read the error zero
// times. So the forms take focus themselves, after the render that describes the field — and these
// record what the input was described as **at the focus event**, not after everything settled.
describe('focus after a refused submit', () => {
  /** Every focus event on `el`, with the description it had at that moment. */
  function recordFocus(el: HTMLElement) {
    const seen: string[] = []
    el.addEventListener('focus', () => {
      const id = el.getAttribute('aria-describedby')
      seen.push(id ? document.getElementById(id)?.textContent ?? '' : '')
    })
    return seen
  }

  it('arrives at the first invalid field once it already names its error', async () => {
    await renderSetup()
    const email = screen.getByLabelText(/admin email/i)
    const seen = recordFocus(email)
    await submit()

    await waitFor(() => expect(email).toHaveFocus())
    expect(seen).toEqual(['Enter a valid email'])
  })

  it('says the error of the field that already had focus, once, without moving focus', async () => {
    // No focus event fires for an element that already has focus, so the live region says that error.
    // Not blur-then-focus: a screen reader may see no change, and on a phone the keyboard would drop.
    const { container } = await renderSetup()
    const region = countRegion(container)
    const email = screen.getByLabelText(/admin email/i)
    await userEvent.type(email, 'not-an-email')
    const seen = recordFocus(email)
    // What Enter does — submit the form, focus untouched. jsdom does not perform implicit submission for
    // `{Enter}` (measured: nothing submitted), so the submit is fired directly with focus left on the field.
    expect(email).toHaveFocus()
    fireEvent.submit(email.closest('form')!)

    await waitFor(() => expect(region).toHaveTextContent('Enter a valid email. 2 fields need attention'))
    expect(seen).toEqual([])
    expect(email).toHaveFocus()
  })
})

describe('after a refusal is fixed and the submit goes through', () => {
  it('leaves nothing behind, even when the form resets itself on success', async () => {
    // Default's password form calls `reset()` in its success handler, which takes the submit count to 0
    // and straight back to 1 — the value it had at the refusal — so a region keyed on the count alone
    // kept saying fields needed attention under a "Password changed" toast.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === '/api/v1/auth/change-password'
        ? new Response('{}', { status: 200 })
        : new Response('{}', { status: 404 }))
    render(withQuery(<MemoryRouter><DefaultSettings /></MemoryRouter>))
    const button = screen.getByRole('button', { name: 'Change password' })
    const region = button.closest('form')!.querySelector('[aria-live="polite"]') as HTMLElement

    await userEvent.click(button)
    await waitFor(() => expect(region.textContent?.trim()).toBe('2 fields need attention'))

    await userEvent.type(screen.getByLabelText('Current password'), 'old-password')
    await userEvent.type(screen.getByLabelText('New password'), 'password123')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'password123')
    await userEvent.click(button)

    await waitFor(() => expect(screen.getByLabelText('Current password')).toHaveValue(''))
    expect(region).toHaveTextContent('')
  })
})

describe('invalidFieldCount', () => {
  it('counts field errors with a message and leaves the relay\'s refusal out', () => {
    expect(invalidFieldCount({
      email: { message: 'Enter a valid email' },
      password: { message: 'too short' },
      root: { message: 'Invalid email or password' },
      avatar: undefined,
    })).toBe(2)
  })
})

// A new form with field errors and no count would bring the #824 gap back in the other direction: its
// fields would be read by nothing when focus does not move. Checked by source, since rendering every
// dialog to find out is most of the dashboard.
describe('every form with field errors carries a count', () => {
  const root = path.resolve(__dirname, '../..')
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(rel)
      return rel.endsWith('.tsx') ? [rel] : []
    })
  const files = ['src', 'components'].flatMap((dir) => walk(dir))
  const withFieldErrors = files.filter((f) => /<FieldError id=/.test(fs.readFileSync(path.join(root, f), 'utf8')))

  it('finds the forms it is about', () => {
    // Anti-vacuity: the nine forms of #824 live in seven of these files. The eighth is Flow Capture's secret name
    // (#1125), a field checked as it is typed, with no form to count for.
    expect(withFieldErrors.length).toBe(8)
  })

  it.each(withFieldErrors)('%s', (file) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    const forms = (src.match(/<form[\s>]/g) ?? []).length
    expect((src.match(/<FormErrorCount /g) ?? []).length).toBe(forms)
    // And react-hook-form's own focus is off, or it reaches the field before its error does.
    expect((src.match(/shouldFocusError: false/g) ?? []).length).toBe(forms)
    expect(src).not.toMatch(/shouldFocus: true/)
  })
})
