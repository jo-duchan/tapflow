import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'

export interface AuthUser {
  id: number
  email: string
  displayName: string | null
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
    api.get<AuthUser>('/api/v1/auth/me').then(({ data, status }) => {
      if (status === 401 || !data) {
        navigate('/login', { replace: true })
      } else {
        setState({ user: data, loading: false })
      }
    })
  }, [navigate])

  return state
}
