import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRelay } from '@/hooks/useRelay'
import { announceEndedSessions, interruptedSessions } from '@/lib/resumeEntry'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import type { InterruptedSession } from '@/components/session-resume/SessionResumeNotices'

/**
 * The tester's own dropped sessions, for a page that is not the QA session (#1087): App Center, where a tester lands
 * after closing the tab. Polls the listing as the QA page does, and says who took a device that waited for them.
 */
export function useInterruptedSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const onMessage = useCallback((msg: BrowserInbound) => {
    if (msg.type !== 'agents:listed') return
    setSessions(msg.sessions)
    announceEndedSessions(msg.sessions, (by, deviceName) =>
      toast.info(`${by} is using ${deviceName} now.`, { description: 'Your session on it ended while you were away.' }))
  }, [])
  const { send, connected } = useRelay(onMessage)

  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    const id = setInterval(() => send({ type: 'agents:list' }), 5000)
    return () => clearInterval(id)
  }, [connected, send])

  const end = useCallback((s: InterruptedSession) => {
    send({ type: 'device:shutdown', sessionId: s.device.sessionId, payload: { deviceId: s.device.id } })
    send({ type: 'agents:list' })
  }, [send])

  return { interrupted: interruptedSessions(sessions), end }
}
