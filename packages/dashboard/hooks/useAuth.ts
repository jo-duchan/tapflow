import { useQuery } from '@tanstack/react-query'
import { getMe, queryKeys } from '@/lib/queries'

export interface AuthUser {
  id: number
  email: string
  displayName: string | null
  avatarUrl: string | null
  role: string
  /** Flow Capture (#1125): the relay keeps this person's QA steps in memory. Absent from a relay that predates it. */
  flowCapture?: boolean
}

interface AuthState {
  user: AuthUser | null
  loading: boolean
}

/**
 * The signed-in user, read once for the layout, the sidebar and settings alike — each used to fetch
 * `/auth/me` on its own (#845).
 *
 * **No redirect here.** `DashboardLayout` renders `<Navigate to="/login">` when `user` is null, which
 * made the `navigate` this hook used to call a duplicate.
 *
 * **Loading until the first answer, and never again after it.** The layout renders nothing while
 * loading, and this query refetches on window focus. Keyed on `isSuccess`, one failed refetch — a
 * Wi-Fi blip, a relay restart — unmounted the whole dashboard, a streaming QA session with it. Keyed
 * on having an answer, a failed refetch keeps the last user; a first load that fails stays blank, as
 * it always did.
 */
export function useAuth(): AuthState {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: getMe })
  return { user: me.data ?? null, loading: me.data === undefined }
}
