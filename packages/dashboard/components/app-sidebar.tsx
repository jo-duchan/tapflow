import { Link, useLocation } from 'react-router-dom'
import { LayoutGrid, Settings, Users, KeyRound } from 'lucide-react'
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
} from '@/components/ui/sidebar'
import { useAuth } from '@/hooks/useAuth'
import { UserAvatar } from '@/components/user-avatar'

const navItems = [
  { label: 'App Center', href: '/app-center', icon: LayoutGrid },
]

const settingsItems = [
  { label: 'Default', href: '/settings/default', icon: Settings },
  { label: 'Team', href: '/settings/team', icon: Users },
  { label: 'Tokens', href: '/settings/tokens', icon: KeyRound },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const { user } = useAuth()

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <span className="text-base font-semibold tracking-tight">tapflow</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname.startsWith(item.href)}>
                    <Link to={item.href}>
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
              {settingsItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname === item.href}>
                    <Link to={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {user && (
        <SidebarFooter className="px-3 py-3 border-t">
          <div className="flex items-center gap-2.5">
            <UserAvatar name={user.displayName ?? ''} avatarUrl={user.avatarUrl} size={28} />
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate">{user.displayName}</span>
              <span className="text-xs text-muted-foreground truncate">{user.email}</span>
            </div>
          </div>
        </SidebarFooter>
      )}
    </Sidebar>
  )
}
