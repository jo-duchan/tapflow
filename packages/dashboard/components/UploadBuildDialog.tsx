import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'

type Props = { onSuccess: () => void; appId?: number | null }

export function UploadBuildDialog({ onSuccess, appId }: Props) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [statusLabel, setStatusLabel] = useState('none')
  const inputRef = useRef<HTMLInputElement>(null)

  function handleUpload(e: FormEvent) {
    e.preventDefault()
    if (!file) return

    const form = new FormData()
    form.append('file', file)
    if (statusLabel !== 'none') form.append('status', statusLabel)
    if (appId) form.append('app_id', String(appId))

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
    setFile(null)
    setStatusLabel('none')
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) { setFile(null); setStatusLabel('none') }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm"><Upload className="mr-2 h-4 w-4" />Upload build</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="w-24" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="w-24" disabled={!file}>Upload</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
