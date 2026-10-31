import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App, Build } from '@/lib/types'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }))

const { getApps, getBuilds, updateBuildStatus } = vi.hoisted(() => ({
  getApps: vi.fn(), getBuilds: vi.fn(), updateBuildStatus: vi.fn(),
}))
vi.mock('@/lib/queries', async (importOriginal) => ({
  // `groupByRelease` is a pure derivation of the fetched rows, so the real one runs: a stub would
  // decide what this suite is asserting about.
  ...(await importOriginal<typeof import('@/lib/queries')>()),
  getApps,
  getBuilds,
  updateBuildStatus,
}))

import { AppCenter } from '@/src/pages/AppCenter'

const APPS: App[] = [
  { id: 1, name: 'Coffee', bundle_id_key: 'com.a.coffee', bundle_ids: { ios: 'com.a.coffee', android: null }, build_platforms: ['ios'], platform: 'ios' },
  { id: 2, name: 'Tea', bundle_id_key: 'com.a.tea', bundle_ids: { ios: 'com.a.tea', android: null }, build_platforms: ['ios'], platform: 'ios' },
] as unknown as App[]

function build(id: number, version: string): Build {
  return {
    id,
    app_id: 1,
    version_name: version,
    build_number: String(id),
    platform: 'ios',
    status_label: null,
    uploaded_at: '2026-09-21T00:00:00Z',
    uploader: `uploader-${id}`,
    delete_after: null,
    binary: { version_name: version, build_number: String(id) },
  } as unknown as Build
}

/** A promise this test resolves by hand, so the window between click and response is assertable. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderAppCenter(
  entry = '/app-center?appId=1',
  options: { client?: QueryClient; gcTime?: number } = {},
) {
  // A client per test, so one test's cache cannot answer another's query. `retry: 0` matches the
  // app's own default (`lib/queryClient.ts`); `gcTime: 0` keeps nothing behind after unmount — which
  // also garbage-collects a key the moment it is left, so a test about a key *revisited* within the
  // app's real five minutes passes a `gcTime`, and one about remounting passes the same `client`.
  const client = options.client ?? new QueryClient({
    defaultOptions: { queries: { retry: 0, gcTime: options.gcTime ?? 0 }, mutations: { retry: 0 } },
  })
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/app-center" element={<AppCenter />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Handed back so a test can force a *refetch* of a key already holding data — the case
  // `isLoadingError` exists to separate from a first load that failed.
  return { ...result, client }
}

const emptyState = () => screen.queryByText('No builds yet')

/**
 * Records whether a string was ever in the DOM, across every commit — not only the ones a test
 * happens to sample.
 *
 * **Sampling after `await userEvent.click(...)` is not enough, and the first draft of the test
 * below proved it by passing against the bug.** That await flushes React's effects, so the render
 * where `builds` had been cleared and `loading` was still false is already gone by the time an
 * assertion runs. The flicker is one commit wide; only something watching every mutation sees it.
 */
