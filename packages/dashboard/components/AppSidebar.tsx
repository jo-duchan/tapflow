import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { LayoutGrid, LogOut, Settings, Users, KeyRound, Monitor, BookOpen, SquarePlay } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { maySeeSettingsPage } from '@/lib/settingsAccess'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSettings, hasAnyRun, queryKeys } from '@/lib/queries'
import { UserAvatar } from '@/components/UserAvatar'

const FLOW_RUNS_HREF = '/automation/runs'

const navItems = [
  { label: 'App Center', href: '/app-center', icon: LayoutGrid },
  { label: 'Flow Runs', href: FLOW_RUNS_HREF, icon: SquarePlay },
  { label: 'Mac Resources', href: '/mac-resources', icon: Monitor },
]

const settingsItems = [
  { label: 'Default', href: '/settings/default', icon: Settings },
  { label: 'Team', href: '/settings/team', icon: Users },
  { label: 'Tokens', href: '/settings/tokens', icon: KeyRound },
]

const referenceItems = [
  // Whoever opens the dashboard is usually a teammate, so the page written for them, not the site root.
  // No `#fragment`, so docsAnchors.test.mjs does not check it: renaming that page needs a moves.json redirect.
  { label: 'Docs', href: 'https://www.tapflow.dev/get-started/teammates', icon: BookOpen },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'
  // The same query Default settings reads, so a saved workspace shows here without a reload.
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: getSettings }).data
  const logoUrl = settings?.logo_url ?? null
  const teamName = settings?.team_name || 'tapflow'
  const queryClient = useQueryClient()
  // Below 768px the sidebar is a modal sheet, and a page changed behind it stays covered unless it closes. A
  // change of path closes it, which covers the phone's back gesture too; a link also closes it on click, since one
  // to the page already open changes no path. On a wider screen the sheet is already closed.
  const { setOpenMobile } = useSidebar()
  const closeSheet = () => setOpenMobile(false)
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])
  // Flow Runs is listed once a run exists. Runs come only from `tapflow flow run`, so until a team records one
  // the page is an empty list beside the manual path; it appears on the first run. Also listed while a run
  // page is open (reached from a printed link) and when the relay could not be asked, since a failure is not
  // "no runs". While the answer is pending it stays out, so it is added once rather than flickering away.
  const anyRun = useQuery({ queryKey: queryKeys.anyRun, queryFn: ({ signal }) => hasAnyRun(signal) })
  const showFlowRuns = anyRun.data === true || anyRun.isError || pathname.startsWith(FLOW_RUNS_HREF)
  const visibleNavItems = navItems.filter((item) => item.href !== FLOW_RUNS_HREF || showFlowRuns)

  async function handleLogout() {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' })
    // Everything cached belongs to the person leaving: left in place, the next one to sign in would
    // see it — their user, apps and tokens — until each refetch landed.
    queryClient.clear()
    navigate('/login', { replace: true })
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-2">
        <Link to="/app-center" onClick={closeSheet} className="flex items-center gap-2 p-1">
          <img src={logoUrl ?? defaultLogo} alt="tapflow" className="w-6 h-6 min-w-6 shrink-0" />
          <span className="text-base font-semibold tracking-tight truncate text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden">{teamName}</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleNavItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname.startsWith(item.href)} tooltip={item.label}>
                    <Link to={item.href} onClick={closeSheet}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {settingsItems.filter((item) => maySeeSettingsPage(item.href, user?.role)).map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname === item.href} tooltip={item.label}>
                    <Link to={item.href} onClick={closeSheet}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Reference</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {referenceItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild tooltip={item.label}>
                    <a href={item.href} target="_blank" rel="noopener noreferrer" onClick={closeSheet}>
                      <item.icon />
                      <span>{item.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {user && (
        <SidebarFooter className="px-3 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left hover:bg-sidebar-accent transition-colors group-data-[collapsible=icon]:justify-center">
                <UserAvatar name={user.displayName ?? ''} avatarUrl={user.avatarUrl} size={28} />
                <div className="flex flex-col min-w-0 flex-1 group-data-[collapsible=icon]:sr-only">
                  <span className="text-sm font-medium truncate">{user.displayName}</span>
                  <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuItem asChild>
                <Link to="/settings/default" onClick={closeSheet}>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  )
}
