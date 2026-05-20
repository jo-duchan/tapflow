import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { useTheme } from 'next-themes'
import { DashboardLayout } from './layouts/DashboardLayout'
import { Login } from './pages/Login'
import { Invite } from './pages/Invite'
import { ResetPassword } from './pages/ResetPassword'
import { AppCenter } from './pages/AppCenter'
import { QASession } from './pages/QASession'
import { MacResources } from './pages/MacResources'
import { DefaultSettings } from './pages/settings/Default'
import { TeamSettings } from './pages/settings/Team'
import { TokenSettings } from './pages/settings/Tokens'

export function App() {
  const { resolvedTheme } = useTheme()
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route element={<DashboardLayout />}>
          <Route index element={<Navigate to="/app-center" replace />} />
          <Route path="/app-center" element={<AppCenter />} />
          <Route path="/app-center/build" element={<QASession />} />
          <Route path="/mac-resources" element={<MacResources />} />
          <Route path="/settings/default" element={<DefaultSettings />} />
          <Route path="/settings/team" element={<TeamSettings />} />
          <Route path="/settings/tokens" element={<TokenSettings />} />
          <Route path="*" element={<Navigate to="/app-center" replace />} />
        </Route>
      </Routes>
      <Toaster position="bottom-right" richColors theme={resolvedTheme as 'light' | 'dark'} />
    </BrowserRouter>
  )
}