function watchForText(text: string) {
  let seen = document.body.textContent?.includes(text) ?? false
  const observer = new MutationObserver((records) => {
    // **The records, not `document.body`.** Observer callbacks are batched into one microtask, so
    // by the time this runs the DOM is already at its latest state and re-reading it sees only
    // that. The second draft of this helper did exactly that and passed against the bug too. What
    // survives is the list of nodes that were inserted, whether or not they are still there.
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.textContent?.includes(text)) { seen = true; return }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return { get seen() { return seen }, stop: () => observer.disconnect() }
}
const appButton = (name: string) => screen.getByRole('button', { name: new RegExp(name, 'i') })

describe('App Center — switching apps', () => {
  beforeEach(() => {
    // **`reset`, not `clear`.** `clearAllMocks` wipes call history and leaves queued
    // `mockResolvedValueOnce` values in place, so a test that queues more answers than it consumes
    // feeds the next one. These tests were order-dependent on that until debouncing the search
    // changed how many calls each makes.
    vi.resetAllMocks()
    getApps.mockResolvedValue(APPS)
    updateBuildStatus.mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  // A merge removes the app it moved out of (#1086), and a tab or bookmark can still name it.
  it('opens the first app when the URL names one that is gone', async () => {
    getBuilds.mockResolvedValue([build(1, '1.0.0')])
    renderAppCenter('/app-center?appId=99')
    await waitFor(() => expect(getBuilds).toHaveBeenLastCalledWith(expect.objectContaining({ appId: 1 })))
  })

  it('never shows the empty state while the next app is loading', async () => {
    // **The reported bug.** `handleAppSelect` cleared `builds` synchronously while `loading` was
    // still false, so one render fell through to `releaseGroups.length === 0` and drew "No builds
    // yet" — for an app whose builds nobody had asked about yet. What the user saw on one click
    // was list → empty → Loading… → list.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)

    const empty = watchForText('No builds yet')
    // **And the list is not replaced by a spinner either.** Without this the empty state is avoided
    // by falling into the loading branch instead, which is still two changes of screen for one
    // click — the thing that reads as flicker. Watching both is what makes this test fail when
    // `placeholderData` is removed.
    const loading = watchForText('Loading…')
    await userEvent.click(appButton('Tea'))
    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
    empty.stop()
    loading.stop()

    expect(empty.seen).toBe(false)
    expect(loading.seen).toBe(false)
  })

  it('keeps the previous release open until the next app answers', async () => {
    // The other half of the same synchronous reset: `setOpenReleases(new Set())` ran on the click
    // too, so holding the old list without this would show it with every accordion collapsed —
    // a different flicker in place of the one being fixed.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    // The header renders whether the release is open or not, so it says nothing about this. The
    // uploader's name comes from a `BuildRow`, and rows exist only inside an *expanded* release.
    const openRow = await screen.findByText('uploader-1')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))

    expect(openRow).toBeInTheDocument()

    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
  })

  it('rolls a failed status change back into the app it was made in', async () => {
    // **The optimistic writes were reached by no test at all**, which is how the bug this covers
    // shipped: `onError` closed over `buildsKey` from the render that fired it, and react-query
    // swaps a *pending* mutation's callbacks to the latest render's — so a failure arriving after
    // the user switched app restored the first app's whole list into the second app's cache entry.
    // Verified in the library rather than assumed: `useMutation.js:182` re-sets options every
    // render, `mutationObserver.js:62` forwards that to a pending mutation, and `mutation.js:196`
    // reads `onError` at settle time.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    const failed = deferred<void>()
    updateBuildStatus.mockReturnValueOnce(failed.promise)
    await userEvent.click(screen.getByRole('combobox', { name: /status for ios build 1, 1\.0\.0/i }))
    await userEvent.click(screen.getByRole('option', { name: 'Done' }))

    getBuilds.mockResolvedValueOnce([build(2, '2.0.0')])
    await userEvent.click(appButton('Tea'))
    await screen.findByText('uploader-2')

    failed.reject(new Error('relay refused'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update status'))

    // Tea's rows, not Coffee's restored over them.
    expect(screen.getByText('uploader-2')).toBeInTheDocument()
    expect(screen.queryByText('uploader-1')).toBeNull()
  })

  it('does not blink through Loading… while a search is refined', async () => {
    // Reported from use. The branch above was written for an app switch and fired for filter
    // changes too, so once a search matched nothing, every refinement of it flashed "Loading…"
    // between two identical empty states.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockResolvedValue([])
    await userEvent.type(screen.getByLabelText('Search versions and labels'), 'zz')
    await waitFor(() => expect(screen.getByText('No matching builds')).toBeInTheDocument())

    const loading = watchForText('Loading…')
    const settled = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(settled.promise)
    await userEvent.type(screen.getByLabelText('Search versions and labels'), 'z')
    settled.resolve([])
    await waitFor(() => expect(getBuilds).toHaveBeenCalledWith(expect.objectContaining({ search: 'zzz' })))
    loading.stop()

    expect(loading.seen).toBe(false)
  })

  it('offers a way to try again, and does not promise one it lacks', async () => {
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    await screen.findByText("Couldn't load builds")

    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('uploader-1')).toBeInTheDocument()
  })

  it('keeps the failure on screen while its own retry runs', async () => {
    // Pressing "Try again" puts the query back to pending, which took the failure branch away and
    // unmounted the button that had just been pressed — focus to `body`, and a busy state that
    // could never render.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    const button = await screen.findByRole('button', { name: /try again/i })
    button.focus()

    const retry = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(retry.promise)
    await userEvent.click(button)

    const busy = screen.getByRole('button', { name: /trying…/i })
    expect(busy).toHaveFocus()
    // **`toHaveFocus` alone was not evidence, and this test was green against the defect.** A real
    // browser drops focus from an element that becomes `disabled` (the HTML focus-fixup rule) and
    // jsdom does not model that, so the assertion above held here while Chrome sent focus to `body`.
    // What keeps focus in a browser is that the button never becomes `disabled` at all.
    expect(busy).not.toBeDisabled()
    expect(busy).toHaveAttribute('aria-disabled', 'true')

    // And a second press while busy starts nothing — counted after the retry settles, since anything
    // it started would be scheduled rather than immediate. **On the same key this is held by TanStack,
    // not by the handler's guard**: for a query with no data yet it returns the in-flight promise
    // rather than cancelling it. The guard's own case is the next test.
    getBuilds.mockResolvedValue([build(1, '1.0.0')])
    await userEvent.click(busy)
    retry.resolve([build(1, '1.0.0')])
    await screen.findByText('uploader-1')

    expect(getBuilds).toHaveBeenCalledTimes(2)
  })

  it('does not start a second retry when the search changed while the first one ran', async () => {
    // `retrying` is not per key, so a search typed during a retry leaves "Trying…" up over a new key
    // whose own first load may already have failed. A second press would then refetch *that* key —
    // TanStack's dedupe only covers the key already in flight. `aria-disabled` does not stop a click,
    // so the handler's guard is what keeps an unavailable-looking control from acting.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    const button = await screen.findByRole('button', { name: /try again/i })

    const retry = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(retry.promise)
    await userEvent.click(button)

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    await userEvent.type(screen.getByLabelText('Search versions and labels'), '2')
    await waitFor(() => expect(getBuilds).toHaveBeenCalledTimes(3))
    await act(async () => {})

    getBuilds.mockResolvedValue([build(1, '1.0.0')])
    await userEvent.click(screen.getByRole('button', { name: /trying…/i }))
    retry.resolve([build(1, '1.0.0')])
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument())

    expect(getBuilds).toHaveBeenCalledTimes(3)
  })

  it('says what failed on the button that focus lands on', async () => {
    // Focus moves here in the same commit that the status region changes, and NVDA and JAWS flush a
    // pending polite announcement on a focus move. Without a description the only thing heard would
    // be "Try again, button".
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    const button = await screen.findByRole('button', { name: /try again/i })

    expect(button).toHaveAccessibleDescription("Couldn't load builds Check that the relay is reachable.")
    // And available until it is pressed — the control focus lands on must not read as dimmed.
    expect(button).toHaveAttribute('aria-disabled', 'false')
  })

  it('says the list is stale for as long as it is, not just while a toast lasts', async () => {
    // The toast announces once and fades. `isRefetchError` stays true while the relay is down, and
    // nothing on screen said so after it went.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValue(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })

    await waitFor(() => expect(screen.getByText(/showing the last list/i)).toBeInTheDocument())
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
  })

  it('ignores an appId that is not one', async () => {
    // `Number('abc')` is `NaN`, which passed the query's `!== null` guard and fired a request while
    // the page rendered "No app selected".
    renderAppCenter('/app-center?appId=abc')

    await waitFor(() => expect(screen.getByText('No app selected')).toBeInTheDocument())
    expect(getBuilds).not.toHaveBeenCalled()
  })

  it('asks once for a search, not once per letter', async () => {
    // Four letters were four query keys, four requests and four announcements. The box is still
    // instant; what reaches the key settles.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    getBuilds.mockClear()

    getBuilds.mockResolvedValue([])
    await userEvent.type(screen.getByLabelText('Search versions and labels'), 'zzzz')
    await waitFor(() => expect(screen.getByText('No matching builds')).toBeInTheDocument())

    expect(getBuilds).toHaveBeenCalledTimes(1)
    expect(getBuilds).toHaveBeenCalledWith(expect.objectContaining({ search: 'zzzz' }))
  })

  it('says a failed refresh on screen, and does not stack one toast per attempt', async () => {
    // The status region tells assistive technology; a sighted user reading a list that may be
    // stale was told nothing. Repeats reuse the id because `refetchOnWindowFocus` is on — a relay
    // that is down would otherwise raise one toast every time the tab is focused.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValue(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })
    await waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't refresh builds"),
      expect.objectContaining({ id: 'builds:refresh' }),
    )
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
  })

  it('separates an app with no builds from a filter that matches none', async () => {
    // Two different facts that used to share one sentence. "Upload the first build" is wrong advice
    // for someone who has builds and a search box with `zzz` in it.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build'))

    // Every keystroke is its own query key, so this answers all three.
    getBuilds.mockResolvedValue([])
    await userEvent.type(screen.getByLabelText('Search versions and labels'), 'zzz')

    await waitFor(() => expect(screen.getByText('No matching builds')).toBeInTheDocument())
    expect(screen.queryByText('No builds yet')).toBeNull()
    expect(status).toHaveTextContent('No builds match the current filters')
  })

  it('keeps the list when a background refresh fails', async () => {
    // **`refetchOnWindowFocus` and `retry: 0` are both on, which makes this reachable on an
    // ordinary day**: come back to the tab, the relay misses one answer, and treating every error
    // alike would swap a list that is still good for a full-page failure — taking the focus inside
    // it along with the rows. A failed refresh keeps what is on screen and says so.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build'))

    getBuilds.mockRejectedValueOnce(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })

    // The toast carries it and the status region deliberately does not: sonner renders each toast
    // as its own `role="status"`, so saying it in both read the same sentence out twice.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't refresh builds"), expect.anything(),
    ))
    expect(status).not.toHaveTextContent("Couldn't refresh")
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load builds")).toBeNull()
  })

  it('does not announce a search keystroke as loading', async () => {
    // `isPlaceholderData` is true for every character typed into the search box, so announcing on
    // it talks over the screen reader echoing the character. Only a change of app is a wait worth
    // narrating.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))

    const typed = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(typed.promise)
    await userEvent.type(screen.getByLabelText('Search versions and labels'), '1')

    expect(status).not.toHaveTextContent('Loading builds')

    typed.resolve([build(1, '1.0.0')])
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))
  })

  it('does not show the empty state when the app being left was the empty one', async () => {
    // **The same bug the other way round, and the first pass left it in.** Holding the previous
    // app's rows holds its *emptiness* too, so leaving an app with no builds kept a placeholder of
    // `[]` under the new app's name — "No builds yet" for an app whose answer had not arrived.
    // Every other test here switches away from an app that had rows, which is why none of them saw
    // it.
    getBuilds.mockResolvedValueOnce([])
    renderAppCenter()
    await waitFor(() => expect(emptyState()).toBeInTheDocument())

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))

    expect(emptyState()).toBeNull()
    // Absence is not enough: without something in this slot the pane is simply blank for the whole
    // round trip, and a test that only checks the empty state is gone cannot tell the two apart.
    expect(screen.getByText('Loading…')).toBeInTheDocument()

    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
  })

  it('opens the new app\'s first release once its answer arrives', async () => {
    // **The other side of holding the previous list.** Open state is read against the app whose rows
    // are on screen; key it on the selected app instead and the held list is judged by the new app's
    // toggles, or the new list by the old one's. That failure is invisible to a test that only checks
    // the previous list stayed put, which is why this one exists beside it. (Before #834 this was a
    // seed run from an effect, with the same trap.)
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))
    second.resolve([build(2, '2.0.0')])

    expect(await screen.findByText('uploader-2')).toBeInTheDocument()
  })

  it('shows the empty state once an app answers with no builds', async () => {
    // The empty state is not being removed — it is being made to wait for an answer.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    getBuilds.mockResolvedValueOnce([])
    await userEvent.click(appButton('Tea'))

    await waitFor(() => expect(emptyState()).toBeInTheDocument())
  })

  it('ignores a response that arrives after the selection moved on', async () => {
    // Two clicks, and the first app's response lands last. Nothing cancelled it before, so the
    // stale rows won by arriving late.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    const slowFirst = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(slowFirst.promise)
    await userEvent.click(appButton('Tea'))

    getBuilds.mockResolvedValueOnce([build(3, '3.0.0')])
    await userEvent.click(appButton('Coffee'))
    await screen.findByText('3.0.0')

    slowFirst.resolve([build(9, '9.9.9')])
    await waitFor(() => expect(screen.getByText('3.0.0')).toBeInTheDocument())
    expect(screen.queryByText('9.9.9')).toBeNull()
  })

  it('has the status region before it has anything to say', async () => {
    // Entering without `?appId` there is no app and so no status yet. The region still has to be
    // in the tree: assistive technology announces a *change* to a region it is already observing,
    // and one that appears together with its first sentence is the case support is weakest on.
    // Rendering it only when non-empty passes every other test in this file, which is why this one
    // asserts the empty case specifically.
    getApps.mockResolvedValue([])
    renderAppCenter('/app-center')

    const status = screen.getByRole('status')
    expect(status).toBeInTheDocument()
    expect(status).toHaveTextContent('')
  })

  it('says what the list is doing, for someone who cannot see it', async () => {
    // **The failure this change exists to distinguish is silent without this.** "The relay did not
    // answer" and "this app has no builds" are the same screen to anyone not looking at it, and the
    // message that now tells them apart only appears visually. The region is mounted from the start
    // rather than with its text: a live region that arrives together with its content is the case
    // assistive technology supports worst.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = screen.getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))
    // Held rows belong to the app you were looking at, and the heading already names the other one.
    expect(status).toHaveTextContent('Loading builds for Tea')

    second.resolve([])
    await waitFor(() => expect(status).toHaveTextContent('No builds for Tea'))

    getBuilds.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(appButton('Coffee'))
    await waitFor(() => expect(status).toHaveTextContent("Couldn't load builds"))
  })

  it('distinguishes a failed fetch from an app with no builds', async () => {
    // There was no error path at all: the `finally` lowered `loading` and the empty state took
    // over, so "the request failed" and "this app has no builds" looked identical.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    getBuilds.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(appButton('Tea'))

    await waitFor(() => expect(screen.getByText("Couldn't load builds")).toBeInTheDocument())
    expect(emptyState()).toBeNull()
  })
})

