import { useRef, useState, type FormEvent } from 'react'
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
import { ChevronDown, ChevronRight, Upload } from 'lucide-react'

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
            <Label>File</Label>
            <div
              className="flex h-24 cursor-pointer items-center justify-center rounded-md border-2 border-dashed text-sm text-muted-foreground hover:border-primary"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f) }}
            >
              {file ? file.name : 'Click or drag to upload'}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,.apk,.tgz,.tar.gz,application/gzip,application/x-gzip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              iOS: <code>.app.zip</code> or <code>.tar.gz</code> / <code>.tgz</code> (e.g. an EAS simulator build)
              &nbsp;·&nbsp;Android: <code>.apk</code>
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Status <span className="text-muted-foreground">(optional)</span></Label>
            <Select value={statusLabel} onValueChange={setStatusLabel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
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
          <div className="grid gap-2">
            <Button type="button" variant="ghost" size="sm" className="w-fit px-0 hover:bg-transparent"
              aria-expanded={overrideOpen} aria-controls={overrideOpen ? 'upload-override' : undefined}
              onClick={() => setOverrideOpen((o) => !o)}>
              {overrideOpen ? <ChevronDown className="mr-1 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-1 h-4 w-4" aria-hidden />}
              Override version
            </Button>
            {overrideOpen && (
              <div id="upload-override" className="grid gap-3">
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
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="w-24" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="w-24" disabled={!file}>Upload</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
