import { describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

function renderRow(build: Build, handlers: Partial<Record<'onScheduleDeletion' | 'onCancelDeletion', (id: number) => void>> = {}, canWrite = true) {
  render(
    <BuildRow
      build={build}
      isLast
      onNavigate={() => {}}
      onStatusChange={() => {}}
      onScheduleDeletion={handlers.onScheduleDeletion ?? (() => {})}
      onCancelDeletion={handlers.onCancelDeletion ?? (() => {})}
      canWrite={canWrite}
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

  it('parses naive SQLite UTC timestamps, not as local time', () => {
    // server format: "YYYY-MM-DD HH:MM:SS" (UTC, no tz) — must read identically to the ISO path
    const d = new Date(Date.now() + 5 * 3_600_000 + 1_800_000)
    const sqlite = d.toISOString().slice(0, 19).replace('T', ' ')
    renderRow(makeBuild({ delete_after: sqlite }))
    expect(screen.getByText(/Deletes in 5h/)).toBeTruthy()
  })

  it('scheduling deletion goes through a confirm dialog', async () => {
    const onScheduleDeletion = vi.fn()
    renderRow(makeBuild({ delete_after: null }), { onScheduleDeletion })
    await userEvent.click(screen.getByRole('button', { name: 'Schedule deletion of ios build 1, 1.0.0' }))
    expect(onScheduleDeletion).not.toHaveBeenCalled() // confirm required first
    await userEvent.click(screen.getByRole('button', { name: 'Schedule deletion' }))
    expect(onScheduleDeletion).toHaveBeenCalledWith(1)
  })

  it('cancel action fires immediately for a scheduled build', async () => {
    const onCancelDeletion = vi.fn()
    renderRow(makeBuild({ delete_after: new Date(Date.now() + 3_600_000).toISOString() }), { onCancelDeletion })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel scheduled deletion of ios build 1, 1.0.0' }))
    expect(onCancelDeletion).toHaveBeenCalledWith(1)
  })
})

// #834 — the row's icon buttons were named only by `title`, the same on every row.
describe('BuildRow — every control names its row', () => {
  it('gives two builds that share a number and version different names on every control', () => {
    render(
      <>
        <BuildRow build={makeBuild({ id: 1, platform: 'ios', build_number: '42', version_name: '1.2.0' })} isLast={false}
          onNavigate={() => {}} onStatusChange={() => {}} onScheduleDeletion={() => {}} onCancelDeletion={() => {}} canWrite />
        <BuildRow build={makeBuild({ id: 2, platform: 'android', build_number: '42', version_name: '1.2.0', delete_after: new Date(Date.now() + 86_400_000 * 3).toISOString() })} isLast
          onNavigate={() => {}} onStatusChange={() => {}} onScheduleDeletion={() => {}} onCancelDeletion={() => {}} canWrite />
      </>,
    )
    expect(screen.getByRole('button', { name: 'Schedule deletion of ios build 42, 1.2.0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel scheduled deletion of android build 42, 1.2.0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start QA on ios build 42, 1.2.0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start QA on android build 42, 1.2.0' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Status for android build 42, 1.2.0' })).toBeTruthy()
  })

  it('explains the icon on keyboard focus, not only on hover, and carries no title', async () => {
    renderRow(makeBuild())
    const button = screen.getByRole('button', { name: 'Schedule deletion of ios build 1, 1.0.0' })
    expect(button.getAttribute('title')).toBeNull()
    await userEvent.tab()
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    expect((await screen.findByRole('tooltip')).textContent).toContain('Schedule deletion')
  })
})

// Viewer is read-only: the row still says its status and its deletion countdown, and still offers
// Start QA, but draws no control that changes either.
// Mutation: render the Select and deletion button regardless of `canWrite` → the absence assertions
// below fail, while the presence twin keeps them honest about what the row does draw.
describe('BuildRow — Viewer (canWrite false)', () => {
  const scheduled = () => makeBuild({ status_label: 'Backlog', delete_after: new Date(Date.now() + 3 * 3_600_000).toISOString() })

  it('draws no status Select and no deletion button, scheduled or not', () => {
    renderRow(scheduled(), {}, false)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /deletion/i })).toBeNull()
    cleanup()
    renderRow(makeBuild({ delete_after: null }), {}, false)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /deletion/i })).toBeNull()
  })

  it('still shows the status, the countdown and Start QA', () => {
    renderRow(scheduled(), {}, false)
    expect(screen.getByText('Backlog')).toBeTruthy()
    expect(screen.getByText(/Deletes in/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start QA on ios build 1, 1.0.0' })).toBeTruthy()
  })

  it('the same build with canWrite draws both controls', () => {
    renderRow(scheduled(), {}, true)
    expect(screen.getByRole('combobox', { name: 'Status for ios build 1, 1.0.0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel scheduled deletion of ios build 1, 1.0.0' })).toBeTruthy()
  })
})
