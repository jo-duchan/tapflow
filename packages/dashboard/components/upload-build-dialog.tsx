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
import { Upload } from 'lucide-react'

type Props = { onSuccess: () => void }

export function UploadBuildDialog({ onSuccess }: Props) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [versionLabel, setVersionLabel] = useState('')
  const [statusLabel, setStatusLabel] = useState('none')
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleUpload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError('')
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      if (versionLabel) form.append('label', versionLabel)
      if (statusLabel !== 'none') form.append('status', statusLabel)

      const res = await fetch('/api/v1/builds', { method: 'POST', credentials: 'include', body: form })
      if (!res.ok) { setError('Upload failed. Check the file format.'); return }
      setOpen(false)
      setFile(null)
      setVersionLabel('')
      setStatusLabel('none')
      onSuccess()
    } catch {
      setError('Network error.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Upload className="mr-2 h-4 w-4" />Upload build</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload build</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleUpload} className="flex flex-col gap-4 pt-2">
          <div className="grid gap-2">
            <Label>File (.ipa or .apk)</Label>
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
              accept=".ipa,.apk"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="version">Version label <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="version" placeholder="e.g. v1.2.3-staging" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} />
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!file || uploading}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
