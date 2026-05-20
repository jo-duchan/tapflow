import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'

type Member = { id: number; email: string; display_name: string; role: string; joined_at: string }

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.string().min(1),
})
type InviteData = z.infer<typeof inviteSchema>

const inviteResponseSchema = z.object({
  token: z.string(),
  emailSent: z.boolean(),
})

export function TeamSettings() {
  const [members, setMembers] = useState<Member[]>([])
  const [resetSent, setResetSent] = useState<Record<number, string>>({})
  const [inviteLink, setInviteLink] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)

  const { register, handleSubmit, control, reset, formState: { errors, isSubmitting } } = useForm<InviteData>({
    resolver: zodResolver(inviteSchema),
    mode: 'onBlur',
    defaultValues: { email: '', role: 'QA' },
  })

  function load() {
    fetch('/api/v1/team/members', { credentials: 'include' }).then((r) => r.json()).then(setMembers)
  }

  useEffect(() => { load() }, [])

  async function onInvite(data: InviteData) {
    try {
      const res = await fetch('/api/v1/team/invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, role: data.role }),
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const json = inviteResponseSchema.parse(await res.json())
      const link = `${location.origin}/invite?token=${json.token}`
      setInviteLink(link)
      navigator.clipboard.writeText(link).catch(() => {})
      if (json.emailSent) {
        toast.success(`Invite email sent to ${data.email}`)
      } else {
        toast.warning('Invite link copied — email could not be sent. Check your SMTP settings.')
      }
    } catch {
      toast.error('Failed to create invite link')
    }
  }

  function handleDialogClose(open: boolean) {
    setInviteOpen(open)
    if (!open) { setInviteLink(''); reset() }
  }

  async function handleRoleChange(id: number, role: string) {
    await fetch(`/api/v1/team/members/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    load()
  }

  async function handleSendReset(id: number) {
    const res = await fetch(`/api/v1/team/members/${id}/send-reset`, { method: 'POST', credentials: 'include' })
    const data = await res.json() as { emailSent: boolean }
    const msg = data.emailSent ? 'Sent' : 'No SMTP'
    setResetSent((p) => ({ ...p, [id]: msg }))
    setTimeout(() => setResetSent((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
  }

  async function handleDelete(id: number) {
    if (!confirm('Remove this member?')) return
    await fetch(`/api/v1/team/members/${id}`, { method: 'DELETE', credentials: 'include' })
    load()
  }

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Team</h1>
        <Dialog open={inviteOpen} onOpenChange={handleDialogClose}>
          <DialogTrigger asChild>
            <Button size="sm"><UserPlus className="mr-2 h-4 w-4" />Invite member</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Invite team member</DialogTitle></DialogHeader>
            {inviteLink ? (
              <div className="flex flex-col gap-3 pt-2">
                <p className="text-sm text-muted-foreground">Invite link copied to clipboard:</p>
                <code className="rounded bg-muted px-3 py-2 text-xs break-all">{inviteLink}</code>
                <Button onClick={() => setInviteOpen(false)}>Done</Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onInvite)} className="flex flex-col gap-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" type="email" {...register('email')} />
                  {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
                </div>
                <div className="grid gap-2">
                  <Label>Role</Label>
                  <Controller
                    name="role"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Admin">Admin</SelectItem>
                          <SelectItem value="Developer">Developer</SelectItem>
                          <SelectItem value="QA">QA</SelectItem>
                          <SelectItem value="Viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating link…' : 'Generate invite link'}</Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle>Members ({members.length})</CardTitle></CardHeader>
        <CardContent className="px-4 pt-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nickname</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id} className="hover:bg-transparent">
                  <TableCell className="font-medium">{m.display_name || '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{m.email}</TableCell>
                  <TableCell>
                    <Select value={m.role} onValueChange={(r) => handleRoleChange(m.id, r)}>
                      <SelectTrigger className="h-7 w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Admin">Admin</SelectItem>
                        <SelectItem value="Developer">Developer</SelectItem>
                        <SelectItem value="QA">QA</SelectItem>
                        <SelectItem value="Viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(m.joined_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="nav" onClick={() => handleSendReset(m.id)}>
                        {resetSent[m.id] ?? 'Reset pwd'}
                      </Button>
                      <Button variant="destructive" size="nav" onClick={() => handleDelete(m.id)}>
                        Remove
                      </Button>
                    </div>
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
