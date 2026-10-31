import { useEffect, useId, useRef, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { FormErrorCount } from '@/components/ui/form-error-count'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { joinPath, loadTeammateBases } from '@/lib/publicLink'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getTeamMembers, queryKeys } from '@/lib/queries'
import { ListStateRow } from '@/components/ListStateRow'
import { listView } from '@/lib/list-view'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import type { TeamMember } from '@/lib/types'

type Member = TeamMember

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email'),
  role: z.string().min(1, 'Pick a role'),
})
type InviteData = z.infer<typeof inviteSchema>

const inviteResponseSchema = z.object({
  token: z.string(),
  emailSent: z.boolean(),
  inviteUrl: z.string().nullable(),
})

const resetResponseSchema = z.object({
  token: z.string(),
  emailSent: z.boolean(),
  resetUrl: z.string().nullable(),
})

interface IssuedReset { email: string; link: string; copied: boolean; emailSent: boolean }

/** A plain-HTTP page has no clipboard API. That is a copy that did not happen, not a failure. */
function copyToClipboard(text: string): Promise<boolean> {
  return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
    .then(() => true, () => false)
}

/**
 * A link the Admin hands to a teammate, shown whether or not it was copied. Focus goes to it on mount,
 * where it can be selected and copied by hand — the only way on a plain-HTTP page.
 */
function CopyableLink({ link, copied, noun }: { link: string; copied: boolean; noun: string }) {
  const labelId = useId()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [link])
  return (
    <>
      <p id={labelId} className="text-sm text-muted-foreground">{copied ? `${noun[0].toUpperCase()}${noun.slice(1)} copied to clipboard:` : `Copy this ${noun}:`}</p>
      <Input ref={ref} readOnly value={link} aria-labelledby={labelId} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
    </>
  )
}

