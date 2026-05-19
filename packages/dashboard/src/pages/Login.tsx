import { useNavigate } from 'react-router-dom'
import { useTheme } from 'next-themes'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})
type FormData = z.infer<typeof schema>

export function Login() {
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'

  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
  })

  async function onSubmit(data: FormData) {
    try {
      const { status } = await api.post('/api/v1/auth/login', { email: data.email, password: data.password })
      if (status !== 200) { setError('root', { message: 'Invalid email or password' }); return }
      navigate('/app-center', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex items-center gap-2">
          <img src={defaultLogo} alt="tapflow" className="w-6 h-6" />
          <span className="text-base font-semibold tracking-tight">tapflow</span>
        </div>
        <Card level={4} className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-display-md">Welcome back</CardTitle>
          <CardDescription>Sign in to your team workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                {...register('email')}
              />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
              />
              {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
            </div>
            {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
            <Button type="submit" size="pill" disabled={isSubmitting} className="w-full mt-1">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              First time here?{' '}
              <a href="https://www.tapflow.dev/dashboard/setup.html" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground transition-colors">
                Set up your workspace
              </a>
            </p>
          </form>
        </CardContent>
        </Card>
      </div>
    </div>
  )
}
