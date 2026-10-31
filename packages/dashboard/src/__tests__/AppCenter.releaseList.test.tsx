// App Center's release list: where focus goes when a row leaves the filtered list (#833), and the
// four gaps #834 collected — open state derived rather than seeded, headers as headings, deletion
// outcomes announced, and every row control named for its row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App, Build } from '@/lib/types'

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: vi.fn() } }))

const api = vi.hoisted(() => ({
  getApps: vi.fn(), getBuilds: vi.fn(), updateBuildStatus: vi.fn(),
  scheduleBuildDeletion: vi.fn(), cancelBuildDeletion: vi.fn(),
}))
vi.mock('@/lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries')>()),
  ...api,
}))

import { AppCenter } from '@/src/pages/AppCenter'

const APPS = [
  { id: 1, name: 'Coffee', bundle_id_key: 'com.a.coffee', bundle_ids: { ios: 'com.a.coffee', android: null }, build_platforms: ['ios'], platform: 'ios' },
  { id: 2, name: 'Tea', bundle_id_key: 'com.a.tea', bundle_ids: { ios: 'com.a.tea', android: null }, build_platforms: ['ios'], platform: 'ios' },
] as unknown as App[]

function build(id: number, version: string, status: Build['status_label'] = 'Backlog', appId = 1): Build {
  return {
    id, app_id: appId, version_name: version, build_number: String(id), platform: 'ios',
    status_label: status, uploaded_at: '2026-09-21T00:00:00Z', uploader: `uploader-${id}`, delete_after: null,
    binary: { version_name: version, build_number: String(id) },
  } as unknown as Build
}

/**
 * A server that applies the status filter the way the relay does, so a status change followed by the
 * refetch really does take the row out — the sequence #833 is about. Newest release first, as the
 * relay orders them.
 */
