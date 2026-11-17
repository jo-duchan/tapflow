import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TeamSettings } from '@/src/pages/settings/Team'
import type { TeamMember } from '@/lib/types'
import { withQuery } from './withQuery'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const member: TeamMember = {
  id: 11, display_name: 'Ann', email: 'ann@example.test', role: 'QA', joined_at: '2026-11-01T00:00:00Z',
}

function renderMembers(members: TeamMember[]) {
  const patches: Array<{ url: string; body: unknown }> = []
  let currentMembers = members
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/v1/team/members/') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { role: string }
      patches.push({ url, body })
      const id = Number(url.split('/').at(-1))
      currentMembers = currentMembers.map((entry) => entry.id === id ? { ...entry, role: body.role } : entry)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url === '/api/v1/team/members') return new Response(JSON.stringify(currentMembers), { status: 200 })
    throw new Error(`Unexpected request: ${url}`)
  }))
  render(withQuery(<TeamSettings />))
  return patches
}

afterEach(() => vi.unstubAllGlobals())

describe('Team member role selectors', () => {
  it.each([
    { displayName: 'Ann', name: 'Role for Ann (ann@example.test)' },
    { displayName: '', name: 'Role for ann@example.test' },
    { displayName: null, name: 'Role for ann@example.test' },
    { displayName: '   ', name: 'Role for ann@example.test' },
    { displayName: '  Ann  ', name: 'Role for Ann (ann@example.test)' },
    { displayName: '지민', name: 'Role for 지민 (ann@example.test)' },
  ])('names the role selector when the display name is "$displayName"', async ({ displayName, name }) => {
    renderMembers([{ ...member, display_name: displayName }])
    const selector = await screen.findByRole('combobox')
    expect(selector).toHaveAccessibleName(name)
    expect(screen.getByRole('combobox', { name })).toBe(selector)
    expect(selector).toHaveTextContent('QA')
  })

  it('distinguishes members with the same display name by email', async () => {
    renderMembers([member, { ...member, id: 12, email: 'another.ann@example.test' }])
    const selectors = await screen.findAllByRole('combobox')
    expect(selectors).toHaveLength(2)
    expect(selectors[0]).toHaveAccessibleName('Role for Ann (ann@example.test)')
    expect(selectors[1]).toHaveAccessibleName('Role for Ann (another.ann@example.test)')
    for (const [index, email] of ['ann@example.test', 'another.ann@example.test'].entries()) {
      expect(within(selectors[index].closest('tr')!).getByText(email)).toBeVisible()
    }
  })

  it('changes the focused member role by keyboard and returns focus to that selector', async () => {
    const patches = renderMembers([member, { ...member, id: 12, display_name: '', email: 'second@example.test' }])
    const user = userEvent.setup()
    await screen.findAllByRole('combobox')
    const first = screen.getByRole('combobox', { name: 'Role for Ann (ann@example.test)' })
    const second = screen.getByRole('combobox', { name: 'Role for second@example.test' })

    await user.tab()
    expect(screen.getByRole('button', { name: /invite member/i })).toHaveFocus()
    await user.tab()
    expect(first).toHaveFocus()
    await user.tab()
    expect(within(first.closest('tr')!).getByRole('button', { name: 'Reset pwd' })).toHaveFocus()
    await user.tab()
    expect(within(first.closest('tr')!).getByRole('button', { name: 'Remove' })).toHaveFocus()
    await user.tab()
    expect(second).toHaveFocus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Admin', 'Developer', 'QA', 'Viewer'])
    await waitFor(() => expect(screen.getByRole('option', { name: 'QA' })).toHaveFocus())
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(patches).toEqual([{ url: '/api/v1/team/members/12', body: { role: 'Viewer' } }]))
    await waitFor(() => expect(second).toHaveFocus())
    await waitFor(() => expect(second).toHaveTextContent('Viewer'))
    expect(second).toHaveAccessibleName('Role for second@example.test')
  })

  it('returns focus on Escape and leaves the selected role unchanged', async () => {
    renderMembers([member])
    const user = userEvent.setup()
    const selector = await screen.findByRole('combobox')
    expect(selector).toHaveAccessibleName('Role for Ann (ann@example.test)')
    await user.tab()
    await user.tab()
    expect(selector).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowDown}{Escape}')
    await waitFor(() => expect(selector).toHaveFocus())
    expect(selector).toHaveAttribute('aria-expanded', 'false')
    expect(selector).toHaveTextContent('QA')
  })
})
