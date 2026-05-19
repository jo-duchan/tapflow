import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Plus, Trash2 } from 'lucide-react'

type Token = { id: number; name: string; scope: string; last_used_at: string | null; expires_at: string | null; created_at: string }

const schema = z.object({
  name: z.string().min(1),
  expiresDays: z.string().refine(
    (v) => { const n = parseInt(v, 10); return !isNaN(n) && n >= 1 && n <= 365 },
    { message: 'Must be between 1 and 365' },
  ),
})
type FormData = z.infer<typeof schema>

export function TokenSettings() {
  const [tokens, setTokens] = useState<Token[]>([])
  const [open, setOpen] = useState(false)
  const [newToken, setNewToken] = useState('')

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', expiresDays: '30' },
  })

  function load() {
    fetch('/api/v1/tokens', { credentials: 'include' }).then((r) => r.json()).then(setTokens)
  }

  useEffect(() => { load() }, [])

  async function onCreate(data: FormData) {
    const res = await fetch('/api/v1/tokens', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: data.name, expires_in_days: parseInt(data.expiresDays, 10) }),
    })
    const json = await res.json() as { token: string }
    setNewToken(json.token)
    load()
  }

  function handleDialogClose(o: boolean) {
    setOpen(o)
    if (!o) { setNewToken(''); reset() }
  }

  async function handleRevoke(id: number) {
    if (!confirm('Revoke this token? Any active API calls using it will immediately fail.')) return
    await fetch(`/api/v1/tokens/${id}`, { method: 'DELETE', credentials: 'include' })
    load()
  }

  function isExpired(t: Token) {
    return t.expires_at && new Date(t.expires_at) < new Date()
  }

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Personal Access Tokens</h1>
        <Dialog open={open} onOpenChange={handleDialogClose}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="mr-2 h-4 w-4" />New token</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Create token</DialogTitle></DialogHeader>
            {newToken ? (
              <div className="flex flex-col gap-3 pt-2">
                <p className="text-sm text-muted-foreground">Copy this token now — it won&apos;t be shown again.</p>
                <code className="rounded bg-muted px-3 py-2 text-xs break-all font-mono">{newToken}</code>
                <Button onClick={() => { navigator.clipboard.writeText(newToken).catch(() => {}); setOpen(false) }}>
                  Copy & close
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onCreate)} className="flex flex-col gap-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="token-name">Name</Label>
                  <Input id="token-name" placeholder="e.g. ci-deploy" {...register('name')} />
                  {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="expires">Expires in (days)</Label>
                  <Input id="expires" type="number" {...register('expiresDays')} />
                  {errors.expiresDays && <p className="text-sm text-destructive">{errors.expiresDays.message}</p>}
                </div>
                <p className="text-xs text-muted-foreground">Scope: <Badge variant="secondary">builds:write</Badge></p>
                <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating…' : 'Create token'}</Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active tokens</CardTitle>
          <CardDescription>Use these tokens with <code className="text-xs">Authorization: Bearer &lt;token&gt;</code> for API deployments.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pt-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">No tokens yet.</TableCell>
                </TableRow>
              ) : tokens.map((t) => (
                <TableRow key={t.id} className="hover:bg-transparent">
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell><Badge variant="secondary">{t.scope}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-sm">{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'Never'}</TableCell>
                  <TableCell>
                    {t.expires_at ? (
                      <span className={isExpired(t) ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
                        {isExpired(t) ? 'Expired' : new Date(t.expires_at).toLocaleDateString()}
                      </span>
                    ) : <span className="text-muted-foreground text-sm">Never</span>}
                  </TableCell>
                  <TableCell>
                    <Button variant="destructive" size="icon" className="h-7 w-7" onClick={() => handleRevoke(t.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
