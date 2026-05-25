import { useCallback, useEffect, useRef, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { AgentDevice, RelayMessage, SessionInfo } from '@/lib/types'

export function useAgentSession(os: string) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState('')
  const [booting, setBooting] = useState(false)
  const [status, setStatus] = useState('')

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'agents:listed') setSessions(msg.sessions)
    if (msg.type === 'session:joined') { setBooting(false); setStatus('Connected') }
    if (msg.type === 'error') { setBooting(false); setStatus(`Error: ${msg.message}`) }
  }, [])

  const { send, connected } = useRelay(handleMessage)

  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    const id = setInterval(() => send({ type: 'agents:list' }), 5000)
    return () => clearInterval(id)
  }, [connected, send])

  // ref to avoid stale closure in shutdown callbacks
  const activeSessionRef = useRef({ sessionId: activeSessionId, deviceId })
  useEffect(() => {
    activeSessionRef.current = { sessionId: activeSessionId, deviceId }
  }, [activeSessionId, deviceId])

  // unmount cleanup — runs before useRelay's ws.close
  useEffect(() => {
    return () => {
      const { sessionId, deviceId: dId } = activeSessionRef.current
      if (sessionId && dId) {
        send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } })
      }
    }
  }, [send])

  const agentGroups = sessions.filter((s) => s.devices.some((d) => d.platform === os))

  const startDevice = useCallback((d: AgentDevice) => {
    setDeviceId(d.id)
    setBooting(true)
    setStatus('Booting…')
    setActiveSessionId(d.sessionId)
  }, [])

  const resetDevice = useCallback(() => setDeviceId(''), [])

  const handleBack = useCallback(() => {
    const { sessionId, deviceId: dId } = activeSessionRef.current
    if (sessionId && dId) {
      send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } })
    }
    setActiveSessionId(null)
    setBooting(false)
    setStatus('')
  }, [send])

  const handleBackToMacs = useCallback(() => {
    const { sessionId, deviceId: dId } = activeSessionRef.current
    if (sessionId && dId) {
      send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } })
    }
    setActiveSessionId(null)
    setSelectedAgent(null)
    setBooting(false)
    setStatus('')
  }, [send])

  return {
    sessions,
    selectedAgent,
    setSelectedAgent,
    activeSessionId,
    deviceId,
    booting,
    status,
    send,
    connected,
    agentGroups,
    startDevice,
    resetDevice,
    handleBack,
    handleBackToMacs,
  }
}
