import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
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

  // ── Apps (Admin + Developer) ──────────────────────────────────────────────
  const [apps, setApps] = useState<App[]>([])
  const [appNames, setAppNames] = useState<Record<number, string>>({})
  const [appsSaving, setAppsSaving] = useState<Record<number, boolean>>({})
  const [appsSaved, setAppsSaved] = useState<Record<number, boolean>>({})

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
    <div className="flex flex-col gap-6 max-w-lg">
      <h1 className="text-xl font-semibold">Settings</h1>

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
                <div className="flex items-center gap-4">
                  {logoUrl && (
                    <img src={logoUrl} alt="logo" className="h-12 w-12 rounded object-contain border" />
                  )}
                  <Button type="button" variant="outline" size="sm" onClick={() => logoRef.current?.click()}>
                    {logoFile ? logoFile.name : 'Choose file'}
                  </Button>
                  <input ref={logoRef} type="file" accept=".png,.jpg,.jpeg" className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f && f.size > 2 * 1024 * 1024) { alert('Max 2MB'); return }
                      if (f) setLogoFile(f)
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={workspaceSaving}>
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
              <div className="flex items-center gap-4">
                {avatarUrl && (
                  <img src={avatarUrl} alt="avatar" className="h-10 w-10 rounded-full object-cover border" />
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => avatarRef.current?.click()}>
                  {avatarFile ? avatarFile.name : 'Choose file'}
                </Button>
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
              <Button type="submit" disabled={profileSaving}>
                {profileSaved ? 'Saved!' : profileSaving ? 'Saving…' : 'Save changes'}
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
            <div className="flex flex-col gap-4">
              {apps.map((app) => (
                <div key={app.id} className="flex items-end gap-2">
                  <div className="flex-1 grid gap-1.5">
                    <Label htmlFor={`app-${app.id}`}>
                      {app.bundle_id_key}
                      <span className="ml-2 text-xs text-muted-foreground capitalize">{app.platform}</span>
                    </Label>
                    <Input
                      id={`app-${app.id}`}
                      value={appNames[app.id] ?? ''}
                      onChange={(e) => setAppNames((p) => ({ ...p, [app.id]: e.target.value }))}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={appsSaving[app.id]}
                    onClick={() => handleAppNameSave(app.id)}
                  >
                    {appsSaved[app.id] ? 'Saved!' : appsSaving[app.id] ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
