import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Layers, Package } from 'lucide-react'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UploadBuildDialog } from '@/components/upload-build-dialog'
import { AppSidebar } from '@/components/app-center/AppSidebar'
import { ReleaseAccordion } from '@/components/app-center/ReleaseAccordion'
import { getApps, getBuilds, updateBuildStatus, groupByRelease } from '@/lib/queries'
import type { App, Build } from '@/lib/types'

export function AppCenter() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [apps, setApps] = useState<App[]>([])
  const [builds, setBuilds] = useState<Build[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [openReleases, setOpenReleases] = useState<Set<string>>(new Set())

  const selectedAppId = searchParams.get('appId') ? Number(searchParams.get('appId')) : null
  const selectedApp   = apps.find(a => a.id === selectedAppId) ?? null

  const fetchApps = useCallback(async () => {
    const items = await getApps()
    setApps(items)
    if (!searchParams.get('appId') && items.length > 0) {
      setSearchParams({ appId: String(items[0].id) }, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const fetchBuilds = useCallback(async () => {
    if (!selectedAppId) { setBuilds([]); setLoading(false); return }
    setLoading(true)
    try {
      const items = await getBuilds({ appId: selectedAppId, search, statusFilter })
      setBuilds(items)
      if (items.length > 0 && openReleases.size === 0) {
        setOpenReleases(new Set([items[0].version_name ?? 'Unversioned']))
      }
    } finally {
      setLoading(false)
    }
  }, [selectedAppId, search, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchApps() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchBuilds() }, [fetchBuilds])

  function handleAppSelect(id: number) {
    if (id !== selectedAppId) {
      setBuilds([])
      setOpenReleases(new Set())
    }
    setSearchParams({ appId: String(id) })
  }

  function handleToggleRelease(versionName: string) {
    setOpenReleases(prev => {
      const next = new Set(prev)
      if (next.has(versionName)) next.delete(versionName)
      else next.add(versionName)
      return next
    })
  }

  async function handleStatusChange(buildId: number, status: string | null) {
    await updateBuildStatus(buildId, status)
    setBuilds(prev => prev.map(b =>
      b.id === buildId ? { ...b, status_label: status as Build['status_label'] } : b
    ))
  }

  const releaseGroups = groupByRelease(builds)

  return (
    <div className="flex h-full gap-0">
      <AppSidebar
        apps={apps}
        selectedAppId={selectedAppId}
        onSelect={handleAppSelect}
        onAdd={fetchApps}
      />

      <main className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto min-w-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold tracking-display-sm">
            {selectedApp ? selectedApp.name : 'App Center'}
          </h1>
          <UploadBuildDialog onSuccess={() => { fetchApps(); fetchBuilds() }} appId={selectedAppId} />
        </div>

        {!selectedAppId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Layers className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No app selected</p>
            <p className="text-sm text-muted-foreground">Choose an app from the sidebar to view its builds.</p>
          </div>
        ) : (
        <>
        <div className="flex flex-wrap gap-2">
          <SearchInput
            placeholder="Search version…"
            value={search}
            onChange={setSearch}
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Backlog">Backlog</SelectItem>
              <SelectItem value="In Progress">In Progress</SelectItem>
              <SelectItem value="Done">Done</SelectItem>
              <SelectItem value="Rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : releaseGroups.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Package className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No builds yet</p>
            <p className="text-sm text-muted-foreground">Upload the first build to get started.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {releaseGroups.map(({ versionName, builds: groupBuilds }) => (
              <ReleaseAccordion
                key={versionName}
                versionName={versionName}
                builds={groupBuilds}
                isOpen={openReleases.has(versionName)}
                onToggle={() => handleToggleRelease(versionName)}
                onNavigate={(id) => navigate(`/app-center/build?id=${id}`)}
                onStatusChange={handleStatusChange}
              />
            ))}
          </div>
        )}
        </>
        )}
      </main>
    </div>
  )
}