export function TeamSettings() {
  const queryClient = useQueryClient()
  const membersQuery = useQuery({ queryKey: queryKeys.teamMembers, queryFn: getTeamMembers })
  const members: Member[] = membersQuery.data ?? []
  const view = listView(membersQuery)
  const inviteButtonRef = useRef<HTMLButtonElement>(null)
  const listRegion = useFocusAfterSwap<HTMLTableSectionElement>(view, inviteButtonRef)
  const [issuedReset, setIssuedReset] = useState<IssuedReset | null>(null)
  // Open is its own state so closing leaves `issuedReset` in place while the dialog animates out — clearing it
  // there showed "Email could not be sent to ." for the length of the fade.
  const [resetOpen, setResetOpen] = useState(false)
  // The reset dialog opens from state, with no `DialogTrigger` for Radix to return focus to, so the
  // row's button is remembered here and focus goes back to it on close.
  const resetReturnRef = useRef<HTMLButtonElement | null>(null)
  const [inviteLink, setInviteLink] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [inviteStatus, setInviteStatus] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  const { register, handleSubmit, control, reset, setError, formState: { errors, isSubmitting, submitCount } } = useForm<InviteData>({
    shouldFocusError: false, // FormErrorCount focuses, once the field is described (#824)
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'QA' },
  })

  const load = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.teamMembers }) }

  async function onInvite(data: InviteData) {
    // Cleared first, so a retry that fails the same way is announced again.
    setInviteStatus('')
    try {
      const res = await fetch('/api/v1/team/invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, role: data.role }),
      })
      // The relay refuses an address that already has an account: an invitation never changes one.
      if (res.status === 409) {
        setError('email', { message: 'Already a member. Change their role in the list instead.' })
        return
      }
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const json = inviteResponseSchema.parse(await res.json())
      // The relay returns the link it mailed (#788). It has none to offer when its only address is one a
      // teammate cannot open, and then the link is built from the teammate base.
      const link = json.inviteUrl ?? joinPath((await loadTeammateBases()).linkBase, `/invite?token=${json.token}`)
      const copied = await copyToClipboard(link)
      setInviteLink(link)
      setLinkCopied(copied)
      // Toasts render outside the dialog, and an open dialog hides everything outside it from assistive
      // technology, so the outcome is also said inside the dialog.
      setInviteStatus(`${json.emailSent ? `Invite email sent to ${data.email}.` : 'Email could not be sent.'} ${copied ? 'Invite link copied to clipboard.' : 'Copy the invite link.'}`)
      if (json.emailSent) {
        toast.success(`Invite email sent to ${data.email}`)
      } else if (copied) {
        toast.warning('Invite link copied — email could not be sent. Check your SMTP settings.')
      } else {
        toast.warning('Email could not be sent. Copy the invite link from the dialog, and check your SMTP settings.')
      }
    } catch {
      toast.error('Failed to create invite link')
      setInviteStatus('Failed to create invite link.')
    }
  }

  function handleDialogClose(open: boolean) {
    setInviteOpen(open)
    // Cleared on the way in, not on the way out: a closing dialog stays on screen through its exit animation,
    // and clearing it then showed the empty form fading out in place of what was just issued.
    if (open) { setInviteLink(''); setLinkCopied(false); setInviteStatus(''); reset() }
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

  // Mirrors the invitation: the Admin always gets the link, and mail is sent as well when it can be, so
  // an install without SMTP can still reset a password.
  async function handleSendReset(member: Member) {
    try {
      const res = await fetch(`/api/v1/team/members/${member.id}/send-reset`, { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const json = resetResponseSchema.parse(await res.json())
      const link = json.resetUrl ?? joinPath((await loadTeammateBases()).linkBase, `/reset-password?token=${json.token}`)
      const copied = await copyToClipboard(link)
      setIssuedReset({ email: member.email, link, copied, emailSent: json.emailSent })
      setResetOpen(true)
      if (json.emailSent) {
        toast.success(`Reset email sent to ${member.email}`)
      } else if (copied) {
        toast.warning('Reset link copied — email could not be sent. Send the link to the member yourself.')
      } else {
        toast.warning('Email could not be sent. Copy the reset link from the dialog and send it to the member.')
      }
    } catch {
      toast.error('Failed to create reset link')
    }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/v1/team/members/${id}`, { method: 'DELETE', credentials: 'include' })
    setPendingDeleteId(null)
    load()
  }

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <AlertDialog open={pendingDeleteId !== null} onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
            <AlertDialogDescription>
              This member will lose access to the team immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-0"
              onClick={() => pendingDeleteId !== null && handleDelete(pendingDeleteId)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent size="md" onCloseAutoFocus={(e) => { e.preventDefault(); resetReturnRef.current?.focus() }}>
          <DialogHeader>
            <DialogTitle>Password reset link</DialogTitle>
            <DialogDescription>
              {issuedReset?.emailSent ? `Reset email sent to ${issuedReset.email}.` : `Email could not be sent to ${issuedReset?.email ?? ''}.`}{' '}
              The link works once, for 2 hours. Making a new one turns this one off. Completing the reset
              signs the member out everywhere and revokes their personal access tokens, so agents using
              those tokens disconnect until new ones are issued.
            </DialogDescription>
          </DialogHeader>
          {issuedReset && (
            <div className="flex flex-col gap-3 pt-2">
              <CopyableLink link={issuedReset.link} copied={issuedReset.copied} noun="reset link" />
              <Button onClick={() => setResetOpen(false)}>Done</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Team</h1>
        <Dialog open={inviteOpen} onOpenChange={handleDialogClose}>
          <DialogTrigger asChild>
            <Button ref={inviteButtonRef} size="sm"><UserPlus className="mr-2 h-4 w-4" />Invite member</Button>
          </DialogTrigger>
          <DialogContent size="md">
            <DialogHeader><DialogTitle>Invite team member</DialogTitle></DialogHeader>
            {/* Mounted before the outcome arrives, so the change is announced. */}
            <p role="status" className="sr-only">{inviteStatus}</p>
            {inviteLink ? (
              <div className="flex flex-col gap-3 pt-2">
                <CopyableLink link={inviteLink} copied={linkCopied} noun="invite link" />
                <Button onClick={() => handleDialogClose(false)}>Done</Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onInvite)} className="flex flex-col gap-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" type="email" aria-required="true" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} {...register('email')} />
                  <FieldError id="email-error" message={errors.email?.message} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="invite-role">Role</Label>
                  <Controller
                    name="role"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger
                          id="invite-role"
                          aria-invalid={!!errors.role}
                          aria-describedby={errors.role ? 'role-error' : undefined}
                        ><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Admin">Admin</SelectItem>
                          <SelectItem value="Developer">Developer</SelectItem>
                          <SelectItem value="QA">QA</SelectItem>
                          <SelectItem value="Viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {/* The Select is seeded with `QA` and offers no empty option, so this cannot
                      fire today. It is here because the rule exists: a validation message with
                      nowhere to render is the silent refusal this whole change is about, and the
                      cost of the slot is one line. */}
                  <FieldError id="role-error" message={errors.role?.message} />
                </div>
                <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating link…' : 'Generate invite link'}</Button>
                <FormErrorCount errors={errors} submitCount={submitCount} />
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle>Members{membersQuery.data ? ` (${members.length})` : ''}</CardTitle></CardHeader>
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
            <TableBody {...listRegion}>
              <ListStateRow
                view={view}
                colSpan={5}
                noun="team members"
                emptyText="No members yet."
                onRetry={() => { void membersQuery.refetch() }}
              />
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
                      <Button variant="secondary" size="nav" onClick={(e) => { resetReturnRef.current = e.currentTarget; void handleSendReset(m) }}>
                        Reset pwd
                      </Button>
                      <Button variant="destructive" size="nav" onClick={() => setPendingDeleteId(m.id)}>
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
