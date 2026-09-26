import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Ban, Layers, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UploadBuildDialog } from '@/components/UploadBuildDialog'
import { AppSidebar } from '@/components/app-center/AppSidebar'
import { ReleaseAccordion } from '@/components/app-center/ReleaseAccordion'
import { getApps, getBuilds, updateBuildStatus, scheduleBuildDeletion, cancelBuildDeletion, groupByRelease } from '@/lib/queries'
import type { Build } from '@/lib/types'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import { useReleaseDisclosure } from '@/hooks/useReleaseDisclosure'
import { useAuth } from '@/hooks/useAuth'
import { buildRowName, describeDeletionCountdown } from '@/lib/build-format'

/**
 * A control in the release list that a leaving row can hand focus to (#833): a build's status
 * trigger, `row:<id>`, or a release header, `release:<version>`. Strings, so a list of them can sit in
 * state and in an effect's dependencies as plain values.
 */
type TargetId = string
const rowTarget = (buildId: number): TargetId => `row:${buildId}`
const releaseTarget = (versionName: string): TargetId => `release:${versionName}`

function targetIdOf(el: EventTarget | null): TargetId | null {
  if (!(el instanceof HTMLElement)) return null
  if (el.dataset.statusTrigger !== undefined) return rowTarget(Number(el.dataset.statusTrigger))
  if (el.dataset.releaseHeader !== undefined) return releaseTarget(el.dataset.releaseHeader)
  return null
}

/** The first candidate among the controls drawn now (`drawnKey` is a JSON array of target ids). */
function firstDrawn(candidates: TargetId[], drawnKey: string): TargetId | null {
  const drawn = new Set(JSON.parse(drawnKey) as TargetId[])
  return candidates.find(c => drawn.has(c)) ?? null
}

/** Nearest first: from the middle outwards, `at + 1` before `at - 1`. */
function byDistance<T>(items: T[], at: number): T[] {
  return items.map((item, i) => ({ item, d: i > at ? 2 * (i - at) - 1 : 2 * (at - i) }))
    .filter(({ d }) => d > 0).sort((x, y) => x.d - y.d).map(({ item }) => item)
}