let db: Build[] = []
function serve(rows: Build[]) {
  db = rows
  api.getBuilds.mockImplementation(async ({ appId, statusFilter }: { appId: number; statusFilter: string }) =>
    db.filter(b => b.app_id === appId && (statusFilter === 'all' || b.status_label === statusFilter)))
  api.updateBuildStatus.mockImplementation(async (id: number, status: Build['status_label']) => {
    db = db.map(b => (b.id === id ? { ...b, status_label: status } : b))
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderAppCenter(entry = '/app-center?appId=1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 }, mutations: { retry: 0 } } })
  return { client, ...render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/app-center" element={<AppCenter />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ) }
}

const trigger = (id: number, version: string) =>
  screen.getByRole('combobox', { name: `Status for ios build ${id}, ${version}` })
const header = (version: string) => screen.getByRole('button', { name: new RegExp(`^${version.replace(/\./g, '\\.')}`) })

async function filterBy(status: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Filter by status' }))
  await userEvent.click(screen.getByRole('option', { name: status }))
}

async function setStatus(id: number, version: string, status: string) {
  await userEvent.click(trigger(id, version))
  await userEvent.click(screen.getByRole('option', { name: status }))
}

/** What a screen reader hears after the name: the text of everything `aria-describedby` points at. */
function description(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ')
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  api.getApps.mockResolvedValue(APPS)
})
afterEach(() => vi.restoreAllMocks())

describe('a row whose status change takes it out of the filtered list (#833)', () => {
  it('hands focus to the next row in its release, which says why', async () => {
    // The middle row, so "next" and "previous" are different answers.
    serve([build(1, '1.0.0'), build(2, '1.0.0'), build(3, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-3')
    await filterBy('Backlog')
    await screen.findByText('uploader-3')

    await setStatus(2, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-2')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger(3, '1.0.0')))
    expect(description(trigger(3, '1.0.0'))).toBe('ios build 2, 1.0.0 was set to Done, so the Backlog filter no longer shows it.')
    // The destination says it; a toast as well would be flushed by the focus move or heard twice.
    expect(toastSuccess).not.toHaveBeenCalled()
    // Heard as a description only, not met again by someone reading the list.
    expect(document.getElementById(trigger(3, '1.0.0').getAttribute('aria-describedby') ?? '')?.hidden).toBe(true)
  })

  it('takes the next candidate when the same refetch removes the nearest one too', async () => {
    // A teammate moved build 3 out of Backlog while this change was in flight; one answer drops both.
    serve([build(1, '1.0.0'), build(2, '1.0.0'), build(3, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-3')
    await filterBy('Backlog')
    await screen.findByText('uploader-3')
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b.id === 3 ? { ...b, status_label: 'Rejected' } : b))
    })

    await setStatus(2, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-3')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger(1, '1.0.0')))
    expect(description(trigger(1, '1.0.0'))).toContain('ios build 2, 1.0.0 was set to Done')
  })

  it('skips a neighbour the same refetch moved into a collapsed release', async () => {
    // Build 3's version was renamed to 0.9.0 meanwhile: it is still in the list, but 0.9.0 is
    // collapsed, so its trigger is not drawn and cannot take focus.
    serve([build(1, '1.0.0'), build(2, '1.0.0'), build(3, '1.0.0'), build(4, '0.9.0')])
    renderAppCenter()
    await screen.findByText('uploader-3')
    await filterBy('Backlog')
    await screen.findByText('uploader-3')
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b.id === 3 ? { ...b, version_name: '0.9.0' } : b))
    })

    await setStatus(2, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-3')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger(1, '1.0.0')))
    expect(description(trigger(1, '1.0.0'))).toContain('ios build 2, 1.0.0 was set to Done')
  })

  it('lets the note go once focus leaves the control it landed on, even for another candidate', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0'), build(3, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-3')
    await filterBy('Backlog')
    await screen.findByText('uploader-3')

    await setStatus(2, '1.0.0', 'Done')
    await waitFor(() => expect(document.activeElement).toBe(trigger(3, '1.0.0')))
    trigger(1, '1.0.0').focus() // a candidate too, but not where the note was heard
    trigger(3, '1.0.0').focus()

    await waitFor(() => expect(description(trigger(3, '1.0.0'))).toBe(''))
  })

  it('still moves focus when the list was showing a failed refresh before the change', async () => {
    // The stale-list state is cleared by the optimistic write in the same commit that keeps the row,
    // so a move made from it is not mistaken for one whose own refetch failed.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const serveNormally = api.getBuilds.getMockImplementation()
    api.getBuilds.mockRejectedValueOnce(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })
    await screen.findByText('Showing the last list — refresh failed.')
    api.getBuilds.mockImplementation(serveNormally!)

    await setStatus(1, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger(2, '1.0.0')))
    expect(description(trigger(2, '1.0.0'))).toContain('was set to Done')
  })

  it('keeps the note through Radix handing focus back to the leaving row', async () => {
    // In a browser the menu takes focus and returns it to the row's trigger after the pick — after
    // the note was written. jsdom's Select does not move focus, so the hand-back is done here.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const answer = deferred<void>()
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      await answer.promise
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b))
    })

    await setStatus(1, '1.0.0', 'Done')
    trigger(2, '1.0.0').focus()
    trigger(1, '1.0.0').focus()
    answer.resolve()

    await waitFor(() => expect(document.activeElement).toBe(trigger(2, '1.0.0')))
    expect(description(trigger(2, '1.0.0'))).toContain('was set to Done')
  })

  it('leaves focus on the trigger when the change keeps the row — same fixture, no filter', async () => {
    // The twin of the case above: identical rows and change, only the filter differs, so a leave
    // check that never fires cannot pass both.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')

    await setStatus(1, '1.0.0', 'Done')

    await waitFor(() => expect(trigger(1, '1.0.0').textContent).toContain('Done'))
    expect(document.activeElement).toBe(trigger(1, '1.0.0'))
    expect(description(trigger(2, '1.0.0'))).toBe('')
  })

  it('goes to the previous row when the last row of its release leaves', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')

    await setStatus(2, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-2')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger(1, '1.0.0')))
  })

  it("goes to the next release's header when the row was its release's only one, open or not", async () => {
    serve([build(1, '1.0.0'), build(2, '0.9.0'), build(3, '0.8.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    await filterBy('Backlog')
    await screen.findByText('uploader-1')
    await userEvent.click(header('0.9.0')) // opened, so its row is a candidate that must not be chosen

    await setStatus(1, '1.0.0', 'Done')

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(header('0.9.0')))
    expect(description(header('0.9.0'))).toContain('so the Backlog filter no longer shows it')
  })

  it('leaves an emptied list to the empty state, which focuses the search box', async () => {
    serve([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    await filterBy('Backlog')
    await screen.findByText('uploader-1')

    await setStatus(1, '1.0.0', 'Done')

    await screen.findByText('No matching builds')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search versions and labels')))
  })

  it('treats clearing the status as leaving a status filter', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')

    await setStatus(1, '1.0.0', '—')

    await waitFor(() => expect(document.activeElement).toBe(trigger(2, '1.0.0')))
    expect(description(trigger(2, '1.0.0'))).toContain('was set to no status')
  })

  it('moves nothing and describes nothing when the server refuses the change', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    api.updateBuildStatus.mockRejectedValueOnce(new Error('relay refused'))

    await setStatus(1, '1.0.0', 'Done')

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update status'))
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
    expect(document.activeElement).toBe(trigger(1, '1.0.0'))
    expect(description(trigger(2, '1.0.0'))).toBe('')
  })

  it('forgets a refused change, so a later refetch that drops the row moves nothing', async () => {
    // The row stays after a refusal. If the pending move were kept, the next time the row left for
    // any other reason — a teammate changing it, picked up when the tab regains focus — focus would
    // be pulled onto its neighbour with a note about a change that never happened.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    api.updateBuildStatus.mockRejectedValueOnce(new Error('relay refused'))
    await setStatus(1, '1.0.0', 'Done')
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update status'))

    ;(document.activeElement as HTMLElement | null)?.blur()
    db = db.map(b => (b.id === 1 ? { ...b, status_label: 'Rejected' } : b))
    await client.invalidateQueries({ queryKey: ['builds'] })

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    expect(document.activeElement).toBe(document.body)
    expect(description(trigger(2, '1.0.0'))).toBe('')
  })

  it('drops the move when the filter changed before the row left', async () => {
    // Made under Backlog, then the person switched to All before the answer: the row stays. When it
    // later disappears under Rejected, that is the filter's doing, not this change's.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const answer = deferred<void>()
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      await answer.promise
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b))
    })

    await setStatus(1, '1.0.0', 'Done')
    await filterBy('All statuses')
    answer.resolve()
    await waitFor(() => expect(trigger(1, '1.0.0').textContent).toContain('Done'))
    db = db.map(b => (b.id === 2 ? { ...b, status_label: 'Rejected' } : b))
    await filterBy('Rejected')

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(description(trigger(2, '1.0.0'))).toBe('')
  })

  it('describes nothing in the next app when the app changed without moving focus', async () => {
    // Safari does not focus a button on click, so switching app from the sidebar fires no focusin.
    // The note was written against Coffee's list; Tea has a release with the same name.
    serve([build(1, '1.0.0'), build(2, '0.9.0'), build(3, '0.9.0', 'Backlog', 2)])
    renderAppCenter()
    await screen.findByText('uploader-1')
    await filterBy('Backlog')
    await screen.findByText('uploader-1')
    const answer = deferred<void>()
    api.updateBuildStatus.mockImplementationOnce(async () => { await answer.promise })

    await setStatus(1, '1.0.0', 'Done')
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(screen.getByRole('button', { name: /tea/i }))
    await screen.findByText('uploader-3')

    // Tea's first header is described by the status line as always — just not by Coffee's note.
    expect(description(header('0.9.0'))).not.toContain('was set to')
    expect(document.activeElement).toBe(document.body)
    answer.resolve()
  })

  it('does not follow a row that leaves only after its own refetch failed', async () => {
    // The change landed but the list could not be refreshed, so the row stayed. When a later
    // refetch finally drops it, the person has long moved on; nothing is pulled or described.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const serveNormally = api.getBuilds.getMockImplementation()
    api.getBuilds.mockRejectedValueOnce(new Error('relay blinked'))

    await setStatus(1, '1.0.0', 'Done')
    await screen.findByText('Showing the last list — refresh failed.')
    ;(document.activeElement as HTMLElement | null)?.blur()
    api.getBuilds.mockImplementation(serveNormally!)
    await client.invalidateQueries({ queryKey: ['builds'] })

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    expect(document.activeElement).toBe(document.body)
    expect(description(trigger(2, '1.0.0'))).toBe('')
  })

  it('says it once when focus had already moved onto a candidate', async () => {
    // Tabbed to the next row's status before the answer: focus stays, the toast says why, and the
    // note does not linger on that control to repeat it the next time it is reached.
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const answer = deferred<void>()
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      await answer.promise
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b))
    })

    await setStatus(1, '1.0.0', 'Done')
    trigger(2, '1.0.0').focus()
    answer.resolve()

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    expect(document.activeElement).toBe(trigger(2, '1.0.0'))
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(description(trigger(2, '1.0.0'))).toBe(''))
  })

  it('keeps focus where the person moved it while the change was in flight', async () => {
    serve([build(1, '1.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-2')
    await filterBy('Backlog')
    await screen.findByText('uploader-2')
    const answer = deferred<void>()
    api.updateBuildStatus.mockImplementationOnce(async (id: number, status: Build['status_label']) => {
      await answer.promise
      db = db.map(b => (b.id === id ? { ...b, status_label: status } : b))
    })

    await setStatus(1, '1.0.0', 'Done')
    const search = screen.getByLabelText('Search versions and labels')
    await userEvent.click(search)
    answer.resolve()

    await waitFor(() => expect(screen.queryByText('uploader-1')).toBeNull())
    expect(document.activeElement).toBe(search)
    expect(description(trigger(2, '1.0.0'))).toBe('')
    // Not moved, so the reason is said instead — nothing flushes it.
    expect(toastSuccess).toHaveBeenCalledWith('ios build 1, 1.0.0 was set to Done, so the Backlog filter no longer shows it.')
  })
})

