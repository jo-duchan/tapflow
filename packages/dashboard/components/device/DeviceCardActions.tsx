import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Ellipsis, Star } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { DeviceSummary } from '@/lib/types'
import { shownName } from '@/lib/deviceGroups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  device: DeviceSummary
  /** The Mac's key for settings kept on the relay (`SessionInfo.agentKey`). Absent from a relay that predates them,
   *  which then offers neither control. */
  agentKey: string | undefined
  isAdmin: boolean
  /** Asks for a fresh listing, which carries what was just changed. */
  refresh: () => void
  /** Whether a hidden device leaves the list: false while an Admin is shown hidden devices. */
  hidingLeaves: boolean
  /** The card is about to leave the list: focus must go somewhere first. */
  onLeaving: () => void
}

/**
 * The star and, for an Admin, the ⋯ menu beside a device card (#1085). Siblings of the card's own button, never inside
 * it: a button cannot hold another.
 */
export function DeviceCardActions({ device, agentKey, isAdmin, refresh, hidingLeaves, onLeaving }: Props) {
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const starRef = useRef<HTMLButtonElement>(null)
  // The star had focus when it was pressed. A starred card moves to another group in the same grid, and moving a node
  // (taking it out and putting it back) drops focus. Which nodes React moves depends on its reconcile: in the test's
  // un-star it moved the siblings and focus stayed, but nothing promises that for every order, so focus is put back
  // if it was dropped.
  const refocusStar = useRef(false)
  useLayoutEffect(() => {
    if (!refocusStar.current) return
    refocusStar.current = false
    if (document.activeElement === document.body) starRef.current?.focus()
  }, [device.favourite])
  // Set while a Hide is on its way: the card may be gone by the time the menu would hand focus back to it.
  const hidingRef = useRef(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  if (!agentKey) return null
  const ref = { agent: agentKey, deviceId: device.id }
  const name = shownName(device)

  async function toggleFavourite() {
    if (busy) return
    refocusStar.current = document.activeElement === starRef.current
    setBusy(true)
    const res = device.favourite
      ? await api.delete('/api/v1/device-favourites', ref)
      : await api.put('/api/v1/device-favourites', ref)
    setBusy(false)
    if (res.error) {
      // Nothing moves, so nothing is put back — and a later change from elsewhere must not take focus.
      refocusStar.current = false
      toast.error(`Could not update favourites: ${res.error}`)
      return
    }
    refresh()
  }

  async function setHidden(hidden: boolean) {
    const leaves = hidden && hidingLeaves
    hidingRef.current = leaves
    const res = await api.put('/api/v1/device-prefs', { ...ref, hidden })
    if (res.error) {
      toast.error(`Could not ${hidden ? 'hide' : 'show'} ${name}: ${res.error}`)
      if (leaves) menuRef.current?.focus()
      return
    }
    if (hidden) {
      if (leaves) onLeaving()
      toast.success(`${name} is hidden from the device list`, {
        action: { label: 'Undo', onClick: () => { void setHidden(false) } },
      })
    }
    refresh()
  }

  function openRename() {
    setDraft(device.displayName ?? '')
    setRenameError(null)
    setRenaming(true)
  }

  async function saveName(e: FormEvent) {
    e.preventDefault()
    if (renameBusy) return
    setRenameBusy(true)
    setRenameError(null)
    const res = await api.put('/api/v1/device-prefs', { ...ref, displayName: draft.trim() || null })
    setRenameBusy(false)
    // Said inside the dialog: a toast is hidden from screen readers while it is open.
    if (res.error) { setRenameError(`Could not rename the device: ${res.error}`); return }
    setRenaming(false)
    refresh()
  }

  return (
    <div className="absolute right-2 top-2 flex items-center gap-0.5">
      <Button
        variant="ghost" size="icon-sm"
        aria-pressed={device.favourite === true}
        aria-label={device.favourite ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
        aria-disabled={busy}
        className="h-8 w-8 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        ref={starRef}
        onClick={() => { void toggleFavourite() }}
        data-star-for={device.id}
      >
        <Star aria-hidden="true" className={cn(device.favourite && 'fill-current text-amber-500')} />
      </Button>
      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menuRef} variant="ghost" size="icon-sm" className="h-8 w-8" aria-label={`Actions for ${name}`}>
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40"
            onCloseAutoFocus={(e) => { if (hidingRef.current) { e.preventDefault(); hidingRef.current = false } }}>
            <DropdownMenuItem onSelect={openRename}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void setHidden(!device.hidden) }}>
              {device.hidden ? 'Show' : 'Hide'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={renaming} onOpenChange={(open) => { if (!open && !renameBusy) setRenaming(false) }}>
        {/* Opened from a menu item, not a trigger, so focus is put back on the menu by hand. */}
        <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); menuRef.current?.focus() }}>
          <form onSubmit={(e) => { void saveName(e) }} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Rename device</DialogTitle>
              <DialogDescription>
                The name the team sees in the device list. Automation and MCP clients keep using its own
                name, {device.name}.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`device-name-${device.id}`}>Device name</Label>
              <Input id={`device-name-${device.id}`} value={draft} maxLength={100}
                placeholder={device.name} aria-describedby={`device-name-hint-${device.id}`}
                onChange={(e) => setDraft(e.target.value)} />
              <p id={`device-name-hint-${device.id}`} className="text-xs text-muted-foreground">
                Leave it empty to use the device&apos;s own name.
              </p>
            </div>
            <p role="status" className="text-sm text-destructive">{renameError}</p>
            <DialogFooter>
              <Button type="button" variant="outline" className="w-24" onClick={() => setRenaming(false)}>Cancel</Button>
              <Button type="submit" aria-disabled={renameBusy}
                className="w-24 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed">
                {renameBusy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
