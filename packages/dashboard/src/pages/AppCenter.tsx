import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UploadBuildDialog } from '@/components/upload-build-dialog'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'

// ── types ──────────────────────────────────────────────────────────────────

type App = {
  id: number
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android'
  latest_build_id: number | null
  version_name: string | null
  build_number: string | null
  status_label: string | null
  latest_uploaded_at: string | null
}

type Build = {
  id: number
  app_id: number
  name: string
  version_name: string | null
  build_number: string | null
  version_label: string | null
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  bundle_id: string | null
  uploaded_at: string
  uploader: string | null
}

type ReleaseGroup = {
  versionName: string     // 그룹 키 (version_name 또는 'Unversioned')
  builds: Build[]
}

// ── constants ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  Backlog: 'secondary',
  'In Progress': 'default',
  Done: 'outline',
  Rejected: 'destructive',
}

// ── helpers ────────────────────────────────────────────────────────────────

function groupByRelease(builds: Build[]): ReleaseGroup[] {
  const map = new Map<string, Build[]>()
  for (const b of builds) {
    const key = b.version_name ?? 'Unversioned'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(b)
  }
  return Array.from(map.entries()).map(([versionName, builds]) => ({ versionName, builds }))
}

async function updateStatus(id: number, status: string | null) {
  await fetch(`/api/v1/builds/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_label: status === 'none' ? null : status }),
  })
}

// ── main component ─────────────────────────────────────────────────────────

export function AppCenter() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [apps, setApps] = useState<App[]>([])
  const [builds, setBuilds] = useState<Build[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [openReleases, setOpenReleases] = useState<Set<string>>(new Set())

  const selectedAppId = searchParams.get('appId') ? Number(searchParams.get('appId')) : null
  const selectedApp   = apps.find(a => a.id === selectedAppId) ?? null

  // apps 목록 로드
  const fetchApps = useCallback(async () => {
    const res = await fetch('/api/v1/apps', { credentials: 'include' })
    if (!res.ok) return
    const data = await res.json()
    setApps(data.items)
    // appId 없으면 첫 번째 앱 자동 선택
    if (!searchParams.get('appId') && data.items.length > 0) {
      setSearchParams({ appId: String(data.items[0].id) }, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // 선택된 앱의 빌드 로드
  const fetchBuilds = useCallback(async () => {
    if (!selectedAppId) { setBuilds([]); setLoading(false); return }
    setLoading(true)
    const params = new URLSearchParams({ app_id: String(selectedAppId), limit: '100', sort: 'uploaded_at', dir: 'desc' })
    if (search) params.set('q', search)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    try {
      const res = await fetch(`/api/v1/builds?${params}`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setBuilds(data.items)
      // 첫 로드 시 최신 버전 그룹 자동 오픈
      if (data.items.length > 0 && openReleases.size === 0) {
        const first = data.items[0].version_name ?? 'Unversioned'
        setOpenReleases(new Set([first]))
      }
    } finally {
      setLoading(false)
    }
  }, [selectedAppId, search, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchApps() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchBuilds() }, [fetchBuilds])

  function toggleRelease(versionName: string) {
    setOpenReleases(prev => {
      const next = new Set(prev)
      next.has(versionName) ? next.delete(versionName) : next.add(versionName)
      return next
    })
  }

  const releaseGroups = groupByRelease(builds)

  return (
    <div className="flex h-full gap-0">
      {/* ── App 목록 사이드바 ────────────────────────────────────── */}
      <aside className="w-52 shrink-0 border-r flex flex-col gap-1 p-3 overflow-y-auto">
        <span className="px-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Apps</span>
        {apps.length === 0 && (
          <span className="px-2 text-sm text-muted-foreground">No apps yet</span>
        )}
        {apps.map(app => (
          <button
            key={app.id}
            onClick={() => {
              if (app.id !== selectedAppId) {
                setBuilds([])
                setOpenReleases(new Set())
              }
              setSearchParams({ appId: String(app.id) })
            }}
            className={[
              'flex flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent',
              app.id === selectedAppId ? 'bg-accent font-medium' : '',
            ].join(' ')}
          >
            <span className="truncate">{app.name}</span>
            <span className="text-xs text-muted-foreground truncate">{app.bundle_id_key}</span>
          </button>
        ))}
      </aside>

      {/* ── 중앙 빌드 영역 ───────────────────────────────────────── */}
      <main className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto min-w-0">
        {/* 헤더 */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold">
            {selectedApp ? selectedApp.name : 'App Center'}
          </h1>
          <UploadBuildDialog onSuccess={() => { fetchApps(); fetchBuilds() }} />
        </div>

        {/* 필터 */}
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search version…"
            value={search}
            onChange={(e) => { setSearch(e.target.value) }}
            className="h-8 w-48"
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

        {/* 빌드 목록 */}
        {!selectedAppId ? (
          <p className="text-sm text-muted-foreground">좌측에서 앱을 선택하세요.</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : releaseGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No builds yet. Upload the first build.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {releaseGroups.map(({ versionName, builds: groupBuilds }) => {
              const isOpen = openReleases.has(versionName)
              return (
                <div key={versionName} className="rounded-lg border">
                  {/* Release 헤더 */}
                  <button
                    className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 rounded-lg"
                    onClick={() => toggleRelease(versionName)}
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="font-medium">{versionName}</span>
                    <span className="text-xs text-muted-foreground">({groupBuilds.length} build{groupBuilds.length > 1 ? 's' : ''})</span>
                  </button>

                  {/* Build 카드 목록 */}
                  {isOpen && (
                    <div className="border-t">
                      {groupBuilds.map((b, idx) => (
                        <div
                          key={b.id}
                          className={[
                            'flex items-center gap-3 px-4 py-3',
                            idx < groupBuilds.length - 1 ? 'border-b' : '',
                          ].join(' ')}
                        >
                          {/* 빌드 정보 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium">
                                build {b.build_number ?? '—'}
                              </span>
                              <Badge variant="outline" className="capitalize text-xs">{b.platform}</Badge>
                              {b.status_label && (
                                <Badge variant={STATUS_COLORS[b.status_label] as 'default' | 'secondary' | 'outline' | 'destructive'} className="text-xs">
                                  {b.status_label}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {b.uploader ?? '—'} · {new Date(b.uploaded_at).toLocaleDateString()}
                            </p>
                          </div>

                          {/* Status 변경 */}
                          <Select
                            value={b.status_label ?? 'none'}
                            onValueChange={async (val) => {
                              await updateStatus(b.id, val)
                              setBuilds(prev => prev.map(x =>
                                x.id === b.id
                                  ? { ...x, status_label: val === 'none' ? null : val as Build['status_label'] }
                                  : x
                              ))
                            }}
                          >
                            <SelectTrigger className="h-7 w-32 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none"><span className="text-muted-foreground">—</span></SelectItem>
                              <SelectItem value="Backlog">Backlog</SelectItem>
                              <SelectItem value="In Progress">In Progress</SelectItem>
                              <SelectItem value="Done">Done</SelectItem>
                              <SelectItem value="Rejected">Rejected</SelectItem>
                            </SelectContent>
                          </Select>

                          {/* Start QA CTA */}
                          <Button
                            size="sm"
                            onClick={() => navigate(`/app-center/build?id=${b.id}`)}
                          >
                            <Play className="mr-1.5 h-3.5 w-3.5" />
                            Start QA
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