export function AppCenter() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const queryClient = useQueryClient()
  // **Read once here and handed down**, so the rows and dialogs below do not each ask for `/auth/me`.
  // Viewer is the one read-only role; the relay refuses its writes whatever this says, so this only
  // decides what is offered. Unknown counts as writable: `DashboardLayout` renders no page until the
  // user is known, so the only render without one is a test that did not supply it.
  const { user } = useAuth()
  const canWrite = user?.role !== 'Viewer'
  const [search, setSearch] = useState('')
  // **What the box holds and what the query asks for are not the same value.** Every keystroke was
  // its own query key, so a four-letter search made four requests and four announcements — the last
  // of which talked over the screen reader echoing the letter just typed. The box stays instant;
  // the key settles.
  const [settledSearch, setSettledSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])

  // **Parsed once, and rejected when it is not an id.** `Number('abc')` is `NaN`, which is neither
  // `null` nor falsy in the same way — the query's `enabled` guard let it through and fired a
  // request for `appId=NaN` while the page rendered "No app selected".
  const rawAppId = searchParams.get('appId')
  const selectedAppId = rawAppId !== null && /^[1-9][0-9]*$/.test(rawAppId) ? Number(rawAppId) : null

  const appsQuery = useQuery({ queryKey: ['apps'], queryFn: getApps })
  const apps = appsQuery.data ?? []
  const selectedApp = apps.find(a => a.id === selectedAppId) ?? null

  // **The key carries every input, which is what makes a late answer harmless.** A response for a
  // key nobody is reading any more lands in the cache for that key and is not rendered — the
  // generation counter this page would otherwise hand-roll.
  const buildsKey = ['builds', selectedAppId, settledSearch, statusFilter] as const
  const buildsKeyId = JSON.stringify(buildsKey)

  const buildsQuery = useQuery({
    queryKey: buildsKey,
    queryFn: () => getBuilds({ appId: selectedAppId as number, search: settledSearch, statusFilter }),
    enabled: selectedAppId !== null,
    // **The fix for the reported flicker.** While a new key loads, `data` stays the previous key's,
    // so the list on screen is the one the user was just looking at. Without it the page renders
    // with no rows before the answer arrives, and a page with no rows is the empty state.
    placeholderData: keepPreviousData,
  })
  const builds = buildsQuery.data ?? []

  useEffect(() => {
    if (!appsQuery.data || searchParams.get('appId') || appsQuery.data.length === 0) return
    setSearchParams({ appId: String(appsQuery.data[0].id) }, { replace: true })
  }, [appsQuery.data, searchParams, setSearchParams])

  // **Which app the rows on screen came from. State, not a ref** — writing and reading a ref during
  // render is a Rules of React violation, and the first version of this did exactly that. The
  // effect below already runs at the moment the answer lands, which is the moment this changes.
  const [shownAppId, setShownAppId] = useState<number | null>(null)

  // **Held open across the retry it starts.** A refetch with no data behind it puts the query back
  // to pending, which takes the failure branch away and unmounts the button that was just pressed
  // — focus lands on `body`, and the busy state the button declares can never render. This keeps
  // the failure on screen until the retry answers.
  const [retrying, setRetrying] = useState(false)

  // **Announced once by the toast, and stated for as long as it is true by the line below it.**
  // The toast is the announcement: sonner renders each one as its own `role="status"`, so saying
  // the same sentence in the page's status region as well read it out twice.
  //
  // **It fires once, not once per attempt** — while `isRefetchError` stays true these deps do not
  // change, so a relay that stays down raises nothing further. An earlier comment here claimed the
  // opposite and used it to justify the id; the id is still right (a recovery and a second failure
  // would otherwise stack) but it is not what carries repetition. What carries the *state* is the
  // inline note beside the filters, which stays while the list is stale instead of fading with the
  // toast — and which is reachable by browsing after an open dialog has swallowed the
  // announcement, the case this package's AGENTS.md describes under "A toast fired while a dialog
  // is open is not heard".
  useEffect(() => {
    if (!buildsQuery.isRefetchError) return
    toast.error("Couldn't refresh builds — showing the last list", { id: 'builds:refresh' })
  }, [buildsQuery.isRefetchError])

  const seededAppId = useRef<number | null>(null)
  useEffect(() => {
    if (selectedAppId === null || buildsQuery.isPlaceholderData || !buildsQuery.data) return
    if (seededAppId.current === selectedAppId) return
    seededAppId.current = selectedAppId
    setShownAppId(selectedAppId)
  }, [selectedAppId, buildsQuery.isPlaceholderData, buildsQuery.data])

  function handleAppSelect(id: number) {
    setSearchParams({ appId: String(id) })
  }

  type MutationContext = { previous?: Build[]; key: typeof buildsKey }

  /**
   * Rewrite the rows on screen now, and put them back if the server refuses.
   *
   * The three build actions all follow this shape, and two of them had no rollback at all before —
   * a failed status change left the new label on screen until the next fetch disagreed with it.
   *
   * **The key travels in the context, and reading it from the closure is a bug.** `useMutation`
   * re-sets its options on every render (`useMutation.js:182`), and a *pending* mutation has its
   * options replaced with them (`mutationObserver.js:62`); `onError` and `onSuccess` are read at
   * settle time (`mutation.js:181,196`). So a rollback that closed over `buildsKey` would restore
   * one app's whole list into whichever key was current when the answer came back — and switching
   * app while a status change is in flight is an ordinary thing to do.
   */
  function optimisticRows<V>(apply: (builds: Build[], vars: V) => Build[], failureMessage: string) {
    return {
      onMutate: async (vars: V) => {
        const key = buildsKey
        await queryClient.cancelQueries({ queryKey: key })
        const previous = queryClient.getQueryData<Build[]>(key)
        queryClient.setQueryData<Build[]>(key, (old) => (old ? apply(old, vars) : old))
        return { previous, key }
      },
      onError: (_error: unknown, _vars: V, context: MutationContext | undefined) => {
        if (context?.previous) queryClient.setQueryData(context.key, context.previous)
        toast.error(failureMessage)
      },
      // The same row lives under every other search and filter of this app, and those entries still
      // hold the pre-mutation value. Nothing renders them now; something will.
      onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['builds'] }) },
    }
  }

  type StatusVars = { buildId: number; status: string | null }
  const statusRows = optimisticRows<StatusVars>(
    (rows, v) => rows.map(b =>
      b.id === v.buildId ? { ...b, status_label: v.status as Build['status_label'] } : b),
    'Failed to update status',
  )
  const statusMutation = useMutation({
    mutationFn: ({ buildId, status }: StatusVars) => updateBuildStatus(buildId, status),
    ...statusRows,
    onError: (error: unknown, vars: StatusVars, context: MutationContext | undefined) => {
      statusRows.onError(error, vars, context)
      // The row stays, so there is nothing to move focus away from.
      if (pendingFocus.current?.leaving === vars.buildId) {
        pendingFocus.current = null
        setLeftNote(null)
      }
    },
  })

  /** The row's name as the cache holds it now — for an announcement made after the answer. */
  const rowNameIn = (key: typeof buildsKey, buildId: number) => {
    const build = queryClient.getQueryData<Build[]>(key)?.find(b => b.id === buildId)
    return build ? buildRowName(build) : 'the build'
  }

  const scheduleMutation = useMutation({
    mutationFn: (buildId: number) => scheduleBuildDeletion(buildId),
    // **The row is marked now and dated on the answer.** The TTL is the server's to decide, so the
    // optimistic pass only says *that* deletion is scheduled; `onSuccess` writes the real
    // `delete_after` it returned.
    ...optimisticRows<number>(
      (rows, buildId) => rows.map(b =>
        b.id === buildId ? { ...b, delete_after: new Date().toISOString() } : b),
      'Failed to schedule deletion',
    ),
    onSuccess: (deleteAfter: string, buildId: number, context?: MutationContext) => {
      if (!context) return
      queryClient.setQueryData<Build[]>(context.key, (old) =>
        old?.map(b => b.id === buildId ? { ...b, delete_after: deleteAfter } : b))
      // **Said on the answer, not on the click** (#834): focus stays on the button while its name
      // changes, and whether a focused control's new name is read depends on the screen reader —
      // VoiceOver usually does not. The dialog has closed by now, so the toast is heard.
      toast.success(`Deletion scheduled for ${rowNameIn(context.key, buildId)} — it will be deleted ${describeDeletionCountdown(deleteAfter)}`)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (buildId: number) => cancelBuildDeletion(buildId),
    ...optimisticRows<number>(
      (rows, buildId) => rows.map(b => b.id === buildId ? { ...b, delete_after: null } : b),
      'Failed to cancel scheduled deletion',
    ),
    onSuccess: (_result: unknown, buildId: number, context?: MutationContext) => {
      toast.success(`Scheduled deletion cancelled for ${context ? rowNameIn(context.key, buildId) : 'the build'}`)
    },
  })

  const handleScheduleDeletion = (buildId: number) => scheduleMutation.mutate(buildId)
  const handleCancelDeletion = (buildId: number) => cancelMutation.mutate(buildId)

  const releaseGroups = groupByRelease(builds)
  const disclosure = useReleaseDisclosure(builds[0]?.app_id ?? null, releaseGroups.map(g => g.versionName))

  /**
   * **Where focus goes when a status change takes its row out of the filtered list** (#833).
   *
   * Radix hands focus back to the row's status trigger when the menu closes; the refetch then drops
   * the row, and the trigger with it, so focus fell to `body` and the page's top. `useFocusAfterSwap`
   * leaves this alone on purpose — the list stays a list — so the row decides: the next row in its
   * release, else the previous one, then further out; then the next release's header, else the
   * previous one's, then further out. A row that was the list's last leaves an empty state behind,
   * which the swap hook already handles.
   *
   * **Ranked now, chosen later.** Moving focus before the row is gone would be undone by Radix
   * handing it back, and after the refetch the order the neighbours were ranked in no longer exists.
   * So the candidates are ranked from what is on screen at the change, nearest first, and the first
   * one still on screen when the row goes is the destination. The same refetch can take the nearest
   * neighbour too — a teammate's change, a rename — and a single target would then drop focus to
   * `body` all over again.
   *
   * The destination says what happened itself, through `leftNote`: a polite status sentence is
   * flushed by the focus move in NVDA and JAWS (see this package's AGENTS.md). Focus and note both
   * resolve through `firstDrawn` over the same `drawnKey`, so they cannot point at different controls.
   */
  // `key` is the query the change was made under. The row leaves on *that* key's refetch; if the
  // search, filter or app changed first, the row going from some other list is not this change's
  // doing, and a move or toast then would describe a filter nobody is looking at.
  type Leaving = { leaving: number; candidates: TargetId[]; text: string; key: string }
  const pendingFocus = useRef<Leaving | null>(null)
  // The control focus was handed to, once it has been. From then on the note belongs to that control
  // alone: tabbing to a neighbouring candidate and back would otherwise hear it again, long after.
  const landedOn = useRef<TargetId | null>(null)
  const [leftNote, setLeftNote] = useState<Leaving | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const leftNoteId = useId()

  function rankTargets(buildId: number): TargetId[] {
    const index = releaseGroups.findIndex(g => g.builds.some(b => b.id === buildId))
    if (index < 0) return []
    const rows = releaseGroups[index].builds
    return [
      ...byDistance(rows, rows.findIndex(b => b.id === buildId)).map(b => rowTarget(b.id)),
      // Headers render whether or not their release is open, so they are always there to take it.
      ...byDistance(releaseGroups, index).map(g => releaseTarget(g.versionName)),
    ]
  }

  /**
   * Every control this render draws that focus could be handed to. **A row counts only inside an
   * open release, judged by where it is now**: the refetch that drops the leaving row can also move a
   * neighbour into another release — a version renamed, say — and a collapsed one draws no rows, so
   * `builds` alone would pick a control that is not on screen. Worked out from state rather than the
   * DOM so the note, resolved during render, lands on the same control focus does. A string, so the
   * effect below can depend on it: a set built in render is a new object every time.
   */
  const drawnKey = JSON.stringify(releaseGroups.flatMap(g => [
    releaseTarget(g.versionName),
    ...(disclosure.isOpen(g.versionName) ? g.builds.map(b => rowTarget(b.id)) : []),
  ]))

  const handleStatusChange = (buildId: number, status: string | null) => {
    const build = builds.find(b => b.id === buildId)
    const leaves = statusFilter !== 'all' && status !== statusFilter
    const candidates = leaves ? rankTargets(buildId) : []
    if (build && candidates.length > 0) {
      const text = `${buildRowName(build)} was set to ${status ?? 'no status'}, so the ${statusFilter} filter no longer shows it.`
      const leaving = { leaving: buildId, candidates, text, key: buildsKeyId }
      pendingFocus.current = leaving
      landedOn.current = null
      setLeftNote(leaving)
    }
    statusMutation.mutate({ buildId, status })
  }

  // A change of key is answered by the layout effect below, which drops the note with the move.
  const noteShown = leftNote !== null && !builds.some(b => b.id === leftNote.leaving)
  const noteTarget = noteShown ? firstDrawn(leftNote.candidates, drawnKey) : null

  // On the commit that removes the row. Only if focus went down with it: someone who moved on
  // while the answer was in flight keeps what they chose — and hears why the row went through a
  // toast instead, since with no focus move there is nothing to flush it. So does anyone whose every
  // candidate went with the refetch: if that emptied the list the swap hook moves focus, and
  // otherwise it stays where the browser left it.
  //
  // **Exact dependencies, no suppression.** An `eslint-disable` for a react-hooks rule makes the
  // React Compiler skip the whole component (`noSuppressedCompilation.test.ts`), and a first version
  // of this effect had one. The row leaves when the data changes, the move is dropped when the key or
  // the refetch's outcome changes, and what is drawn is `drawnKey` — nothing else can decide it.
  const buildsData = buildsQuery.data
  const refetchFailed = buildsQuery.isRefetchError
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    // A refetch that failed leaves the row on screen; whenever it does leave, it is too late to
    // follow, and the "Couldn't refresh" toast has already said the list is stale. Dropped quietly,
    // as is a change made under a key no longer shown.
    if (pending.key !== buildsKeyId || refetchFailed) {
      pendingFocus.current = null
      setLeftNote(null)
      return
    }
    if ((buildsData ?? []).some(b => b.id === pending.leaving)) return
    pendingFocus.current = null
    const target = firstDrawn(pending.candidates, drawnKey)
    if (!target || (document.activeElement !== null && document.activeElement !== document.body)) {
      toast.success(pending.text)
      // Said once. Left in place, the note would describe a candidate the person reaches later
      // with the sentence the toast already read.
      setLeftNote(null)
      return
    }
    const controls = listRef.current?.querySelectorAll('[data-status-trigger], [data-release-header]') ?? []
    const destination = Array.from(controls).find(el => targetIdOf(el) === target)
    // Not expected: `drawnKey` models what is drawn. If the model and the DOM ever disagree, the
    // reason is still said rather than focus falling silently.
    if (destination instanceof HTMLElement) {
      landedOn.current = target
      destination.focus()
    } else {
      toast.success(pending.text)
      setLeftNote(null)
    }
  }, [buildsKeyId, refetchFailed, buildsData, drawnKey])

  // The note describes its destination until focus goes anywhere else. The leaving row's own trigger
  // is exempt: Radix hands focus back to it before the row goes. **Against the candidates, not
  // `noteTarget`**: the layout effect above moves focus before this listener is re-registered for
  // the render that resolved the target, so this closure still holds the one from before the row
  // went — and a first version that compared against it cleared the note on the focus it describes.
  useEffect(() => {
    if (!leftNote) return
    const onFocusIn = (event: FocusEvent) => {
      const id = targetIdOf(event.target)
      if (landedOn.current !== null) {
        if (id !== landedOn.current) setLeftNote(null)
        return
      }
      if (id === rowTarget(leftNote.leaving)) return
      if (id === null || !leftNote.candidates.includes(id)) setLeftNote(null)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [leftNote])

  /**
   * What the list is doing, for anyone who cannot see it doing it.
   *
   * **Two things this change introduced are otherwise silent.** The failure state it added is the
   * whole point of the change — "the relay did not answer" against "this app has no builds" — and a
   * message that only appears on screen tells a screen-reader user neither. And holding the previous
   * app's rows while the next ones load means the heading names one app over another app's builds;
   * sighted users read that as a beat of lag, and nothing else said it at all.
   *
   * Mounted unconditionally so the region exists before it has anything to say — a live region that
   * arrives together with its text is the case assistive technology supports worst.
   */
  const appName = selectedApp?.name ?? 'this app'
  const filtered = settledSearch !== '' || statusFilter !== 'all'
  // **Only an app switch is worth announcing as loading.** `isPlaceholderData` is also true for
  // every keystroke in the search box, and saying "Loading…" then "Showing N" per character talks
  // over the screen reader echoing what was typed. Keyed on the app because that is the switch a
  // person is waiting through.
  const switching = buildsQuery.isPlaceholderData && shownAppId !== selectedAppId

  /**
   * **Which view the builds region is showing, named once and rendered from.** `useFocusAfterSwap`
   * keys on it — focus moves only on a commit that changes it — so the render branches on this rather
   * than restating the conditions: two copies of the same chain are how a key comes to say "list" over
   * an empty state.
   *
   * `isLoadingError`, not `isError`: with `refetchOnWindowFocus` on and no retries, a single missed
   * answer while the tab was in the background would otherwise throw away a list that is still
   * perfectly good — and take the focus inside it with the rows. A failed *refresh* keeps the list and
   * says so through the status region.
   *
   * **Only a change of app is unknown enough to say "Loading…" over held emptiness.** Emptiness held
   * from the app you are leaving is not an answer about the one you picked. But emptiness held from
   * the *same* app under a different search is the last answer, and swapping it for "Loading…" on every
   * refinement is the flicker #828 was about — pointed at the filter bar instead of the sidebar.
   */
  /**
   * **A failed search being fetched again with nothing of its own to show is still the failure.** The
   * manual retry has held the failure screen until its answer since #828 (`retrying`). A background
   * refetch of the same failure — returning to the tab, an upload invalidating builds — did not: the
   * key goes back to pending, `keepPreviousData` fills it with the *previous search's* rows, and the
   * view turned into a list that belongs to a different search, with focus moved into rows the answer
   * would replace again (#829's review). So it is held the same way.
   *
   * **Only the failure that was on screen.** `errorUpdateCount` alone meant "failed at any time in the
   * cache's five minutes", so backspacing a search into one that had failed while the relay was down
   * — since recovered — flashed the failure between two lists, and reopening the page opened on a
   * failure from before instead of loading. `isFetchedAfterMount` counts only answers that arrived
   * while this key was being observed, and with no data of its own that answer was an error: the
   * failure the person is looking at.
   */
  const refetchingAFailure =
    buildsQuery.isFetchedAfterMount && (buildsQuery.isPlaceholderData || buildsQuery.isLoading)
  const retryInFlight = retrying || refetchingAFailure

  const view: 'error' | 'loading' | 'empty' | 'list' =
    buildsQuery.isLoadingError || retryInFlight ? 'error'
      : buildsQuery.isLoading ? 'loading'
        : releaseGroups.length === 0 && switching ? 'loading'
          : releaseGroups.length === 0 ? 'empty'
            : 'list'
  // Loading and empty have no control of their own, so focus a swap into one of them took from the
  // region lands on the search box above it.
  const searchRef = useRef<HTMLInputElement>(null)
  const swapRegion = useFocusAfterSwap<HTMLDivElement>(view, searchRef)
  const errorTitleId = useId()
  const errorHintId = useId()
  const emptyTitleId = useId()
  const loadingId = useId()
  const statusId = useId()
  const buildsStatus =
    selectedAppId === null ? ''
      : buildsQuery.isLoadingError ? `Couldn't load builds for ${appName}`
          : buildsQuery.isLoading || switching || retryInFlight ? `Loading builds for ${appName}`
            : releaseGroups.length > 0
              ? `Showing ${builds.length} build${builds.length === 1 ? '' : 's'} for ${appName}`
              // "no builds" and "nothing matches" are different facts, and the visible copy below
              // draws the same distinction.
              : filtered ? `No builds match the current filters for ${appName}`
                : `No builds for ${appName}`

  return (
    <div className="flex h-full gap-0">
      <AppSidebar
        apps={apps}
        selectedAppId={selectedAppId}
        onSelect={handleAppSelect}
        onAdd={() => queryClient.invalidateQueries({ queryKey: ['apps'] })}
        canWrite={canWrite}
      />

      <div className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto min-w-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold tracking-display-sm">
            {selectedApp ? selectedApp.name : 'App Center'}
          </h1>
          <UploadBuildDialog
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ['apps'] })
              queryClient.invalidateQueries({ queryKey: ['builds'] })
            }}
            appId={selectedAppId}
            canWrite={canWrite}
          />
        </div>

        <p id={statusId} role="status" className="sr-only">{buildsStatus}</p>

        {selectedAppId === null ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Layers className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No app selected</p>
            <p className="text-sm text-muted-foreground">Choose an app from the sidebar to view its builds.</p>
          </div>
        ) : (
        <>
        <div className="flex flex-wrap gap-2">
          {/* Described by the loading line or the empty state's title — at most one of them exists, and
              an IDREF that resolves to nothing is ignored, so there is no condition to keep in step with
              the render below. Focus lands here when the list it was in empties out, or when a search
              typed on the failure screen, with nothing ever loaded, turns it into a loading view; the
              focus move flushes the polite status sentence that would otherwise have said which. */}
          <SearchInput
            ref={searchRef}
            aria-describedby={`${loadingId} ${emptyTitleId}`}
            aria-label="Search versions"
            placeholder="Search version…"
            value={search}
            onChange={setSearch}
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36" aria-label="Filter by status"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Backlog">Backlog</SelectItem>
              <SelectItem value="In Progress">In Progress</SelectItem>
              <SelectItem value="Done">Done</SelectItem>
              <SelectItem value="Rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          {/* Not a live region: the toast already announced it. This is the part that has to
              outlast the toast, because the list stays stale after it fades. */}
          {buildsQuery.isRefetchError && (
            <p className="text-sm text-muted-foreground self-center">Showing the last list — refresh failed.</p>
          )}
        </div>

        {/* `contents`, so the region adds no box: the views below are still the flex column's own
            children, and `flex-1` on the failure and empty states keeps meaning what it meant. */}
        <div {...swapRegion} className="contents">
        {view === 'error' ? (
          /* The same three slots as the empty state below — icon, title, line — because a failure
             and an app with no builds are different facts, not different layouts. Before this the
             failure fell through to that empty state and read as "this app has no builds". */
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Ban className="w-8 h-8 text-muted-foreground/40" />
            <p id={errorTitleId} className="text-sm font-medium">Couldn't load builds</p>
            <p id={errorHintId} className="text-sm text-muted-foreground">Check that the relay is reachable.</p>
            {/* **Described by the two lines above**, because focus lands here when the list it was in
                is replaced by this state, and a focus move in the same commit flushes the polite
                `role="status"` sentence in NVDA and JAWS — so the button has to say what failed on
                its own, or all that is heard is "Try again, button".

                **`aria-disabled`, not `disabled`.** A focused element that becomes `disabled` is no
                longer focusable, and the HTML focus-fixup rule sends focus to `body` — while the
                retry runs, from the button just pressed. jsdom does not model that rule, which is why
                the test holding focus on "Trying…" was green against a real browser that drops it. */}
            {/* `aria-disabled` has no styling of its own in the shared `Button`, which only styles
                `disabled:` — so the dimming is restored here, as `SimulatorToolbar` does.

                The guard is what makes `aria-disabled` mean anything, since unlike `disabled` it does
                not stop a click. It is observable when the query key changed during the retry: a
                search typed meanwhile leaves this button up (`retrying` is not per key) over a new
                key whose fetch has already failed, and a second press would refetch that one. */}
            <Button
              variant="outline"
              size="sm"
              className="mt-1 aria-disabled:opacity-50"
              aria-describedby={`${errorTitleId} ${errorHintId}`}
              aria-disabled={retryInFlight}
              onClick={() => {
                if (retryInFlight) return
                setRetrying(true)
                void buildsQuery.refetch().finally(() => setRetrying(false))
              }}
            >
              {retryInFlight ? 'Trying…' : 'Try again'}
            </Button>
          </div>
        ) : view === 'loading' ? (
          <p id={loadingId} className="text-sm text-muted-foreground">Loading…</p>
        ) : view === 'empty' ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Package className="w-8 h-8 text-muted-foreground/40" />
            <p id={emptyTitleId} className="text-sm font-medium">{filtered ? 'No matching builds' : 'No builds yet'}</p>
            <p className="text-sm text-muted-foreground">
              {filtered ? 'No build matches the search and status filters.' : 'Upload the first build to get started.'}
            </p>
          </div>
        ) : (
          /* `aria-busy` while the rows belong to the app you were looking at rather than the one
             the heading now names — the visible half of the same lag. */
          <div ref={listRef} className="flex flex-col gap-2" aria-busy={buildsQuery.isPlaceholderData}>
            {/* `hidden`: heard as the destination's description, which reads hidden text, and not
                met again as a stray sentence by someone reading the list in browse mode. */}
            {noteShown && <p id={leftNoteId} hidden>{leftNote.text}</p>}
            {/* The first release is described by the status line, because it is where focus lands
                when a retry brings the list back — and that focus move flushes the status sentence
                ("Showing N builds for …") that would otherwise have said the retry worked.

                **Not while the rows are held from the app being left.** Then the status line is about
                the app being loaded, and describing the old app's first release with it pairs one app's
                builds with another's name. A retry that succeeds lands on its own key's rows, which
                are not placeholder ones. */}
            {releaseGroups.map(({ versionName, builds: groupBuilds }, index) => (
              <ReleaseAccordion
                key={versionName}
                describedBy={[
                  index === 0 && !buildsQuery.isPlaceholderData ? statusId : null,
                  noteTarget === releaseTarget(versionName) ? leftNoteId : null,
                ].filter(Boolean).join(' ') || undefined}
                rowNote={noteTarget?.startsWith('row:') ? { buildId: Number(noteTarget.slice(4)), id: leftNoteId } : undefined}
                versionName={versionName}
                builds={groupBuilds}
                isOpen={disclosure.isOpen(versionName)}
                onToggle={() => disclosure.toggle(versionName)}
                onNavigate={(id) => navigate(`/app-center/build?id=${id}`)}
                onStatusChange={handleStatusChange}
                onScheduleDeletion={handleScheduleDeletion}
                onCancelDeletion={handleCancelDeletion}
                canWrite={canWrite}
              />
            ))}
          </div>
        )}
        </div>
        </>
        )}
      </div>
    </div>
  )
}
