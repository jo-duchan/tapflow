import type { ApiToken, App, Build, Comment, Recording, ReleaseGroup, ResourcePoint, TeamMember, WorkspaceSettings } from '@/lib/types'
import { api } from '@/lib/api'
import type { AuthUser } from '@/hooks/useAuth'

/**
 * Every query key the dashboard reads through TanStack Query, in one place so a mutation invalidates
 * the key a page actually reads rather than a spelling of it (#845). App Center's builds keep their
 * own composite key beside the page, which is the only reader.
 */
export const queryKeys = {
  authStatus: ['auth', 'status'] as const,
  me: ['auth', 'me'] as const,
  inviteToken: (token: string) => ['invitations', 'verify', token] as const,
  resetToken: (token: string) => ['auth', 'reset-password', token] as const,
  apps: ['apps'] as const,
  settings: ['settings'] as const,
  tokens: ['tokens'] as const,
  teamMembers: ['team', 'members'] as const,
  /** Every build's recordings — what an upload invalidates, since it may be for any build on screen. */
  comments: (buildId: number) => ['comments', buildId] as const,
  allRecordings: ['recordings'] as const,
  recordings: (buildId: number) => ['recordings', buildId] as const,
  agents: ['agents'] as const,
  resourceHistory: (agent: string, range: string) => ['agents', agent, 'resources', range] as const,
}

/**
 * Whether the relay has an admin yet, and whether this browser may create one (only the relay host can).
 * Throws when it cannot be asked — a failure is not "no".
 */
export interface AuthStatus { initialized: boolean; canInitialize?: boolean }
export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/v1/auth/status')
  if (!res.ok) throw new Error(`GET /api/v1/auth/status failed with ${res.status}`)
  return res.json() as Promise<AuthStatus>
}

/**
 * The signed-in user, or `null` when the relay says there is none. **Only a 401 says that.** A 500 or a
 * dropped connection is a failed question, not an answer: read as "nobody", one bad refetch on window
 * focus sent a signed-in person back to Login.
 */
export async function getMe(): Promise<AuthUser | null> {
  const { data, status } = await api.get<AuthUser>('/api/v1/auth/me')
  if (status === 401) return null
  if (!data) throw new Error(`GET /api/v1/auth/me failed with ${status}`)
  return data
}

/** The role an invitation grants. Throws for a token the relay refuses. */
export async function verifyInvitation(token: string): Promise<{ role: string }> {
  const res = await fetch(`/api/v1/invitations/verify?token=${token}`)
  if (!res.ok) throw new Error(`invitation refused with ${res.status}`)
  return res.json() as Promise<{ role: string }>
}

/**
 * A GET that throws on a failed status. Every list here used to take a 500's error body as its rows —
 * Tokens and Team then crashed on `.map` of an object — or, at best, showed a failure as "none yet".
 */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}`)
  return res.json() as Promise<T>
}

export const getSettings = () => getJson<WorkspaceSettings>('/api/v1/settings')
export const getTokens = () => getJson<ApiToken[]>('/api/v1/tokens')
export const getTeamMembers = () => getJson<TeamMember[]>('/api/v1/team/members')
export const getComments = (buildId: number) => getJson<Comment[]>(`/api/v1/comments?build_id=${buildId}`)
export const getRecordings = (buildId: number) => getJson<Recording[]>(`/api/v1/recordings?buildId=${buildId}`)
export const getKnownAgents = () => getJson<string[]>('/api/v1/agents')

/** One Mac's history over `range`. Takes Query's signal, so leaving the key or the tab abandons it. */
export async function getResourceHistory(agent: string, range: string, signal?: AbortSignal): Promise<ResourcePoint[]> {
  const res = await fetch(`/api/v1/agents/${encodeURIComponent(agent)}/resources?range=${range}`, { credentials: 'include', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<ResourcePoint[]>
}

/** Resolves when a password-reset token is still good. Throws for one the relay refuses. */
export async function verifyResetToken(token: string): Promise<true> {
  const res = await fetch(`/api/v1/auth/reset-password/verify?token=${token}`)
  if (!res.ok) throw new Error(`reset token refused with ${res.status}`)
  return true
}

export async function getApps(): Promise<App[]> {
  const res = await fetch('/api/v1/apps', { credentials: 'include' })
  // **An empty array is an answer, and a 500 is not one.** Returning `[]` here made every server
  // failure indistinguishable from an account with no apps — and since the App Center now has a
  // failure state, swallowing the status is what would keep it unreachable.
  if (!res.ok) throw new Error(`GET /api/v1/apps failed with ${res.status}`)
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
  if (!res.ok) throw new Error(`GET /api/v1/builds failed with ${res.status}`)
  const data = await res.json()
  return data.items
}

export async function createApp(data: {
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android' | 'both'
}): Promise<{ id: number } | { error: string } | null> {
  const res = await fetch('/api/v1/apps', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (res.status === 409) return { error: 'App with this bundle ID and platform already exists' }
  if (!res.ok) return null
  return res.json()
}

/**
 * The relay refused a build action (403). Usually the caller's role — "Viewers have read-only
 * access" — but the CSRF guard answers 403 too, so this does not claim to know which. It carries the
 * relay's own sentence; App Center shows it and re-reads the role, which is harmless when unchanged.
 */
export class ForbiddenError extends Error {}

async function throwIfRefused(res: Response): Promise<void> {
  if (res.status !== 403) return
  // `null` is valid JSON, so the body can parse and still have no fields.
  const body = await res.json().catch(() => null) as { error?: string } | null
  throw new ForbiddenError(body?.error ?? 'You do not have permission to do this')
}

export async function updateBuildStatus(
  id: number,
  status: string | null,
): Promise<void> {
  const res = await fetch(`/api/v1/builds/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_label: status }),
  })
  // Its two siblings below throw; this one did not, so the optimistic label stayed on screen after
  // a refused change and the rollback beside it was unreachable code.
  await throwIfRefused(res)
  if (!res.ok) throw new Error(`PATCH /api/v1/builds/${id} failed with ${res.status}`)
}

// Put a build on the deletion clock (server sets delete_after = now + TTL) and
// return the server's authoritative delete_after.
export async function scheduleBuildDeletion(id: number): Promise<string> {
  const res = await fetch(`/api/v1/builds/${id}/schedule-deletion`, { method: 'POST', credentials: 'include' })
  await throwIfRefused(res)
  if (!res.ok) throw new Error(`Failed to schedule deletion (${res.status})`)
  const data = await res.json()
  return data.delete_after as string
}

// Take a build back off the deletion clock.
export async function cancelBuildDeletion(id: number): Promise<void> {
  const res = await fetch(`/api/v1/builds/${id}/schedule-deletion`, { method: 'DELETE', credentials: 'include' })
  await throwIfRefused(res)
  if (!res.ok) throw new Error(`Failed to cancel scheduled deletion (${res.status})`)
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
