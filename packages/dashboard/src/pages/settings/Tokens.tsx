import { useEffect, useId, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Plus, Trash2 } from 'lucide-react'
import { loadTeammateBases } from '@/lib/publicLink'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getTokens, queryKeys } from '@/lib/queries'
import { ListStateRow } from '@/components/ListStateRow'
import { listView } from '@/lib/list-view'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import type { ApiToken } from '@/lib/types'

type TokenType = 'api' | 'agent'

type Token = ApiToken

// 'never' matches the API, which reads an omitted expires_in_days as a token with no expiry.
const EXPIRY_PRESETS = ['7', '30', '60', '90'] as const
type Expiry = typeof EXPIRY_PRESETS[number] | 'custom' | 'never'

const schema = z.object({
  name: z.string().min(1, 'Give the token a name'),
  expiry: z.enum([...EXPIRY_PRESETS, 'custom', 'never']),
  expiresDays: z.string(),
}).superRefine((d, ctx) => {
  if (d.expiry !== 'custom') return
  const n = parseInt(d.expiresDays, 10)
  if (isNaN(n) || n < 1 || n > 365) ctx.addIssue({ code: 'custom', path: ['expiresDays'], message: 'Must be between 1 and 365' })
})
type FormData = z.infer<typeof schema>

function expiresInDays(data: FormData): number | undefined {
  if (data.expiry === 'never') return undefined
  return parseInt(data.expiry === 'custom' ? data.expiresDays : data.expiry, 10)
}

