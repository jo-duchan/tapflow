import { useState, type FormEvent } from 'react'
import type { Build } from '@/lib/types'
import type { BuildEdit } from '@/lib/queries'
import { buildRowName } from '@/lib/build-format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/** The relay's bound on each field (`MAX_BUILD_TEXT`), held here too so the dialog cannot send what it refuses. */
const MAX = 100

interface Props {
  /** The build being edited, or null when closed. */
  build: Build | null
  onClose: () => void
  /** After the dialog has closed and handed focus back. A refetch that can take the row away waits for this: started
   *  sooner, it can drop the row while the dialog still holds focus, and the hand-back then finds nothing. */
  onClosed?: () => void
  /** Saves and resolves to null, or to what to say inside the dialog when the save failed. */
  onSave: (edit: BuildEdit) => Promise<string | null>
}

/**
 * Edit build (#1084): the label, and the version and build number that override the build file's.
 *
 * **One dialog for the page, not one per row.** A version edit moves the build into another release, which React
 * draws as a new row under another parent; a dialog inside the old row would vanish mid-close and drop focus on
 * `body`. Here it outlives the move, and on closing it finds the row's ⋯ wherever the row is now.
 */
export function EditBuildDialog({ build, onClose, onClosed, onSave }: Props) {
  // Kept after `build` clears, so the closing frame still has its fields and the focus return knows the row.
  const [shown, setShown] = useState<Build | null>(null)
  // Whether this opening has been set up. Reset on each opening, so a reopened build starts from what it holds now
  // rather than from what was typed and cancelled last time.
  const [opened, setOpened] = useState(false)
  const [label, setLabel] = useState('')
  const [version, setVersion] = useState('')
  const [buildNumber, setBuildNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Set up on each opening, during render rather than in an effect (dashboard AGENTS.md, set-state-in-effect).
  if (!build && opened) setOpened(false)
  if (build && !opened) {
    setOpened(true)
    setShown(build)
    setLabel(build.version_label ?? '')
    // An override shows as itself; none shows as empty, with the file's value as the placeholder.
    setVersion(build.version_name !== build.binary.version_name ? build.version_name ?? '' : '')
    setBuildNumber(build.build_number !== build.binary.build_number ? build.build_number ?? '' : '')
    setError(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !shown) return
    setBusy(true)
    setError(null)
    const failure = await onSave({
      version_label: label.trim() || null,
      version_name: version.trim() || null,
      build_number: buildNumber.trim() || null,
    })
    setBusy(false)
    // Said inside the dialog: a toast is hidden from screen readers while it is open.
    if (failure) setError(failure)
  }

  const fromFile = shown?.binary
  const hint = (value: string | null | undefined, what: string) =>
    value ? `From the build file: ${value}. Leave empty to use it.` : `The build file has no ${what}.`

  return (
    <Dialog open={build !== null} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          // Opened from a menu item, not a trigger: focus goes back to the row's ⋯, found now, after any move.
          e.preventDefault()
          if (shown) document.querySelector<HTMLElement>(`[data-row-menu="${shown.id}"]`)?.focus()
          onClosed?.()
        }}
      >
        <form onSubmit={(e) => { void submit(e) }} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit build</DialogTitle>
            <DialogDescription>
              {shown ? `${buildRowName(shown)}. ` : ''}The version and build number change how tapflow shows and groups
              this build, not the app installed on the device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-build-label">Label</Label>
            <Input id="edit-build-label" value={label} maxLength={MAX} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-build-version">Version</Label>
            <Input id="edit-build-version" value={version} maxLength={MAX} placeholder={fromFile?.version_name ?? ''}
              aria-describedby="edit-build-version-hint" onChange={(e) => setVersion(e.target.value)} />
            <p id="edit-build-version-hint" className="text-xs text-muted-foreground">{hint(fromFile?.version_name, 'version')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-build-number">Build number</Label>
            <Input id="edit-build-number" value={buildNumber} maxLength={MAX} placeholder={fromFile?.build_number ?? ''}
              aria-describedby="edit-build-number-hint" onChange={(e) => setBuildNumber(e.target.value)} />
            <p id="edit-build-number-hint" className="text-xs text-muted-foreground">{hint(fromFile?.build_number, 'build number')}</p>
          </div>
          <p role="status" className="text-sm text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="outline" className="w-24" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" aria-disabled={busy} className="w-24 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed">
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
