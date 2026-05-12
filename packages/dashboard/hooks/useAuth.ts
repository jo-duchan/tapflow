import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'

export interface AuthUser {
  id: number
  email: string
  displayName: string | null
  avatarUrl: string | null
  role: string
}

interface AuthState {
  user: AuthUser | null
  loading: boolean
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, loading: true })
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    api.get<AuthUser>('/api/v1/auth/me').then(({ data, status }) => {
      if (cancelled) return
      if (status === 401 || !data) {
        setState({ user: null, loading: false })
        navigate('/login', { replace: true })
      } else {
        setState({ user: data, loading: false })
      }
    })
    return () => { cancelled = true }
  }, [navigate])

  return state
}