export function TokenSettings() {
  const queryClient = useQueryClient()
  const tokensQuery = useQuery({ queryKey: queryKeys.tokens, queryFn: getTokens })
  const tokens = tokensQuery.data ?? []
  const view = listView(tokensQuery)
  // A retry that works replaces the failure row, and the button in it, with the list.
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const listRegion = useFocusAfterSwap<HTMLTableSectionElement>(view, createButtonRef)
  const [open, setOpen] = useState(false)
  const [newToken, setNewToken] = useState('')
  const [tokenType, setTokenType] = useState<TokenType>('api')
  const [agentWsBase, setAgentWsBase] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<number | null>(null)
  const tokenLabelId = useId()
  const commandLabelId = useId()
  const tokenRef = useRef<HTMLInputElement>(null)
  // Toasts render outside the dialog, which an open dialog hides from assistive technology.
  const [dialogStatus, setDialogStatus] = useState('')

  const expiryWarningId = useId()
  const { register, control, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', expiry: '30', expiresDays: '30' },
  })
  const expiry = useWatch({ control, name: 'expiry' })

  const load = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.tokens }) }

  // The form is replaced by the token, which is shown once. Focus goes to it so it can be selected and copied
  // by hand where there is no clipboard API.
  useEffect(() => { if (newToken) tokenRef.current?.focus() }, [newToken])

  async function onCreate(data: FormData) {
    setDialogStatus('')
    try {
      const days = expiresInDays(data)
      const res = await fetch('/api/v1/tokens', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          ...(days !== undefined ? { expires_in_days: days } : {}),
          // api 타입은 scope를 보내지 않아 서버 기본값(view,builds:write)을 따른다
          ...(tokenType === 'agent' ? { scope: 'agent' } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null
        toast.error(err?.error ?? 'Failed to create token')
        setDialogStatus(err?.error ?? 'Failed to create token')
        return
      }
      const json = await res.json() as { token: string }
      // Looked up only for an agent token: the relay address matters only to the command shown for one.
      if (tokenType === 'agent') setAgentWsBase((await loadTeammateBases()).agentWsBase)
      toast.success('Token created')
      setNewToken(json.token)
      load()
    } catch {
      toast.error('Network error')
      setDialogStatus('Network error')
    }
  }

  function handleDialogClose(o: boolean) {
    setOpen(o)
    if (!o) { setNewToken(''); setTokenType('api'); setAgentWsBase(''); setDialogStatus(''); reset() }
  }

  async function handleRevoke(id: number): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/tokens/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) { toast.error('Failed to revoke token'); return false }
      toast.success('Token revoked')
      load()
      return true
    } catch {
      toast.error('Network error')
      return false
    }
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
            <Button ref={createButtonRef} size="sm"><Plus className="mr-2 h-4 w-4" />New token</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Create token</DialogTitle></DialogHeader>
            {/* Mounted before any outcome arrives, so a change is announced. */}
            <p role="status" className="sr-only">{dialogStatus}</p>
            {newToken ? (
              <div className="flex flex-col gap-3 pt-2">
                <p id={tokenLabelId} className="text-sm text-muted-foreground">Copy this token now — it won&apos;t be shown again.</p>
                {/* Fields rather than text: a keyboard user can only select what can take focus. */}
                <Input ref={tokenRef} readOnly value={newToken} aria-labelledby={tokenLabelId} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                {tokenType === 'agent' && agentWsBase && (
                  <>
                    <p id={commandLabelId} className="text-sm text-muted-foreground">Run this on the agent Mac to connect it to this relay:</p>
                    <Input readOnly value={`tapflow agent start --relay ${agentWsBase} --token ${newToken}`} aria-labelledby={commandLabelId} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                  </>
                )}
                <Button onClick={() => {
                  // Cleared first, so a repeated failure changes the status again and is announced again.
                  setDialogStatus('')
                  // Absent on a plain-HTTP page; unchecked, the click throws before .catch is attached and nothing is shown.
                  void (navigator.clipboard ? navigator.clipboard.writeText(newToken) : Promise.reject(new Error('no clipboard')))
                    // Through the reset: a controlled dialog does not report this close through onOpenChange.
                    .then(() => { toast.success('Token copied to clipboard'); handleDialogClose(false) })
                    .catch(() => {
                      toast.error('Failed to copy — copy manually')
                      setDialogStatus('Could not copy the token. Select it and copy it by hand.')
                      tokenRef.current?.focus()
                    })
                }}>
                  Copy & close
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onCreate)} className="flex flex-col gap-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="token-name">Name</Label>
                  <Input id="token-name" placeholder="e.g. ci-deploy" aria-required="true" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'name-error' : undefined} {...register('name')} />
                  <FieldError id="name-error" message={errors.name?.message} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="token-expiry">Expiration</Label>
                  <Controller
                    control={control}
                    name="expiry"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={(v) => field.onChange(v as Expiry)}>
                        {/* The warning is a description of the choice, read when focus comes back to it. */}
                        <SelectTrigger id="token-expiry" ref={field.ref} onBlur={field.onBlur} aria-describedby={field.value === 'never' ? expiryWarningId : undefined}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {EXPIRY_PRESETS.map((d) => <SelectItem key={d} value={d}>{d} days</SelectItem>)}
                          <SelectItem value="custom">Custom…</SelectItem>
                          <SelectItem value="never">No expiration</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {expiry === 'never' && (
                    <p id={expiryWarningId} className="text-sm text-amber-700 dark:text-amber-300">
                      A token without an expiry stays valid until you revoke it. For CI, 90 days or less is recommended.
                    </p>
                  )}
                </div>
                {expiry === 'custom' && (
                  <div className="grid gap-2">
                    <Label htmlFor="expires">Expires in (days)</Label>
                    <Input id="expires" type="number" aria-required="true" aria-invalid={!!errors.expiresDays} aria-describedby={errors.expiresDays ? 'expiresDays-error' : undefined} {...register('expiresDays')} />
                    <FieldError id="expiresDays-error" message={errors.expiresDays?.message} />
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="token-type">Type</Label>
                  <Select value={tokenType} onValueChange={(v) => setTokenType(v as TokenType)}>
                    <SelectTrigger id="token-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api">API — CI uploads &amp; API access</SelectItem>
                      <SelectItem value="agent">Agent — connect remote device agents (Admin only)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  Scope: <Badge variant="secondary">{tokenType === 'agent' ? 'agent' : 'view, builds:write'}</Badge>
                </p>
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
            <TableBody {...listRegion}>
              <ListStateRow
                view={view}
                colSpan={5}
                noun="tokens"
                emptyText="No tokens yet."
                onRetry={() => { void tokensQuery.refetch() }}
              />
              {tokens.map((t) => (
                <TableRow key={t.id} className="hover:bg-transparent">
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell><Badge variant="secondary">{t.scope}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-sm">{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'Never'}</TableCell>
                  <TableCell>
                    {t.expires_at ? (
                      <span className={isExpired(t) ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
                        {isExpired(t) ? 'Expired' : new Date(t.expires_at).toLocaleDateString()}
                      </span>
                    ) : <Badge variant="outline">No expiration</Badge>}
                  </TableCell>
                  <TableCell>
                    <Button variant="destructive" size="icon" className="h-7 w-7" aria-label="Revoke token" onClick={() => setRevokeTarget(t.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={revokeTarget !== null} onOpenChange={(o) => { if (!o) setRevokeTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke token?</AlertDialogTitle>
            <AlertDialogDescription>
              Any active API calls using this token will immediately fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={async () => {
                if (revokeTarget === null) return
                const ok = await handleRevoke(revokeTarget)
                if (ok) setRevokeTarget(null)
              }}
            >
              Revoke
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
