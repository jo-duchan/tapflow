import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getApps, getSettings, queryKeys } from '@/lib/queries'
import { useTheme } from 'next-themes'
import { useForm, useWatch, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
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
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { avatarColors } from '@/lib/avatar'
import { useAuth } from '@/hooks/useAuth'


const workspaceSchema = z.object({
  teamName: z.string().min(1, 'Team name is required'),
  logo: z.instanceof(File).nullable().optional(),
})
type WorkspaceData = z.infer<typeof workspaceSchema>

const profileSchema = z.object({
  displayName: z.string().min(1, 'Display name is required'),
  avatar: z.instanceof(File).nullable().optional(),
})
type ProfileData = z.infer<typeof profileSchema>

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
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
  // Everyone but Viewer manages apps — the same rule the relay enforces on /api/v1/apps.
  const canEditApps = user?.role === 'Admin' || user?.role === 'Developer' || user?.role === 'QA'

  // ── Workspace (Admin only) ────────────────────────────────────────────────
  const queryClient = useQueryClient()
  // Shared with the sidebar, which shows the same name and logo — so saving here updates it too.
  const settingsQuery = useQuery({ queryKey: queryKeys.settings, queryFn: getSettings, enabled: isAdmin })
  // A picked file's preview, until the saved logo replaces it.
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const logoUrl = logoPreview ?? settingsQuery.data?.logo_url ?? null
  const logoRef = useRef<HTMLInputElement>(null)

  // `values` rather than a reset from an effect. `keepDirtyValues`: a refetch on window focus must
  // not overwrite what someone is typing.
  const workspaceForm = useForm<WorkspaceData>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { teamName: '', logo: null },
    values: settingsQuery.data ? { teamName: settingsQuery.data.team_name, logo: null } : undefined,
    resetOptions: { keepDirtyValues: true },
  })

  async function onWorkspaceSave(data: WorkspaceData) {
    const form = new FormData()
    form.append('team_name', data.teamName)
    if (data.logo) form.append('logo', data.logo)
    try {
      const res = await fetch('/api/v1/settings', { method: 'PATCH', credentials: 'include', body: form })
      if (!res.ok) { toast.error('Failed to update workspace'); return }
      toast.success('Workspace updated')
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
    } catch {
      toast.error('Failed to update workspace')
    }
  }

  // ── Profile (everyone) ────────────────────────────────────────────────────
  // Derived from the signed-in user rather than copied into state by an effect.
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const avatarUrl = avatarPreview ?? user?.avatarUrl ?? null
  const avatarRef = useRef<HTMLInputElement>(null)

  const profileForm = useForm<ProfileData>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: '', avatar: null },
    values: user ? { displayName: user.displayName ?? '', avatar: null } : undefined,
    resetOptions: { keepDirtyValues: true },
  })

  async function onProfileSave(data: ProfileData) {
    const form = new FormData()
    form.append('display_name', data.displayName)
    if (data.avatar) form.append('avatar', data.avatar)
    try {
      const res = await fetch('/api/v1/profile', { method: 'PATCH', credentials: 'include', body: form })
      if (!res.ok) { toast.error('Failed to update profile'); return }
      toast.success('Profile updated')
      void queryClient.invalidateQueries({ queryKey: queryKeys.me })
    } catch {
      toast.error('Failed to update profile')
    }
  }

  const passwordForm = useForm<PasswordData>({
    resolver: zodResolver(passwordSchema),
  })

  async function onPasswordSave(data: PasswordData) {
    try {
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
      toast.success('Password changed')
    } catch {
      passwordForm.setError('root', { message: 'Network error' })
    }
  }

  // ── Apps (Admin + Developer) ──────────────────────────────────────────────
  // The same list App Center reads, so a rename or delete here shows there too.
  const appsQuery = useQuery({ queryKey: queryKeys.apps, queryFn: getApps, enabled: canEditApps })
  const apps = appsQuery.data ?? []
  // Names being edited, by app. An app not in here shows its saved name.
  const [appNames, setAppNames] = useState<Record<number, string>>({})
  const [appsSaving, setAppsSaving] = useState<Record<number, boolean>>({})
  const [appsDeleting, setAppsDeleting] = useState<Record<number, boolean>>({})

  async function handleAppDelete(appId: number) {
    setAppsDeleting((p) => ({ ...p, [appId]: true }))
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) { toast.error('Failed to delete app'); return }
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps })
      toast.success('App deleted')
    } catch {
      toast.error('Failed to delete app')
    } finally {
      setAppsDeleting((p) => ({ ...p, [appId]: false }))
    }
  }

  async function handleAppNameSave(appId: number) {
    setAppsSaving((p) => ({ ...p, [appId]: true }))
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: appNames[appId] ?? apps.find((a) => a.id === appId)?.name }),
      })
      if (!res.ok) { toast.error('Failed to update app'); return }
      toast.success('App updated')
      setAppNames(({ [appId]: _saved, ...rest }) => rest)
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps })
    } catch {
      toast.error('Failed to update app')
    } finally {
      setAppsSaving((p) => ({ ...p, [appId]: false }))
    }
  }

  const profileDisplayName = useWatch({ control: profileForm.control, name: 'displayName' })

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
                <Input id="team-name" placeholder="My QA Team" aria-required="true" aria-invalid={!!workspaceForm.formState.errors.teamName} aria-describedby={workspaceForm.formState.errors.teamName ? 'teamName-error' : undefined} {...workspaceForm.register('teamName')} />
                <FieldError id="teamName-error" message={workspaceForm.formState.errors.teamName?.message} />
              </div>
              <Separator />
              <div className="grid gap-2">
                <Label>Logo <span className="text-muted-foreground text-xs">(png · jpg, max 2MB)</span></Label>
                <Controller
                  name="logo"
                  control={workspaceForm.control}
                  render={({ field }) => (
                    <div className="relative w-16 h-16">
                      <img src={logoUrl ?? defaultLogo} alt="Workspace logo" className="w-16 h-16 rounded-lg object-contain" />
                      <button
                        type="button"
                        aria-label="Change logo"
                        onClick={() => logoRef.current?.click()}
                        className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
                      >
                        <Pencil className="w-3 h-3" aria-hidden="true" />
                      </button>
                      <input ref={logoRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f && f.size > 2 * 1024 * 1024) { toast.error('Image must be 2MB or less'); return }
                          if (f) { field.onChange(f); setLogoPreview(URL.createObjectURL(f)) }
                        }}
                      />
                    </div>
                  )}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={workspaceForm.formState.isSubmitting}>
                  {workspaceForm.formState.isSubmitting ? 'Saving…' : 'Save changes'}
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
              <Input id="display-name" placeholder="Your name" aria-required="true" aria-invalid={!!profileForm.formState.errors.displayName} aria-describedby={profileForm.formState.errors.displayName ? 'displayName-error' : undefined} {...profileForm.register('displayName')} />
              <FieldError id="displayName-error" message={profileForm.formState.errors.displayName?.message} />
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
                      <img src={avatarUrl} alt="Profile avatar" className="w-14 h-14 rounded-full object-cover border" />
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
                      aria-label="Change avatar"
                      onClick={() => avatarRef.current?.click()}
                      className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
                    >
                      <Pencil className="w-3 h-3" aria-hidden="true" />
                    </button>
                    <input ref={avatarRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f && f.size > 2 * 1024 * 1024) { toast.error('Image must be 2MB or less'); return }
                        if (f) { field.onChange(f); setAvatarPreview(URL.createObjectURL(f)) }
                      }}
                    />
                  </div>
                )}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={profileForm.formState.isSubmitting}>
                {profileForm.formState.isSubmitting ? 'Saving…' : 'Save changes'}
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
              <Input id="current-password" type="password" aria-required="true" autoComplete="current-password" aria-invalid={!!passwordForm.formState.errors.currentPassword} aria-describedby={passwordForm.formState.errors.currentPassword ? 'currentPassword-error' : undefined} {...passwordForm.register('currentPassword')} />
              <FieldError id="currentPassword-error" message={passwordForm.formState.errors.currentPassword?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" type="password" aria-required="true" autoComplete="new-password" aria-invalid={!!passwordForm.formState.errors.newPassword} aria-describedby={passwordForm.formState.errors.newPassword ? 'newPassword-error' : undefined} {...passwordForm.register('newPassword')} />
              <FieldError id="newPassword-error" message={passwordForm.formState.errors.newPassword?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input id="confirm-password" type="password" aria-required="true" autoComplete="new-password" aria-invalid={!!passwordForm.formState.errors.confirmPassword} aria-describedby={passwordForm.formState.errors.confirmPassword ? 'confirmPassword-error' : undefined} {...passwordForm.register('confirmPassword')} />
              <FieldError id="confirmPassword-error" message={passwordForm.formState.errors.confirmPassword?.message} />
            </div>
            <FieldError assertive id="default-error" message={passwordForm.formState.errors.root?.message} />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={passwordForm.formState.isSubmitting}>
                {passwordForm.formState.isSubmitting ? 'Saving…' : 'Change password'}
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
                    value={appNames[app.id] ?? app.name}
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
                        {appsSaving[app.id] ? 'Saving…' : 'Save'}
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
