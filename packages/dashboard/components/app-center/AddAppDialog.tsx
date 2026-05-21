import { useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
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
import { createApp } from '@/lib/queries'

type Props = { onSuccess: () => void }

export function AddAppDialog({ onSuccess }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [platform, setPlatform] = useState<'ios' | 'android' | 'both'>('ios')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const result = await createApp({ name: name.trim(), bundle_id_key: bundleId.trim(), platform })
      if (!result) { setError('Failed to create app'); return }
      if ('error' in result) { setError(result.error); return }
      setOpen(false)
      setName('')
      setBundleId('')
      setPlatform('ios')
      toast.success('App created')
      onSuccess()
    } catch {
      toast.error('Failed to create app — check your network')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
          <Plus className="size-3.5 shrink-0" />
          <span>Add App</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add App</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="app-name">Name</Label>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bundle-id">Bundle ID</Label>
            <Input
              id="bundle-id"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="com.example.myapp"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="platform">Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as 'ios' | 'android')}>
              <SelectTrigger id="platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ios">iOS</SelectItem>
                <SelectItem value="android">Android</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? 'Creating…' : 'Create App'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
