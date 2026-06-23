import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuildRow } from '@/components/app-center/BuildRow'
import type { Build } from '@/lib/types'

// issue #258 — the deletion countdown is driven by delete_after, not by "Done".

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 1,
    app_id: 1,
    name: 'Coffee',
    version_name: '1.0.0',
    build_number: '1',
    version_label: null,
    status_label: null,
    platform: 'ios',
    bundle_id: 'com.example.coffee',
    uploaded_at: '2026-06-20T00:00:00Z',
    completed_at: null,
    delete_after: null,
    uploader: 'jo',
    ...overrides,
  }
}

function renderRow(build: Build, handlers: Partial<Record<'onScheduleDeletion' | 'onCancelDeletion', (id: number) => void>> = {}) {
  render(
    <BuildRow
      build={build}
      isLast
      onNavigate={() => {}}
      onStatusChange={() => {}}
      onScheduleDeletion={handlers.onScheduleDeletion ?? (() => {})}
      onCancelDeletion={handlers.onCancelDeletion ?? (() => {})}
    />,
  )
}

describe('BuildRow — deletion lifecycle', () => {
  it('#14 Done build with no delete_after shows no deletion countdown', () => {
    renderRow(makeBuild({ status_label: 'Done', completed_at: '2026-06-20T00:00:00Z', delete_after: null }))
    expect(screen.queryByText(/Deletes in/)).toBeNull()
  })

  it('#13 delete_after set shows a "Deletes in" badge regardless of status', () => {
    const future = new Date(Date.now() + 5 * 3_600_000 + 1_800_000).toISOString()
    renderRow(makeBuild({ status_label: 'Backlog', delete_after: future }))
    expect(screen.getByText(/Deletes in 5h/)).toBeTruthy()
  })

  it('scheduling deletion goes through a confirm dialog', async () => {
    const onScheduleDeletion = vi.fn()
    renderRow(makeBuild({ delete_after: null }), { onScheduleDeletion })
    await userEvent.click(screen.getByTitle('Schedule deletion'))
    expect(onScheduleDeletion).not.toHaveBeenCalled() // confirm required first
    await userEvent.click(screen.getByRole('button', { name: 'Schedule deletion' }))
    expect(onScheduleDeletion).toHaveBeenCalledWith(1)
  })

  it('cancel action fires immediately for a scheduled build', async () => {
    const onCancelDeletion = vi.fn()
    renderRow(makeBuild({ delete_after: new Date(Date.now() + 3_600_000).toISOString() }), { onCancelDeletion })
    await userEvent.click(screen.getByTitle('Cancel scheduled deletion'))
    expect(onCancelDeletion).toHaveBeenCalledWith(1)
  })
})
