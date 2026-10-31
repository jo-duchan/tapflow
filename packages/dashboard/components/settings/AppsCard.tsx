import { Fragment, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { Ellipsis, GripVertical } from 'lucide-react'
import { toast } from 'sonner'
import { queryKeys } from '@/lib/queries'
import type { App } from '@/lib/types'
import { canDrop, canSplit, rowsOf, UNKNOWN_BUNDLE_ID, whyFixed, type AppRow } from '@/lib/appRows'
import { cn } from '@/lib/utils'
import { PLATFORM_LABEL } from '@/lib/build-format'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Arrow keys jump between the apps `accepts` says a row can go to, top to bottom. dnd-kit's default moves the row 25px a
 * press, which takes a keyboard user many presses to reach the next card.
 */
const LAND = 8

function jumpBetweenApps(accepts: (activeId: string, droppableId: string) => boolean): KeyboardCoordinateGetter {
  return (event, { active, context }) => {
    const down = event.code === 'ArrowDown' || event.code === 'ArrowRight'
    const up = event.code === 'ArrowUp' || event.code === 'ArrowLeft'
    if (!down && !up) return undefined
    event.preventDefault()
    const at = context.collisionRect?.top ?? 0
    const rects = context.droppableContainers.getEnabled()
      .filter((c) => accepts(String(active), String(c.id)))
      .map((c) => context.droppableRects.get(c.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .sort((a, b) => a.top - b.top)
    // Compared by where the row lands (8px in), so a row already on an app moves off it in either direction.
    const next = down ? rects.find((r) => r.top + LAND > at + 1) : [...rects].reverse().find((r) => r.top + LAND < at - 1)
    return next ? { x: next.left + LAND, y: next.top + LAND } : undefined
  }
}

interface Pending { row: AppRow; source: App; target: App }
/**
 * How long a merge or split dialog waits for the app list after the relay said yes. A list that never answers (a laptop
 * that slept on a dead connection) would otherwise leave the dialog busy with no way out; past this it closes as if the
 * refetch had failed.
 */
const LIST_WAIT_MS = 5000
const listedWithin = (refetch: Promise<unknown>) =>
  Promise.race([refetch, new Promise((resolve) => setTimeout(resolve, LIST_WAIT_MS))])
interface PendingSplit { row: AppRow; source: App }
/** What a droppable id names: an app (`app:<id>`), or the New app area below one (`new:<id>`, the row's own app). */
type Target = { kind: 'app'; app: App } | { kind: 'new'; source: App }

const menuOf = (appId: number) => `[data-app-menu="${appId}"]`

export function AppsCard({ apps }: { apps: App[] }) {
  const queryClient = useQueryClient()
  const byId = new Map(apps.map((a) => [a.id, a]))
  const targetOf = (droppableId: string): Target | undefined => {
    const [kind, appId] = droppableId.split(':')
    const app = byId.get(Number(appId))
    if (!app) return undefined
    return kind === 'new' ? { kind: 'new', source: app } : { kind: 'app', app }
  }
  const allows = (row: AppRow, target: Target) =>
    target.kind === 'app' ? canDrop(row, target.app) : canSplit(row, target.source)
  const targetName = (target: Target) => target.kind === 'app' ? target.app.name : 'New app'
  const rowOfKey = (key: string): AppRow | undefined => {
    const [, appId, platform] = key.split(':')
    const app = byId.get(Number(appId))
    return app && rowsOf(app).find((r) => r.platform === platform)
  }

  // One element for both labels, so switching the mode never unmounts the focused button.
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  // Where focus goes when a dialog closes. Every dialog here is opened by state — from an app's menu or by a drop — so
  // none has a trigger for Radix to return to.
  const focusAfterRef = useRef<string | null>(null)
  const returnFocus = (e: Event) => {
    e.preventDefault()
    const back = focusAfterRef.current ? document.querySelector<HTMLElement>(focusAfterRef.current) : null
    ;(back ?? modeButtonRef.current)?.focus()
  }

  // ── Renaming ────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<App | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  function openEdit(app: App) {
    focusAfterRef.current = menuOf(app.id)
    setNameDraft(app.name)
    setNameError(null)
    setEditing(app)
  }

  async function saveName(e: FormEvent) {
    e.preventDefault()
    if (!editing || nameBusy || !nameDraft.trim()) return
    setNameBusy(true)
    setNameError(null)
    try {
      const res = await fetch(`/api/v1/apps/${editing.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameDraft.trim() }),
      })
      // Said inside the dialog: a toast is hidden from screen readers while it is open.
      if (!res.ok) { setNameError('Failed to update app'); return }
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps })
      setEditing(null)
      toast.success('App updated')
    } catch {
      setNameError('Could not reach the relay')
    } finally {
      setNameBusy(false)
    }
  }

  // ── Deletion ────────────────────────────────────────────────────────────
  const [deleting, setDeleting] = useState<App | null>(null)

  function openDelete(app: App) {
    // The app's own menu goes with it, so focus lands on a neighbour's.
    const i = apps.findIndex((a) => a.id === app.id)
    const neighbour = apps[i + 1] ?? apps[i - 1]
    focusAfterRef.current = neighbour ? menuOf(neighbour.id) : null
    setDeleting(app)
  }

  async function handleAppDelete(appId: number) {
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) { toast.error('Failed to delete app'); return }
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps })
      toast.success('App deleted')
    } catch {
      toast.error('Failed to delete app')
    }
  }

  // ── Arrange mode (#1086) ────────────────────────────────────────────────
  // People decide which bundle IDs are one product, merging or splitting; the relay only refuses what would break its rules.
  const [arranging, setArranging] = useState(false)
  const [dragging, setDragging] = useState<AppRow | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const accepts = (activeId: string, droppableId: string) => {
    const row = rowOfKey(activeId)
    const target = targetOf(droppableId)
    return row !== undefined && target !== undefined && allows(row, target)
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: jumpBetweenApps(accepts) }),
  )

  const rowLabel = (row: AppRow) => `${rowText(row)} (${PLATFORM_LABEL[row.platform]})`
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const row = rowOfKey(String(active.id))
      return row ? `Picked up ${rowLabel(row)}. Use the arrow keys to move to another app.` : undefined
    },
    onDragOver: ({ active, over }) => {
      const target = over ? targetOf(String(over.id)) : undefined
      return target && accepts(String(active.id), String(over!.id)) ? `Over ${targetName(target)}.` : 'Not over an app this can go to.'
    },
    onDragEnd: ({ active, over }) => {
      const target = over ? targetOf(String(over.id)) : undefined
      return target && accepts(String(active.id), String(over!.id)) ? `Dropped on ${targetName(target)}.` : 'Nothing changed.'
    },
    onDragCancel: () => 'Cancelled. Nothing changed.',
  }

  function onDragStart({ active }: DragStartEvent) {
    setDragging(rowOfKey(String(active.id)) ?? null)
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null)
    const row = rowOfKey(String(active.id))
    const target = over ? targetOf(String(over.id)) : undefined
    const source = row && byId.get(row.appId)
    if (!row || !target || !source || !allows(row, target)) return
    focusAfterRef.current = `[data-row-key="${String(active.id)}"]`
    if (target.kind === 'new') {
      setSplitName(`${source.name} (${PLATFORM_LABEL[row.platform]})`)
      setSplitError(null)
      setSplitting({ row, source })
      return
    }
    setMergeError(null)
    setPending({ row, source, target: target.app })
  }

  async function confirmMerge() {
    if (!pending || mergeBusy) return
    setMergeBusy(true)
    setMergeError(null)
    try {
      const res = await fetch(`/api/v1/apps/${pending.target.id}/merge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAppId: pending.source.id, platform: pending.row.platform }),
      })
      if (!res.ok) {
        // Said inside the dialog: a toast is hidden from screen readers while it is open.
        const body = await res.json().catch(() => ({})) as { error?: string }
        setMergeError(body.error ?? 'Could not merge these apps')
        setMergeBusy(false)
        return
      }
      // The kept app's menu: two apps becoming one removes the mode button, and the dropped row went with the merge.
      focusAfterRef.current = menuOf(pending.target.id)
      const moving = { sourceId: pending.source.id, platform: pending.row.platform }
      setMergeAwait(moving)
      toast.success(`Merged into ${pending.target.name}`)
      void queryClient.invalidateQueries({ queryKey: ['builds'] })
      await listedWithin(queryClient.invalidateQueries({ queryKey: queryKeys.apps }))
      // A refetch that failed or hung, or a list nothing reads: close anyway rather than wait for a render that never comes.
      if (!hasLeft(queryClient.getQueryData<App[]>(queryKeys.apps), moving)) finishMerge()
    } catch {
      setMergeError('Could not reach the relay')
      setMergeBusy(false)
    }
  }

  // Like a split below, the dialog waits for the list where the row has moved, and the drop is shown landed meanwhile:
  // closing first would put the row back in its old app for a moment before the list moves it.
  const [mergeAwait, setMergeAwait] = useState<{ sourceId: number; platform: AppRow['platform'] } | null>(null)
  function finishMerge() {
    setMergeAwait(null)
    setPending(null)
    setMergeBusy(false)
    setArranging(false)
  }
  if (mergeAwait !== null && hasLeft(apps, mergeAwait)) finishMerge()

  // ── Splitting ───────────────────────────────────────────────────────────
  const [splitting, setSplitting] = useState<PendingSplit | null>(null)
  const [splitName, setSplitName] = useState('')
  const [splitBusy, setSplitBusy] = useState(false)
  const [splitError, setSplitError] = useState<string | null>(null)
  // The new app, until the list that has it arrives. The dialog stays open till then: closing first would send focus to
  // a menu that is not on the page yet.
  const [awaitingAppId, setAwaitingAppId] = useState<number | null>(null)
  function finishSplit() {
    setAwaitingAppId(null)
    setSplitting(null)
    setSplitBusy(false)
    setArranging(false)
  }
  // Closed in the render the new app first appears in — awaiting the refetch resolves before that render.
  if (awaitingAppId !== null && byId.has(awaitingAppId)) finishSplit()

  async function confirmSplit(e: FormEvent) {
    e.preventDefault()
    if (!splitting || splitBusy || !splitName.trim()) return
    setSplitBusy(true)
    setSplitError(null)
    try {
      const res = await fetch(`/api/v1/apps/${splitting.source.id}/split`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: splitting.row.platform, name: splitName.trim() }),
      })
      const body = await res.json().catch(() => ({})) as { appId?: number; error?: string }
      if (!res.ok || typeof body.appId !== 'number') {
        // Said inside the dialog: a toast is hidden from screen readers while it is open.
        setSplitError(body.error ?? 'Could not split this app')
        setSplitBusy(false)
        return
      }
      const created = body.appId
      focusAfterRef.current = menuOf(created)
      setAwaitingAppId(created)
      toast.success(`Moved to ${splitName.trim()}`)
      void queryClient.invalidateQueries({ queryKey: ['builds'] })
      await listedWithin(queryClient.invalidateQueries({ queryKey: queryKeys.apps }))
      // A refetch that failed or hung, or a list nothing reads: close anyway rather than wait for a render that never comes.
      if (!queryClient.getQueryData<App[]>(queryKeys.apps)?.some((a) => a.id === created)) finishSplit()
    } catch {
      setSplitError('Could not reach the relay')
      setSplitBusy(false)
    }
  }

  const splitFrom = dragging === null ? undefined : byId.get(dragging.appId)
  // Open while a row that can split is dragged from this app, and kept open, holding the row, while its split is confirmed.
  const showNewApp = (app: App) =>
    splitting?.source.id === app.id || (dragging !== null && splitFrom?.id === app.id && canSplit(dragging, app))
  // The row a confirmation is open for: shown where it was dropped, and faded where it still is.
  const held = pending?.row ?? splitting?.row ?? null
  const isHeld = (row: AppRow) => held !== null && held.appId === row.appId && held.platform === row.platform

  const sourceEmptied = pending !== null && rowsOf(pending.source).length === 1
  // A running count across every app, so neighbouring rows wiggle out of step.
  let rowIndex = 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Apps</CardTitle>
        <div className="flex items-center gap-3">
          {arranging && <p className="text-sm text-muted-foreground">Drag a bundle ID onto another app, or into New app below its own.</p>}
          {/* Kept while arranging: a refetch can leave one app, and the mode must still be leavable. */}
          {(apps.length > 1 || arranging) && (
            <Button ref={modeButtonRef} size="sm" variant={arranging ? 'outline' : 'ghost'} onClick={() => setArranging((m) => !m)}>
              {arranging ? 'Done' : 'Arrange apps'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: 'Press space or enter to pick up this bundle ID. Use the arrow keys to move to another app, space or enter to drop it there, and escape to cancel.' },
            }}>
            <div className="flex flex-col gap-4">
              {apps.map((app) => (
                <Fragment key={app.id}>
                  <AppGroup app={app} arranging={arranging} dragging={dragging}
                    incoming={pending?.target.id === app.id ? pending.row : undefined}
                    menu={
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          {/* Kept in place while arranging so the header does not shift; nothing in it is part of arranging. */}
                          <Button variant="ghost" size="icon-sm" className={cn('h-8 w-8', arranging && 'invisible')}
                            aria-label={`Actions for ${app.name}`} data-app-menu={app.id}>
                            <Ellipsis aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onSelect={() => openEdit(app)}>Edit</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => openDelete(app)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }>
                    {rowsOf(app).map((row) => (
                      <BundleRow key={row.platform} row={row} index={rowIndex++} arranging={arranging} fixedBecause={whyFixed(app)}
                        held={isHeld(row)} />
                    ))}
                  </AppGroup>
                  {showNewApp(app) && (
                    <NewAppZone source={app} incoming={splitting?.source.id === app.id ? splitting.row : undefined} name={splitName} />
                  )}
                </Fragment>
              ))}
            </div>
          </DndContext>
        </TooltipProvider>
      </CardContent>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !nameBusy) setEditing(null) }}>
        <DialogContent onCloseAutoFocus={returnFocus}>
          <form onSubmit={saveName} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Edit app</DialogTitle>
              <DialogDescription>The name the team sees in the App Center.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-name">App name</Label>
              <Input id="app-name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <p role="status" className="text-sm text-destructive">{nameError}</p>
            <DialogFooter>
              <Button type="button" variant="outline" className="w-24" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" disabled={!nameDraft.trim()} aria-disabled={nameBusy}
                className="w-24 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed">
                {nameBusy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          {deleting && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete app?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete <strong>{deleting.name}</strong> and all its builds. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="w-24">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={cn(buttonVariants({ variant: 'destructive' }), 'w-24')}
                  onClick={() => handleAppDelete(deleting.id)}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open && !mergeBusy) setPending(null) }}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Merge into {pending.target.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>{rowLabel(pending.row)}</strong> moves from <strong>{pending.source.name}</strong> with its builds,
                  and their comments, recordings and run records.
                  {sourceEmptied ? ` ${pending.source.name} is then removed.` : ''} The app keeps the name {pending.target.name}.
                  You can split it out again later{sourceEmptied ? `, under a new name` : ''}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <p role="status" className="text-sm text-destructive">{mergeError}</p>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                {/* Waits for the relay and stays open on a refusal, which it says above. */}
                <Button
                  className={cn(buttonVariants({ variant: 'destructive' }), 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed')}
                  aria-disabled={mergeBusy}
                  onClick={confirmMerge}
                >
                  {mergeBusy ? 'Merging…' : 'Merge'}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={splitting !== null} onOpenChange={(open) => { if (!open && !splitBusy) setSplitting(null) }}>
        <DialogContent onCloseAutoFocus={returnFocus}>
          {splitting && (
            <form onSubmit={confirmSplit} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Move {rowLabel(splitting.row)} to a new app?</DialogTitle>
                <DialogDescription>
                  {rowLabel(splitting.row)} moves out of {splitting.source.name} into the new app, with its builds, and their comments, recordings and run records.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="split-name">New app name</Label>
                <Input id="split-name" value={splitName} onChange={(e) => setSplitName(e.target.value)} />
              </div>
              <p role="status" className="text-sm text-destructive">{splitError}</p>
              <DialogFooter>
                {/* 112px, not 96: "Splitting…" does not fit the narrower pair. */}
                <Button type="button" variant="outline" className="w-28" onClick={() => { if (!splitBusy) setSplitting(null) }}>Cancel</Button>
                {/* Waits for the relay and for the list with the new app; stays open on a refusal, which it says above. */}
                <Button type="submit" disabled={!splitName.trim()} aria-disabled={splitBusy}
                  className="w-28 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed">
                  {splitBusy ? 'Splitting…' : 'Split'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** What a row is called on screen and to assistive tech alike, so a spoken "click No bundle ID" finds it. */
function rowText(row: AppRow): string {
  return row.id === UNKNOWN_BUNDLE_ID ? 'No readable bundle ID' : row.id ?? 'No bundle ID'
}

function RowLabel({ row }: { row: AppRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn('truncate text-xs font-mono text-muted-foreground', row.id === null && 'italic')}>
        {rowText(row)}
      </span>
      <Badge tone={row.platform}>{PLATFORM_LABEL[row.platform]}</Badge>
    </span>
  )
}

/** Whether `apps` shows the row gone from its app — or the app gone with it. */
function hasLeft(apps: App[] | undefined, { sourceId, platform }: { sourceId: number; platform: AppRow['platform'] }): boolean {
  if (!apps) return false
  const source = apps.find((a) => a.id === sourceId)
  return !source || !rowsOf(source).some((r) => r.platform === platform)
}

function AppGroup({ app, arranging, dragging, incoming, menu, children }: {
  app: App; arranging: boolean; dragging: AppRow | null; incoming?: AppRow; menu: ReactNode; children: ReactNode
}) {
  const allowed = dragging !== null && canDrop(dragging, app)
  // Not `disabled` for the apps a row cannot go to: whether it can is known only once `dragging` reaches here, and the
  // keyboard and the drop check it anyway. (A droppable registered or enabled mid-drag is measured all the same.)
  const { setNodeRef, isOver } = useDroppable({ id: `app:${app.id}`, disabled: !arranging })
  const isSource = dragging?.appId === app.id
  return (
    <div
      ref={setNodeRef}
      data-app-id={app.id}
      className={cn(
        'flex flex-col gap-2 rounded-lg bg-background px-4 pb-3 pt-4 transition-[box-shadow,opacity]',
        // Only the app under the row is marked: the ones it cannot go to are already dimmed.
        ((allowed && isOver) || incoming) && 'ring-2 ring-foreground',
        dragging !== null && !allowed && !isSource && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{app.name}</span>
        {menu}
      </div>
      <div className="flex flex-col gap-2 py-1.5">
        {children}
        {incoming && <PreviewRow row={incoming} />}
      </div>
    </div>
  )
}

/** The dropped row where it will land, while its confirmation is open. A picture only: nothing in it can be reached. */
function PreviewRow({ row }: { row: AppRow }) {
  return (
    <div aria-hidden="true" data-preview="" className="flex h-11 w-full items-center gap-2 rounded-md bg-card p-1.5">
      <span className="flex h-8 w-6 shrink-0 items-center justify-center rounded-sm bg-background">
        <GripVertical className="size-4 text-muted-foreground" />
      </span>
      <RowLabel row={row} />
    </div>
  )
}

/**
 * Below the dragged row's own app: dropped here, its platform becomes an app of its own. While the split is confirmed it
 * is drawn as that app will be — the name being typed over the row — with the spacing of an app with one row.
 */
function NewAppZone({ source, incoming, name }: { source: App; incoming?: AppRow; name: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `new:${source.id}` })
  if (incoming) {
    return (
      <div ref={setNodeRef} data-drop-box="new-app" className="flex flex-col gap-2 rounded-lg bg-background px-4 pb-3 pt-4 ring-2 ring-foreground">
        <div className="flex h-8 items-center">
          <span aria-hidden="true" className="truncate text-sm font-medium">{name.trim() || 'New app'}</span>
        </div>
        <div className="flex flex-col gap-2 py-1.5"><PreviewRow row={incoming} /></div>
      </div>
    )
  }
  return (
    <div
      ref={setNodeRef}
      data-drop-box="new-app"
      className={cn(
        'flex h-[124px] items-center justify-center rounded-lg border border-dashed border-foreground/30 text-sm text-muted-foreground transition-[box-shadow]',
        isOver && 'border-transparent text-foreground ring-2 ring-foreground',
      )}
    >
      New app
    </div>
  )
}

function BundleRow({ row, index, arranging, fixedBecause, held }: {
  row: AppRow; index: number; arranging: boolean; fixedBecause: string | null; held: boolean
}) {
  const movable = arranging && fixedBecause === null
  const key = `row:${row.appId}:${row.platform}`
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: key, disabled: !movable })
  const style: CSSProperties = {
    ...(transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : {}),
    // Lifted while held, so it reads as picked up — from the keyboard too, before the first arrow moves it. The `scale`
    // property rather than part of `transform`, so it can ease in without the drag's movement easing behind the pointer.
    scale: isDragging ? '1.03' : '1',
    animationDelay: `${-index * 0.11}s`,
  }
  const fixedWhileArranging = arranging && fixedBecause !== null
  const body = (
    <div
      ref={setNodeRef}
      style={style}
      // Focusable only so a keyboard can reach the reason it stays put.
      tabIndex={fixedWhileArranging ? 0 : undefined}
      className={cn(
        'flex h-11 items-center gap-2 rounded-md bg-card motion-safe:[transition:scale_150ms_ease-out,box-shadow_150ms_ease-out]',
        movable ? 'p-1.5' : 'px-4',
        // The whole row, like an icon held on a phone's home screen. Not while dragged: the animation's transform would
        // win over the drag's.
        movable && !isDragging && !held && 'animate-row-wiggle motion-reduce:animate-none',
        // Moving elsewhere once confirmed; still here, so focus can come back to it on a cancel.
        held && 'opacity-40',
        isDragging && 'relative z-10 shadow-md',
        fixedWhileArranging && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {movable && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          aria-label={`Move ${rowText(row)} (${PLATFORM_LABEL[row.platform]}) to another app`}
          data-row-key={key}
          className={cn(
            'flex h-8 w-6 shrink-0 items-center justify-center rounded-sm bg-background touch-none',
            'cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <GripVertical aria-hidden="true" className="size-4 text-muted-foreground" />
        </button>
      )}
      <RowLabel row={row} />
    </div>
  )
  if (!fixedWhileArranging) return body
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{fixedBecause}</TooltipContent>
    </Tooltip>
  )
}
