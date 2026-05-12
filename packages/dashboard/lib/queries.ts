import type { App, Build, ReleaseGroup } from '@/lib/types'

export async function getApps(): Promise<App[]> {
  const res = await fetch('/api/v1/apps', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json()
  return data.items
}

export async function getBuilds({
  appId,
  search,
  statusFilter,
}: {
  appId: number
  search?: string
  statusFilter?: string
}): Promise<Build[]> {
  const params = new URLSearchParams({
    app_id: String(appId),
    limit: '100',
    sort: 'uploaded_at',
    dir: 'desc',
  })
  if (search) params.set('q', search)
  if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter)
  const res = await fetch(`/api/v1/builds?${params}`, { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json()
  return data.items
}

export async function updateBuildStatus(
  id: number,
  status: string | null,
): Promise<void> {
  await fetch(`/api/v1/builds/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_label: status }),
  })
}

export async function getBuild(buildId: string | number): Promise<Build | null> {
  const res = await fetch(`/api/v1/builds/${buildId}`, { credentials: 'include' })
  return res.ok ? res.json() : null
}

export function groupByRelease(builds: Build[]): ReleaseGroup[] {
  const map = new Map<string, Build[]>()
  for (const b of builds) {
    const key = b.version_name ?? 'Unversioned'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(b)
  }
  return Array.from(map.entries()).map(([versionName, builds]) => ({ versionName, builds }))
}