describe('App Center — focus survives the list being swapped out (#829)', () => {
  // **The rule is the one `DeviceViewer` already settled on for its restart:** focus that the swap
  // itself destroyed goes to a real control in what replaced it, and focus anywhere else is left
  // alone. Not a `tabIndex={-1}` title — that viewer tried parking focus on a non-control and took
  // it out again, because such an element also takes focus from a mouse and then has to wear a ring
  // for a focus nobody can use.
  //
  // Half of these hold the fix and half hold what an over-eager fix breaks — the row status and the
  // deletion dialog among them, both of which a second design of the hook did break.
  beforeEach(() => {
    vi.resetAllMocks()
    getApps.mockResolvedValue(APPS)
    updateBuildStatus.mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  const releaseTrigger = () => screen.getByRole('button', { name: /^1\.0\.0/ })

  it('moves focus to Try again when the list it was in is swapped for the failure', async () => {
    // The reaching path from the issue: a search is typed, the tester tabs into the list before the
    // 250ms debounce fires, and the new key's first load fails — so the list, with the focused
    // control inside it, is unmounted and focus falls to `body`.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    await userEvent.type(screen.getByLabelText('Search versions and labels'), '1')
    releaseTrigger().focus()
    expect(releaseTrigger()).toHaveFocus()

    await screen.findByText("Couldn't load builds")
    expect(screen.getByRole('button', { name: /try again/i })).toHaveFocus()
  })

  it('moves focus into the list when a retry brings it back', async () => {
    // The other direction, and the same defect: the button that was pressed lives inside the failure
    // state, so a *successful* retry unmounts it. The existing test holds the busy half — focus stays
    // on "Trying…" while the retry runs — and stopped there.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    const button = await screen.findByRole('button', { name: /try again/i })
    button.focus()

    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    await userEvent.click(button)
    await screen.findByText('uploader-1')

    expect(releaseTrigger()).toHaveFocus()
    // And it says the retry worked: the focus move flushes the status sentence that would have.
    expect(releaseTrigger()).toHaveAccessibleDescription('Showing 1 build for Coffee')
    // And whether it is open, which the chevron alone does not say.
    expect(releaseTrigger()).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus to the search box when the list it was in empties out', async () => {
    // The same race as the failure, answered with nothing instead: the empty state has no control,
    // so focus lands on the search box above it — which says what is empty, because the focus move
    // flushes the status sentence that would otherwise have said it.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockResolvedValueOnce([])
    const search = screen.getByLabelText('Search versions and labels')
    await userEvent.type(search, 'zz')
    releaseTrigger().focus()

    await screen.findByText('No matching builds')
    expect(search).toHaveFocus()
    expect(search).toHaveAccessibleDescription('No matching builds')
  })

  it('does not move focus while a row\'s status is being picked', async () => {
    // **The most common interaction on this page, and the first design broke it.** Picking an
    // option unmounts the Select's portal content — focus drops to `body` — and Radix hands focus
    // back to the trigger a macrotask later. The status mutation notifies before that, so App Center
    // commits in between; a hook that acted on any removal moved focus to the first release there,
    // scrolling the list to the top under a mouse user, before Radix put it back.
    getBuilds.mockResolvedValue([build(1, '1.0.0'), build(2, '1.0.0')])
    updateBuildStatus.mockResolvedValue(undefined)
    renderAppCenter()
    await screen.findByText('uploader-2')

    const visited: Element[] = []
    const onFocusIn = (e: FocusEvent) => { visited.push(e.target as Element) }
    document.addEventListener('focusin', onFocusIn)
    try {
      await userEvent.click(screen.getByRole('combobox', { name: /status for ios build 2, 1\.0\.0/i }))
      await userEvent.click(screen.getByRole('option', { name: 'Done' }))
      await waitFor(() => expect(updateBuildStatus).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      document.removeEventListener('focusin', onFocusIn)
    }

    expect(visited).not.toContain(releaseTrigger())
  })

  it('returns focus to the row\'s ⋯ menu when its deletion dialog closes', async () => {
    // The dialog is opened by state, not by an `AlertDialogTrigger`, so Radix had nothing to hand
    // focus back to and dropped it on `body` — the same loss #829 is about, from a row's own control.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    // Opened from a menu item since #1084, which has no trigger either.
    await userEvent.click(screen.getByRole('button', { name: /^Actions for/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Schedule deletion' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await waitFor(() => expect(screen.getByRole('button', { name: /^Actions for/ })).toHaveFocus())
  })

  it('holds a first-load failure while a background refetch retries it', async () => {
    // The same hold without placeholder rows: nothing was ever loaded, so a refetch would otherwise put
    // the key back to its loading view and take "Try again", and the focus on it, away.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    const { client } = renderAppCenter()
    const button = await screen.findByRole('button', { name: /try again/i })
    button.focus()

    const reload = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(reload.promise)
    await act(async () => { void client.invalidateQueries({ queryKey: ['builds'] }) })

    // The query notifies on a timer, so the held state is waited for rather than sampled.
    await waitFor(() => expect(button).toHaveTextContent('Trying…'))
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(button).toHaveFocus()

    reload.resolve([build(1, '1.0.0')])
    await screen.findByText('uploader-1')
    expect(releaseTrigger()).toHaveFocus()
  })

  it('does not describe the app being left with the status of the app being loaded', async () => {
    // During a switch the held rows are Coffee's while the status line already says "Loading builds
    // for Tea". Describing Coffee's first release with that sentence tells a screen-reader user the
    // release belongs to Tea.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    expect(releaseTrigger()).toHaveAccessibleDescription('Showing 1 build for Coffee')

    const tea = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(tea.promise)
    await userEvent.click(appButton('Tea'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Loading builds for Tea'))

    expect(releaseTrigger()).toHaveAccessibleDescription('')

    tea.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
  })

  it('holds the failure while a background refetch retries it, with focus kept on its button', async () => {
    // **The #829 path, one step further.** The search that failed has no rows of its own, so when
    // returning to the tab refetches it, `keepPreviousData` fills the gap with the *previous search's*
    // rows — the view becomes a list, focus is moved into rows that belong to a different search, and
    // the answer then replaces them again. The manual retry already holds the failure until its answer
    // arrives; a background refetch of the same failure is held the same way.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    await userEvent.type(screen.getByLabelText('Search versions and labels'), '1')
    releaseTrigger().focus()
    await screen.findByText("Couldn't load builds")
    const button = screen.getByRole('button', { name: /try again/i })
    expect(button).toHaveFocus()

    const refetch = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(refetch.promise)
    await act(async () => { void client.invalidateQueries({ queryKey: ['builds'] }) })

    await waitFor(() => expect(button).toHaveTextContent('Trying…'))
    expect(screen.queryByText('uploader-1')).toBeNull()
    expect(button).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Loading builds for Coffee')

    // Found by its header: a search on the same app does not reopen a release, so its rows are not
    // rendered to find by text.
    refetch.resolve([build(3, '1.3.0')])
    const release = await screen.findByRole('button', { name: /^1\.3\.0/ })
    expect(release).toHaveFocus()
  })

  it('says it is loading, not showing rows, while a retry runs over the previous search\'s rows', async () => {
    // Pressing "Try again" on the #829 path leaves the previous search's rows as placeholder data, and
    // the status line read them out as "Showing 1 build" under a screen that says "Trying…".
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    await userEvent.type(screen.getByLabelText('Search versions and labels'), '1')
    await screen.findByText("Couldn't load builds")

    const retry = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(retry.promise)
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(screen.getByRole('status')).toHaveTextContent('Loading builds for Coffee')

    retry.resolve([build(3, '1.3.0')])
    await screen.findByRole('button', { name: /^1\.3\.0/ })
  })

  it('moves focus to the search box, described as loading, when a new search replaces a failure', async () => {
    // Nothing has ever loaded, so a search typed on the failure screen has no rows to hold and no
    // failure of its own yet: tabbing to "Try again" before the debounce fires — #829's race again —
    // puts focus on a button the loading view then removes.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    const tryAgain = await screen.findByRole('button', { name: /try again/i })

    const next = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(next.promise)
    const search = screen.getByLabelText('Search versions and labels')
    await userEvent.type(search, '1')
    tryAgain.focus()
    await screen.findByText('Loading…')

    expect(search).toHaveFocus()
    expect(search).toHaveAccessibleDescription('Loading…')

    next.resolve([build(1, '1.0.0')])
    await screen.findByRole('button', { name: /^1\.0\.0/ })
  })

  it('does not bring back a failure the search has since moved past', async () => {
    // Only the failure on screen is held. A search that failed a minute ago, while the relay was down,
    // is not the one being looked at when a later refinement is backspaced into it — and the relay may
    // well be back. Holding every key that ever failed flashed "Couldn't load builds" between two lists.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter(undefined, { gcTime: 60_000 })
    await screen.findByText('uploader-1')
    const search = screen.getByLabelText('Search versions and labels')

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    await userEvent.type(search, '1')
    await screen.findByText("Couldn't load builds")

    getBuilds.mockResolvedValueOnce([build(2, '1.2.0')])
    await userEvent.type(search, '2')
    await screen.findByRole('button', { name: /^1\.2\.0/ })

    const failure = watchForText("Couldn't load builds")
    const back = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(back.promise)
    await userEvent.type(search, '{Backspace}')
    await waitFor(() => expect(getBuilds).toHaveBeenCalledTimes(4))
    back.resolve([build(3, '1.1.0')])
    await screen.findByRole('button', { name: /^1\.1\.0/ })
    failure.stop()

    expect(failure.seen).toBe(false)
  })

  it('shows a fresh load, not a failure from before, when the page is opened again', async () => {
    // Leaving App Center and coming back within the cache's lifetime finds the failed key still there.
    // That failure was not on screen when the page mounted, so the page loads rather than opening on it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 60_000 } } })
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    const first = renderAppCenter(undefined, { client })
    await screen.findByText("Couldn't load builds")
    first.unmount()

    const reload = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(reload.promise)
    renderAppCenter(undefined, { client })

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load builds")).toBeNull()

    reload.resolve([build(1, '1.0.0')])
    await screen.findByText('uploader-1')
  })

  it('draws release-shaped skeletons for a slow load and keeps the loading text for a screen reader', async () => {
    const slow = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(slow.promise)
    renderAppCenter()

    const text = await screen.findByText('Loading…')
    expect(text).toHaveClass('sr-only')
    await waitFor(() => expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0))

    slow.resolve([build(1, '1.0.0')])
    await screen.findByText('uploader-1')
    expect(document.querySelectorAll('.animate-pulse')).toHaveLength(0)
  })

  it('leaves focus in the search box when that is where it was', async () => {
    // The tester is typing. Pulling the caret out of the field because the answer to what they typed
    // failed would be the defect aimed the other way.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    const search = screen.getByLabelText('Search versions and labels')
    await userEvent.type(search, '1')
    await screen.findByText("Couldn't load builds")

    expect(search).toHaveFocus()
  })

  it('does not pull focus back into the list on a render that swapped nothing', async () => {
    // Clicking the page background leaves focus on `body` too, with the last focus still recorded
    // as inside the list. Only a change of view may act on that record; an ordinary re-render — a
    // background refresh returning the same rows — must not drag the caret back in.
    //
    // **The refresh has to return different rows**, or there is no render to test: the query only
    // re-renders on a change to what the page reads, and identical rows are structurally shared. The
    // first draft refetched the same list, rendered nothing, and passed against the defect it was
    // written for.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-1')
    releaseTrigger().focus()
    releaseTrigger().blur()
    expect(document.body).toHaveFocus()

    getBuilds.mockResolvedValueOnce([build(1, '1.0.0'), build(2, '1.0.0')])
    await act(() => client.invalidateQueries({ queryKey: ['builds'] }))
    await screen.findByText('uploader-2')

    expect(document.body).toHaveFocus()
  })

  it('does not take focus when the first load fails', async () => {
    // Nobody had focused anything, so nothing was lost. Moving the caret onto a button here would be
    // a page grabbing it on load.
    getBuilds.mockRejectedValueOnce(new Error('relay down'))
    renderAppCenter()
    await screen.findByText("Couldn't load builds")

    expect(document.body).toHaveFocus()
  })
})

