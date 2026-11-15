import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { ChevronRight, Upload } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/** The relay's bound on each text field (`MAX_BUILD_TEXT`), so this dialog cannot send what it refuses. The dialog
 *  closes on submit and the answer arrives as a toast; holding a large upload's dialog open for a 400 is not worth it. */
const MAX = 100

type Props = { onSuccess: () => void; appId?: number | null; canWrite: boolean }

export function UploadBuildDialog({ onSuccess, appId, canWrite }: Props) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [statusLabel, setStatusLabel] = useState('none')
  const [label, setLabel] = useState('')
  // Overriding what the file says is rare, so it is folded away until asked for (#1084).
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [buildNumber, setBuildNumber] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const fileId = useId()
  const statusId = useId()
  const fileNameCharacters = Array.from(file?.name ?? '')

  function handleUpload(e: FormEvent) {
    e.preventDefault()
    if (!file) return

    const form = new FormData()
    form.append('file', file)
    if (statusLabel !== 'none') form.append('status', statusLabel)
    if (appId) form.append('app_id', String(appId))
    // Empty fields are not sent: the relay reads the file's own values for them.
    if (label.trim()) form.append('label', label.trim())
    if (version.trim()) form.append('version_name', version.trim())
    if (buildNumber.trim()) form.append('build_number', buildNumber.trim())

    const uploadPromise = fetch('/api/v1/builds', {
      method: 'POST',
      credentials: 'include',
      body: form,
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Upload failed. Check the file format.')
      }
      onSuccess()
    })

    toast.promise(uploadPromise, {
      loading: 'Uploading build…',
      success: 'Build uploaded',
      error: (err: unknown) =>
        err instanceof Error ? err.message : 'Failed to upload build',
    })

    setOpen(false)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    // Cleared on the way in, not on the way out: a closing dialog stays on screen through its exit animation,
    // and clearing it then showed the empty drop zone fading out in place of the file just chosen.
    if (next) {
      setFile(null); setStatusLabel('none'); setLabel('')
      setOverrideOpen(false); setVersion(''); setBuildNumber('')
    }
  }

  // Viewer keeps a focusable, named button whose press explains the refusal — see AddAppDialog.
  if (!canWrite) {
    return (
      <Button size="sm" onClick={() => toast.error("Viewers can't upload builds. Ask an Admin for QA or Developer access.")}>
        <Upload className="mr-2 h-4 w-4" />Upload build
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm"><Upload className="mr-2 h-4 w-4" />Upload build</Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Upload build</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleUpload} className="flex flex-col gap-4 pt-2">
          <div className="grid gap-2">
            <Label htmlFor={fileId}>File</Label>
            <Button
              id={fileId}
              type="button"
              variant="outline"
              title={file?.name}
              aria-describedby={`${fileId}-name`}
              className="h-24 min-w-0 w-full border-2 border-dashed font-normal text-muted-foreground hover:border-primary hover:bg-background hover:text-muted-foreground"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f) }}
            >
              <span id={`${fileId}-name`} className="sr-only">{file ? file.name : 'Click or drag to upload'}</span>
              {file ? (
                <span aria-hidden="true" className="flex min-w-0 max-w-full">
                  <span className="truncate">{fileNameCharacters.slice(0, -16).join('')}</span>
                  <span className="shrink-0">{fileNameCharacters.slice(-16).join('')}</span>
                </span>
              ) : <span aria-hidden="true">Click or drag to upload</span>}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,.apk,.tgz,.tar.gz,application/gzip,application/x-gzip"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              iOS: <code>.app.zip</code> or <code>.tar.gz</code> / <code>.tgz</code> (e.g. an EAS simulator build)
              &nbsp;·&nbsp;Android: <code>.apk</code>
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={statusId}>Status <span className="text-muted-foreground">(optional)</span></Label>
            <Select value={statusLabel} onValueChange={setStatusLabel}>
              <SelectTrigger id={statusId}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="Backlog">Backlog</SelectItem>
                <SelectItem value="In Progress">In Progress</SelectItem>
                <SelectItem value="Done">Done</SelectItem>
                <SelectItem value="Rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="upload-label">Label <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="upload-label" value={label} maxLength={MAX} placeholder="e.g. staging, feature X"
              onChange={(e) => setLabel(e.target.value)} />
          </div>
          {/* A Collapsible: the fields grow into place rather than appearing. Closed, they are not in the DOM; what was
              typed in them is kept by this dialog's state. */}
          <Collapsible open={overrideOpen} onOpenChange={setOverrideOpen} className="grid gap-2">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="w-fit px-0 hover:bg-transparent"
                aria-controls={overrideOpen ? 'upload-override' : undefined}>
                <ChevronRight className={cn('mr-1 h-4 w-4 transition-transform motion-reduce:transition-none', overrideOpen && 'rotate-90')} aria-hidden />
                Override version
              </Button>
            </CollapsibleTrigger>
            {/* Room past the panel's edges: it clips while it animates, and a field's focus ring is drawn outside it. */}
            <CollapsibleContent id="upload-override" className="-mx-1 px-1 pb-1">
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">
                  Leave a field empty to use what the build file says. This changes how tapflow shows and groups the build,
                  not the app installed on the device.
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="upload-version">Version</Label>
                  <Input id="upload-version" value={version} maxLength={MAX} onChange={(e) => setVersion(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upload-build-number">Build number</Label>
                  <Input id="upload-build-number" value={buildNumber} maxLength={MAX} onChange={(e) => setBuildNumber(e.target.value)} />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="w-24" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="w-24" disabled={!file}>Upload</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
