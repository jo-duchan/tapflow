import { useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Pencil } from 'lucide-react'
import { avatarColors } from '@/components/user-avatar'
import { useAuth } from '@/hooks/useAuth'

type App = { id: number; name: string; bundle_id_key: string; platform: string }

const workspaceSchema = z.object({
  teamName: z.string().min(1),
  logo: z.instanceof(File).nullable().optional(),
})
type WorkspaceData = z.infer<typeof workspaceSchema>

const profileSchema = z.object({
  displayName: z.string().min(1),
  avatar: z.instanceof(File).nullable().optional(),
})
type ProfileData = z.infer<typeof profileSchema>

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})
type PasswordData = z.infer<typeof passwordSchema>

export function DefaultSettings() {
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'
  const { user } = useAuth()
  const isAdmin = user?.role === 'Admin'
  const canEditApps = user?.role === 'Admin' || user?.role === 'Developer'

  // ── Workspace (Admin only) ────────────────────────────────────────────────
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [workspaceSaved, setWorkspaceSaved] = useState(false)
  const logoRef = useRef<HTMLInputElement>(null)

  const workspaceForm = useForm<WorkspaceData>({
    resolver: zodResolver(workspaceSchema),
    mode: 'onBlur',
    defaultValues: { teamName: '', logo: null },
  })

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/v1/settings', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { team_name: string; logo_url: string | null } | null) => {
        if (d) { workspaceForm.reset({ teamName: d.team_name, logo: null }); setLogoUrl(d.logo_url) }
      })
  }, [isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onWorkspaceSave(data: WorkspaceData) {
    const form = new FormData()
    form.append('team_name', data.teamName)
    if (data.logo) form.append('logo', data.logo)
    await fetch('/api/v1/settings', { method: 'PATCH', credentials: 'include', body: form })
    setWorkspaceSaved(true)
    setTimeout(() => setWorkspaceSaved(false), 2000)
  }

  // ── Profile (everyone) ────────────────────────────────────────────────────
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const avatarRef = useRef<HTMLInputElement>(null)

  const profileForm = useForm<ProfileData>({
    resolver: zodResolver(profileSchema),
    mode: 'onBlur',
    defaultValues: { displayName: '', avatar: null },
  })

  useEffect(() => {
    if (!user) return
    profileForm.reset({ displayName: user.displayName ?? '', avatar: null })
    setAvatarUrl(user.avatarUrl ?? null)
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onProfileSave(data: ProfileData) {
    const form = new FormData()
    form.append('display_name', data.displayName)
    if (data.avatar) form.append('avatar', data.avatar)
    await fetch('/api/v1/profile', { method: 'PATCH', credentials: 'include', body: form })
    setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
  }

  // ── Password (everyone) ───────────────────────────────────────────────────
  const [passwordSaved, setPasswordSaved] = useState(false)

  const passwordForm = useForm<PasswordData>({
    resolver: zodResolver(passwordSchema),
    mode: 'onBlur',
  })

  async function onPasswordSave(data: PasswordData) {
    const res = await fetch('/api/v1/auth/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }),
    })
    if (!res.ok) {
      const d = await res.json() as { error?: string }
      passwordForm.setError('root', { message: d.error ?? 'Failed to change password' })
      return
    }
    passwordForm.reset()
    setPasswordSaved(true)
    setTimeout(() => setPasswordSaved(false), 2000)
  }

  // ── Apps (Admin + Developer) ──────────────────────────────────────────────
  const [apps, setApps] = useState<App[]>([])
  const [appNames, setAppNames] = useState<Record<number, string>>({})
  const [appsSaving, setAppsSaving] = useState<Record<number, boolean>>({})
  const [appsSaved, setAppsSaved] = useState<Record<number, boolean>>({})
  const [appsDeleting, setAppsDeleting] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (!canEditApps) return
    fetch('/api/v1/apps', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { items: App[] } | null) => {
        if (!d) return
        setApps(d.items)
        const names: Record<number, string> = {}
        d.items.forEach((a) => { names[a.id] = a.name })
        setAppNames(names)
      })
  }, [canEditApps])

  async function handleAppDelete(appId: number) {
    setAppsDeleting((p) => ({ ...p, [appId]: true }))
    await fetch(`/api/v1/apps/${appId}`, { method: 'DELETE', credentials: 'include' })
    setApps((p) => p.filter((a) => a.id !== appId))
    setAppsDeleting((p) => ({ ...p, [appId]: false }))
  }

  async function handleAppNameSave(appId: number) {
    setAppsSaving((p) => ({ ...p, [appId]: true }))
    await fetch(`/api/v1/apps/${appId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: appNames[appId] }),
    })
    setAppsSaving((p) => ({ ...p, [appId]: false }))
    setAppsSaved((p) => ({ ...p, [appId]: true }))
    setTimeout(() => setAppsSaved((p) => ({ ...p, [appId]: false })), 2000)
  }

  const profileDisplayName = profileForm.watch('displayName')

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <h1 className="text-xl font-semibold tracking-display-sm">Settings</h1>

      {/* Workspace — Admin only */}
      {isAdmin && (
        <Card>
          <CardHeader><CardTitle>Workspace</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={workspaceForm.handleSubmit(onWorkspaceSave)} className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="team-name">Team name</Label>
                <Input id="team-name" placeholder="My QA Team" {...workspaceForm.register('teamName')} />
                {workspaceForm.formState.errors.teamName && (
                  <p className="text-sm text-destructive">{workspaceForm.formState.errors.teamName.message}</p>
                )}
              </div>
              <Separator />
              <div className="grid gap-2">
                <Label>Logo <span className="text-muted-foreground text-xs">(png · jpg, max 2MB)</span></Label>
                <Controller
                  name="logo"
                  control={workspaceForm.control}
                  render={({ field }) => (
                    <div className="relative w-16 h-16">
                      <img src={logoUrl ?? defaultLogo} alt="logo" className="w-16 h-16 rounded-lg object-contain" />
                      <button
                        type="button"
                        onClick={() => logoRef.current?.click()}
                        className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <input ref={logoRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f && f.size > 2 * 1024 * 1024) { alert('Max 2MB'); return }
                          if (f) { field.onChange(f); setLogoUrl(URL.createObjectURL(f)) }
                        }}
                      />
                    </div>
                  )}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={workspaceForm.formState.isSubmitting}>
                  {workspaceSaved ? 'Saved!' : workspaceForm.formState.isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Profile — everyone */}
      <Card>
        <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={profileForm.handleSubmit(onProfileSave)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="display-name">Nickname</Label>
              <Input id="display-name" placeholder="Your name" {...profileForm.register('displayName')} />
              {profileForm.formState.errors.displayName && (
                <p className="text-sm text-destructive">{profileForm.formState.errors.displayName.message}</p>
              )}
            </div>
            <Separator />
            <div className="grid gap-2">
              <Label>Avatar <span className="text-muted-foreground text-xs">(png · jpg, max 2MB)</span></Label>
              <Controller
                name="avatar"
                control={profileForm.control}
                render={({ field }) => (
                  <div className="relative w-14 h-14">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="avatar" className="w-14 h-14 rounded-full object-cover border" />
                    ) : (
                      <div
                        className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-medium"
                        style={(() => { const c = avatarColors(profileDisplayName || user?.email || ''); return { backgroundColor: c.bg, color: c.fg } })()}
                      >
                        {profileDisplayName?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => avatarRef.current?.click()}
                      className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <input ref={avatarRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f && f.size > 2 * 1024 * 1024) { alert('Max 2MB'); return }
                        if (f) { field.onChange(f); setAvatarUrl(URL.createObjectURL(f)) }
                      }}
                    />
                  </div>
                )}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={profileForm.formState.isSubmitting}>
                {profileSaved ? 'Saved!' : profileForm.formState.isSubmitting ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Password — everyone */}
      <Card>
        <CardHeader><CardTitle>Password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={passwordForm.handleSubmit(onPasswordSave)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input id="current-password" type="password" {...passwordForm.register('currentPassword')} />
              {passwordForm.formState.errors.currentPassword && (
                <p className="text-sm text-destructive">{passwordForm.formState.errors.currentPassword.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" type="password" {...passwordForm.register('newPassword')} />
              {passwordForm.formState.errors.newPassword && (
                <p className="text-sm text-destructive">{passwordForm.formState.errors.newPassword.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input id="confirm-password" type="password" {...passwordForm.register('confirmPassword')} />
              {passwordForm.formState.errors.confirmPassword && (
                <p className="text-sm text-destructive">{passwordForm.formState.errors.confirmPassword.message}</p>
              )}
            </div>
            {passwordForm.formState.errors.root && (
              <p className="text-sm text-destructive">{passwordForm.formState.errors.root.message}</p>
            )}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={passwordForm.formState.isSubmitting}>
                {passwordSaved ? 'Saved!' : passwordForm.formState.isSubmitting ? 'Saving…' : 'Change password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Apps — Admin + Developer */}
      {canEditApps && apps.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Apps</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-col divide-y divide-border">
              {apps.map((app) => (
                <div key={app.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                  <Label htmlFor={`app-${app.id}`}>App Name</Label>
                  <Input
                    id={`app-${app.id}`}
                    value={appNames[app.id] ?? ''}
                    onChange={(e) => setAppNames((p) => ({ ...p, [app.id]: e.target.value }))}
                  />
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-mono">{app.bundle_id_key}</span>
                      <Badge
                        tone={app.platform === 'ios' ? 'ios' : app.platform === 'android' ? 'android' : undefined}
                        variant={app.platform === 'both' ? 'secondary' : undefined}
                        className="capitalize"
                      >
                        {app.platform}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={appsSaving[app.id]}
                        onClick={() => handleAppNameSave(app.id)}
                      >
                        {appsSaved[app.id] ? 'Saved!' : appsSaving[app.id] ? 'Saving…' : 'Save'}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="destructive" disabled={appsDeleting[app.id]}>
                            {appsDeleting[app.id] ? 'Deleting…' : 'Delete'}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete app?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete <strong>{app.name}</strong> and all its builds. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="w-24">Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className={cn(buttonVariants({ variant: 'destructive' }), 'w-24')}
                              onClick={() => handleAppDelete(app.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
