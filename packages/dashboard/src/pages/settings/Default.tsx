import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export function DefaultSettings() {
  const [teamName, setTeamName] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const logoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/v1/settings', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) { setTeamName(d.team_name); setLogoUrl(d.logo_url) } })
  }, [])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    const form = new FormData()
    form.append('team_name', teamName)
    if (logoFile) form.append('logo', logoFile)
    await fetch('/api/v1/settings', { method: 'PATCH', credentials: 'include', body: form })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <h1 className="text-xl font-semibold">Default settings</h1>

      <Card>
        <CardHeader><CardTitle>Workspace</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-4">
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
                <input
                  ref={logoRef}
                  type="file"
                  accept=".png,.jpg,.jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f && f.size > 2 * 1024 * 1024) { alert('Max 2MB'); return }
                    if (f) setLogoFile(f)
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={saving}>
                {saved ? 'Saved!' : saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
