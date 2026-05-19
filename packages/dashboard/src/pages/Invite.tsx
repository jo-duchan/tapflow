import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Pencil } from 'lucide-react'
import { avatarColors } from '@/components/user-avatar'

const schema = z.object({
  displayName: z.string().optional(),
  avatar: z.instanceof(File).nullable().optional(),
  password: z.string().min(8),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path: ['confirm'],
})
type FormData = z.infer<typeof schema>

export function Invite() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'valid' | 'invalid'>('loading')
  const [inviteRole, setInviteRole] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const avatarRef = useRef<HTMLInputElement>(null)

  const { register, handleSubmit, control, watch, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { displayName: '', avatar: null },
  })
  const displayName = watch('displayName') ?? ''

  useEffect(() => {
    if (!token) { setStatus('invalid'); return }
    fetch(`/api/v1/invitations/verify?token=${token}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: { role: string }) => { setInviteRole(data.role); setStatus('valid') })
      .catch(() => setStatus('invalid'))
  }, [token])

  async function onSubmit(data: FormData) {
    try {
      const form = new FormData()
      form.append('token', token)
      form.append('password', data.password)
      if (data.displayName?.trim()) form.append('display_name', data.displayName.trim())
      if (data.avatar) form.append('avatar', data.avatar)

      const res = await fetch('/api/v1/invitations/accept', { method: 'POST', body: form })
      if (!res.ok) { setError('root', { message: 'Failed to accept invitation' }); return }
      navigate('/app-center', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  if (status === 'loading') return <div className="flex min-h-svh items-center justify-center" />

  if (status === 'invalid') {
    return (
      <div className="bg-mesh-gradient flex min-h-svh items-center justify-center overflow-hidden p-4">
        <Card level={4} className="w-full max-w-sm text-center">
          <CardHeader>
            <CardTitle>Invitation expired</CardTitle>
            <CardDescription>This invite link is invalid or has expired. Ask your admin for a new one.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="bg-mesh-gradient flex min-h-svh items-center justify-center overflow-hidden p-4">
      <Card level={4} className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Set up your account</CardTitle>
          <CardDescription>You&apos;re joining as <strong>{inviteRole}</strong></CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="display-name">Nickname <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input id="display-name" placeholder="Your name" {...register('displayName')} />
            </div>

            <div className="grid gap-2">
              <Label>Avatar <span className="text-muted-foreground text-xs">(optional, png · jpg, max 2MB)</span></Label>
              <Controller
                name="avatar"
                control={control}
                render={({ field }) => (
                  <div className="relative w-14 h-14">
                    {avatarPreview ? (
                      <img src={avatarPreview} alt="avatar" className="w-14 h-14 rounded-full object-cover border" />
                    ) : (
                      <div
                        className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-medium"
                        style={(() => { const c = avatarColors(displayName); return { backgroundColor: c.bg, color: c.fg } })()}
                      >
                        {displayName?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => avatarRef.current?.click()}
                      className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <input
                      ref={avatarRef}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        if (f.size > 2 * 1024 * 1024) { setError('avatar', { message: 'Max 2MB for avatar' }); return }
                        field.onChange(f)
                        setAvatarPreview(URL.createObjectURL(f))
                      }}
                    />
                  </div>
                )}
              />
              {errors.avatar && <p className="text-sm text-destructive">{errors.avatar.message}</p>}
            </div>

            <Separator />

            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" {...register('password')} />
              {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" {...register('confirm')} />
              {errors.confirm && <p className="text-sm text-destructive">{errors.confirm.message}</p>}
            </div>

            {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
