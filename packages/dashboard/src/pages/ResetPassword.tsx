import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  password: z.string().min(8),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path: ['confirm'],
})
type FormData = z.infer<typeof schema>

export function ResetPassword() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'valid' | 'invalid'>('loading')

  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
  })

  useEffect(() => {
    if (!token) { setStatus('invalid'); return }
    fetch(`/api/v1/auth/reset-password/verify?token=${token}`)
      .then((r) => r.ok ? setStatus('valid') : Promise.reject())
      .catch(() => setStatus('invalid'))
  }, [token])

  async function onSubmit(data: FormData) {
    try {
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: data.password }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setError('root', { message: d.error ?? 'Failed to reset password' })
        return
      }
      navigate('/login', { replace: true })
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
            <CardTitle>Link expired</CardTitle>
            <CardDescription>This password reset link is invalid or has expired. Ask your admin to send a new one.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="bg-mesh-gradient flex min-h-svh items-center justify-center overflow-hidden p-4">
      <Card level={4} className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Reset password</CardTitle>
          <CardDescription>Enter your new password below.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">New password</Label>
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
              {isSubmitting ? 'Saving…' : 'Set new password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
