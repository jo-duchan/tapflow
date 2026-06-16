import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster, type ToasterProps } from 'sonner'
import { useTheme } from 'next-themes'
import { DashboardLayout } from './layouts/DashboardLayout'
import { Login } from './pages/Login'

// Route-level code splitting: Login (first paint for signed-out users) and the
// layout shell stay in the entry bundle; everything else loads on navigation.
// QASession is split too — the chunk loads before the viewer mounts, so it
// never touches the live stream frame path (the tinyh264 worker is its own chunk).
const Setup = lazy(() => import('./pages/Setup').then((m) => ({ default: m.Setup })))
const Invite = lazy(() => import('./pages/Invite').then((m) => ({ default: m.Invite })))
const ResetPassword = lazy(() => import('./pages/ResetPassword').then((m) => ({ default: m.ResetPassword })))
const AppCenter = lazy(() => import('./pages/AppCenter').then((m) => ({ default: m.AppCenter })))
const QASession = lazy(() => import('./pages/QASession').then((m) => ({ default: m.QASession })))
const MacResources = lazy(() => import('./pages/MacResources').then((m) => ({ default: m.MacResources })))
const DefaultSettings = lazy(() => import('./pages/settings/Default').then((m) => ({ default: m.DefaultSettings })))
const TeamSettings = lazy(() => import('./pages/settings/Team').then((m) => ({ default: m.TeamSettings })))
const TokenSettings = lazy(() => import('./pages/settings/Tokens').then((m) => ({ default: m.TokenSettings })))
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })))

export function App() {
  const { resolvedTheme } = useTheme()
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="flex h-screen w-full items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
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
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Toaster position="bottom-right" richColors theme={resolvedTheme as ToasterProps['theme']} />
    </BrowserRouter>
  )
}
