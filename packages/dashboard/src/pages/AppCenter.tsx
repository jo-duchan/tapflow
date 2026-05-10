import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UploadBuildDialog } from '@/components/upload-build-dialog'
import { ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'

type Build = {
  id: number
  name: string
  version_label: string | null
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  uploader: string | null
  uploaded_at: string
}

const STATUS_COLORS: Record<string, string> = {
  Backlog: 'secondary',
  'In Progress': 'default',
  Done: 'outline',
  Rejected: 'destructive',
}

const PAGE_SIZE = 20

type SortKey = 'uploaded_at' | 'version_label' | 'status_label'
type SortDir = 'asc' | 'desc'

async function updateStatus(id: number, status: string | null) {
  await fetch(`/api/v1/builds/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_label: status === 'none' ? null : status }),
  })
}

export function AppCenter() {
  const navigate = useNavigate()
  const [builds, setBuilds] = useState<Build[]>([])
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<string>('all')
  const [status, setStatus] = useState<string>('all')
  const [sortKey, setSortKey] = useState<SortKey>('uploaded_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchBuilds = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      sort: sortKey,
      dir: sortDir,
      ...(search && { q: search }),
      ...(platform !== 'all' && { platform }),
      ...(status !== 'all' && { status }),
    })
    try {
      const res = await fetch(`/api/v1/builds?${params}`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setBuilds(data.items)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [page, sortKey, sortDir, search, platform, status])

  useEffect(() => { fetchBuilds() }, [fetchBuilds])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">App Center</h1>
        <UploadBuildDialog onSuccess={fetchBuilds} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search name or version…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          className="h-8 w-56"
        />
        <Select value={platform} onValueChange={(v) => { setPlatform(v); setPage(0) }}>
          <SelectTrigger className="h-8 w-32"><SelectValue placeholder="Platform" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All platforms</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0) }}>
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

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>
                <Button variant="ghost" size="sm" className="-ml-2 h-7" onClick={() => toggleSort('version_label')}>
                  Version <ChevronsUpDown className="ml-1 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button variant="ghost" size="sm" className="-ml-2 h-7" onClick={() => toggleSort('status_label')}>
                  Status <ChevronsUpDown className="ml-1 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Uploaded by</TableHead>
              <TableHead>
                <Button variant="ghost" size="sm" className="-ml-2 h-7" onClick={() => toggleSort('uploaded_at')}>
                  Date <ChevronsUpDown className="ml-1 h-3 w-3" />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : builds.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No builds found.</TableCell>
              </TableRow>
            ) : builds.map((b) => (
              <TableRow
                key={b.id}
                className="cursor-pointer"
                onClick={() => navigate(`/app-center/build?id=${b.id}`)}
              >
                <TableCell className="font-medium">{b.name}</TableCell>
                <TableCell className="text-muted-foreground">{b.version_label ?? '—'}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={b.status_label ?? 'none'}
                    onValueChange={async (val) => {
                      await updateStatus(b.id, val)
                      setBuilds((prev) => prev.map((x) => x.id === b.id ? { ...x, status_label: val === 'none' ? null : val as Build['status_label'] } : x))
                    }}
                  >
                    <SelectTrigger className="h-7 w-32 text-xs" onClick={(e) => e.stopPropagation()}>
                      <SelectValue>
                        {b.status_label ? (
                          <Badge variant={STATUS_COLORS[b.status_label] as 'default' | 'secondary' | 'outline' | 'destructive'} className="text-xs">
                            {b.status_label}
                          </Badge>
                        ) : <span className="text-muted-foreground">—</span>}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none"><span className="text-muted-foreground">None</span></SelectItem>
                      <SelectItem value="Backlog">Backlog</SelectItem>
                      <SelectItem value="In Progress">In Progress</SelectItem>
                      <SelectItem value="Done">Done</SelectItem>
                      <SelectItem value="Rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{b.platform}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{b.uploader ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(b.uploaded_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