describe('which releases are open (#834)', () => {
  it('shows the first release expanded from its first render after a retry', async () => {
    // The seed used to run in a passive effect after the commit that showed the list — and after the
    // layout effect that moved focus to this header — so it was announced collapsed, then expanded.
    api.getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    await screen.findByRole('button', { name: /try again/i })
    api.getBuilds.mockResolvedValue([build(1, '1.0.0')])

    let collapsedSeen = false
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const nodes = r.type === 'attributes' ? [r.target] : Array.from(r.addedNodes)
        if (r.type === 'attributes' && r.oldValue === 'false') collapsedSeen = true
        for (const n of nodes) {
          if (n instanceof Element && n.querySelector?.('[data-release-header][aria-expanded="false"]')) collapsedSeen = true
        }
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true })
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    await screen.findByText('uploader-1')
    observer.disconnect()

    expect(header('1.0.0').getAttribute('aria-expanded')).toBe('true')
    expect(collapsedSeen).toBe(false)
  })

  it('remembers what was opened and closed, per app, across a remount', async () => {
    serve([build(1, '2.0.0'), build(2, '1.0.0'), build(3, '3.0.0', 'Backlog', 2)])
    const first = renderAppCenter()
    await screen.findByText('uploader-1')
    await userEvent.click(header('2.0.0')) // close the newest
    await userEvent.click(header('1.0.0')) // open an older one
    first.unmount()

    renderAppCenter()
    await screen.findByText('uploader-2')
    expect(header('2.0.0').getAttribute('aria-expanded')).toBe('false')
    expect(header('1.0.0').getAttribute('aria-expanded')).toBe('true')

    // Another app keeps its own default.
    await userEvent.click(screen.getByRole('button', { name: /tea/i }))
    await screen.findByText('uploader-3')
    expect(header('3.0.0').getAttribute('aria-expanded')).toBe('true')
  })

  it('opens a release uploaded since, while one closed on purpose stays closed', async () => {
    serve([build(1, '2.0.0'), build(2, '1.0.0')])
    const first = renderAppCenter()
    await screen.findByText('uploader-1')
    await userEvent.click(header('2.0.0'))
    first.unmount()

    serve([build(3, '3.0.0'), build(1, '2.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-3')
    expect(header('3.0.0').getAttribute('aria-expanded')).toBe('true')
    expect(header('2.0.0').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the most recent toggle last even for a version named like a number', async () => {
    // An object would list "2" before "1.0.0" whatever order they were toggled in, and the cap
    // would then drop the newer toggle first.
    serve([build(1, '2'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    await userEvent.click(header('1.0.0'))
    await userEvent.click(header('2'))
    const stored = JSON.parse(localStorage.getItem('tapflow-app-center-releases:1') ?? '[]') as [string, boolean][]
    expect(stored.map(([name]) => name)).toEqual(['1.0.0', '2'])
  })

  it('falls back to the default when storage holds something it cannot read', async () => {
    localStorage.setItem('tapflow-app-center-releases:1', '{not json')
    serve([build(1, '2.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    expect(header('2.0.0').getAttribute('aria-expanded')).toBe('true')
    expect(header('1.0.0').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('release headers are headings (#834)', () => {
  it('puts each header button inside a level-2 heading', async () => {
    serve([build(1, '2.0.0'), build(2, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map(h => h.querySelector('[data-release-header]')?.getAttribute('data-release-header'))).toEqual(['2.0.0', '1.0.0'])
  })
})

describe('deletion outcomes are announced (#834)', () => {
  it('says when a deletion was scheduled, naming the build and when — on the answer, not the click', async () => {
    serve([build(1, '1.0.0')])
    const answer = deferred<string>()
    api.scheduleBuildDeletion.mockReturnValueOnce(answer.promise)
    renderAppCenter()
    await screen.findByText('uploader-1')

    await userEvent.click(screen.getByRole('button', { name: 'Actions for ios build 1, 1.0.0' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Schedule deletion' }))
    await userEvent.click(screen.getByRole('button', { name: 'Schedule deletion' }))
    expect(toastSuccess).not.toHaveBeenCalled()

    // As the relay answers: truncated to the second, and read after a round trip — a little under 7 days.
    answer.resolve(new Date(Date.now() + 7 * 86_400_000 - 1_500).toISOString())
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Deletion scheduled for ios build 1, 1.0.0 — it will be deleted in 7 days'))
  })

  it('says when a scheduled deletion was cancelled', async () => {
    serve([{ ...build(1, '1.0.0'), delete_after: new Date(Date.now() + 86_400_000).toISOString() }])
    api.cancelBuildDeletion.mockResolvedValueOnce(undefined)
    renderAppCenter()
    await screen.findByText('uploader-1')

    await userEvent.click(screen.getByRole('button', { name: 'Actions for ios build 1, 1.0.0' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Cancel scheduled deletion' }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Scheduled deletion cancelled for ios build 1, 1.0.0'))
  })

  it('says only the failure when scheduling fails', async () => {
    serve([build(1, '1.0.0')])
    api.scheduleBuildDeletion.mockRejectedValueOnce(new Error('relay refused'))
    renderAppCenter()
    await screen.findByText('uploader-1')

    await userEvent.click(screen.getByRole('button', { name: 'Actions for ios build 1, 1.0.0' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Schedule deletion' }))
    await userEvent.click(screen.getByRole('button', { name: 'Schedule deletion' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to schedule deletion'))
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
