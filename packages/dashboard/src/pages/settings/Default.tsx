import { useEffect, useRef, useState } from 'react'
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
import { ImageIcon, Pencil } from 'lucide-react'
import { avatarColors } from '@/components/user-avatar'
import { useAuth } from '@/hooks/useAuth'

type App = { id: number; name: string; bundle_id_key: string; platform: string }

export function DefaultSettings() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'Admin'
  const canEditApps = user?.role === 'Admin' || user?.role === 'Developer'

  // ── Workspace (Admin only) ────────────────────────────────────────────────
  const [teamName, setTeamName] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const logoRef = useRef<HTMLInputElement>(null)
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceSaved, setWorkspaceSaved] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/v1/settings', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) { setTeamName(d.team_name); setLogoUrl(d.logo_url) } })
  }, [isAdmin])

  async function handleWorkspaceSave(e: { preventDefault(): void }) {
    e.preventDefault()
    setWorkspaceSaving(true)
    const form = new FormData()
    form.append('team_name', teamName)
    if (logoFile) form.append('logo', logoFile)
    await fetch('/api/v1/settings', { method: 'PATCH', credentials: 'include', body: form })
    setWorkspaceSaving(false)
    setWorkspaceSaved(true)
    setTimeout(() => setWorkspaceSaved(false), 2000)
  }

  // ── Profile (everyone) ────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const avatarRef = useRef<HTMLInputElement>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    setDisplayName(user.displayName ?? '')
    setAvatarUrl(user.avatarUrl ?? null)
  }, [user])

  async function handleProfileSave(e: { preventDefault(): void }) {
    e.preventDefault()
    setProfileSaving(true)
    const form = new FormData()
    form.append('display_name', displayName)
    if (avatarFile) form.append('avatar', avatarFile)
    await fetch('/api/v1/profile', { method: 'PATCH', credentials: 'include', body: form })
    setProfileSaving(false)
    setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
  }

  // ── Password (everyone) ──────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSaved, setPasswordSaved] = useState(false)

  async function handlePasswordChange(e: { preventDefault(): void }) {
    e.preventDefault()
    if (newPassword !== confirmPassword) { setPasswordError('Passwords do not match'); return }
    setPasswordError('')
    setPasswordSaving(true)
    try {
      const res = await fetch('/api/v1/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!res.ok) {
        const d = await res.json()
        setPasswordError(d.error ?? 'Failed to change password')
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordSaved(true)
      setTimeout(() => setPasswordSaved(false), 2000)
    } finally {
      setPasswordSaving(false)
    }
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
      .then((d) => {
        if (!d) return
        setApps(d.items)
        const names: Record<number, string> = {}
        d.items.forEach((a: App) => { names[a.id] = a.name })
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

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <h1 className="text-xl font-semibold tracking-display-sm">Settings</h1>

      {/* Workspace — Admin only */}
      {isAdmin && (
        <Card>
          <CardHeader><CardTitle>Workspace</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleWorkspaceSave} className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="team-name">Team name</Label>
                <Input id="team-name" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="My QA Team" />
              </div>
              <Separator />
              <div className="grid gap-2">
                <Label>Logo <span className="text-muted-foreground text-xs">(png · jpg, max 2MB)</span></Label>
                <div className="relative w-16 h-16">
                  {logoUrl ? (
                    <img src={logoUrl} alt="logo" className="w-16 h-16 rounded-lg object-contain border bg-muted" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg border-2 border-dashed border-border bg-muted flex items-center justify-center">
                      <ImageIcon className="w-6 h-6 text-muted-foreground" />
                    </div>
                  )}
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
                      if (f) { setLogoFile(f); setLogoUrl(URL.createObjectURL(f)) }
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={workspaceSaving}>
                  {workspaceSaved ? 'Saved!' : workspaceSaving ? 'Saving…' : 'Save changes'}
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
          <form onSubmit={handleProfileSave} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="display-name">Nickname</Label>
              <Input id="display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
            </div>
            <Separator />
            <div className="grid gap-2">
              <Label>Avatar <span className="text-muted-foreground text-xs">(png · jpg, max 2MB)</span></Label>
              <div className="relative w-14 h-14">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="avatar" className="w-14 h-14 rounded-full object-cover border" />
                ) : (
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-medium"
                    style={(() => { const c = avatarColors(displayName || user?.email || ''); return { backgroundColor: c.bg, color: c.fg } })()}
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
                <input ref={avatarRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f && f.size > 2 * 1024 * 1024) { alert('Max 2MB'); return }
                    if (f) { setAvatarFile(f); setAvatarUrl(URL.createObjectURL(f)) }
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={profileSaving}>
                {profileSaved ? 'Saved!' : profileSaving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Password — everyone */}
      <Card>
        <CardHeader><CardTitle>Password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordChange} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />
            </div>
            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={passwordSaving}>
                {passwordSaved ? 'Saved!' : passwordSaving ? 'Saving…' : 'Change password'}
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
