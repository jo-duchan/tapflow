import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { DeviceSummary, BrowserInbound, SessionInfo } from '@/lib/types'
import type { FormFactor } from '@tapflowio/protocol'

/**
 * `onListed` runs on every device listing, in the message handler: what a page decides from a listing (#1087's
 * resume) is a reaction to that message, and doing it in an effect over `sessions` would set state in an effect.
 */
export function useAgentSession(os: string, onListed?: (sessions: SessionInfo[]) => void) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  // Whether the active device was entered as a return to the tester's own session: its viewer then keeps the
  // installed app from the first install on (`DeviceViewer`'s `resume`).
  const [resumed, setResumed] = useState(false)
  const onListedRef = useRef(onListed)
  useLayoutEffect(() => { onListedRef.current = onListed })
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState('')
  // The last form factor known for the active device: from the pick, then from any listing that
  // names one. The list is rebuilt every few seconds and leaves out a device whose agent is
  // reconnecting, so reading it live would blank the value — and flip an iPad's volume tooltips back —
  // for as long as the agent is away. A listing without one never clears it.
  const [activeFormFactor, setActiveFormFactor] = useState<FormFactor | undefined>(undefined)
  const [booting, setBooting] = useState(false)
  const [status, setStatus] = useState('')

  // ref to avoid stale closure in shutdown callbacks
  const activeSessionRef = useRef({ sessionId: activeSessionId, deviceId })
  useEffect(() => {
    activeSessionRef.current = { sessionId: activeSessionId, deviceId }
  }, [activeSessionId, deviceId])

  const handleMessage = useCallback((msg: BrowserInbound) => {
    if (msg.type === 'agents:listed') {
      setSessions(msg.sessions)
      const { deviceId: active } = activeSessionRef.current
      const known = active ? msg.sessions.flatMap((s) => s.devices).find((d) => d.id === active)?.formFactor : undefined
      if (known) setActiveFormFactor(known)
      onListedRef.current?.(msg.sessions)
    }
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

  // These three `device:shutdown` sends carry **no `requestId`, on purpose.** Nothing in this hook reads
  // `device:shutdown-done` — the correlator would be minted for a reply no one is waiting for, and one of
  // the three fires from unmount teardown, where there is nothing left to resolve. That is safe
  // permanently rather than for now: the relay originates this message itself, so its correlator is
  // optional by contract and can never be gated at the door. A consumer that later wants to correlate a
  // shutdown adds the id at the sender it cares about. See 「Lifecycle correlation」 in protocol/AGENTS.md.
  //
  // Unmount teardown. **A layout effect, so it runs before `useRelay` closes the socket.** React runs passive
  // cleanups in declaration order and `useRelay`'s comes first, so as a `useEffect` this send found the socket
  // already CLOSING and was dropped: leaving the page left the device running until the relay's idle timeout.
  // Layout cleanups run during the commit, before any passive one. They also run when React hides the page
  // (Suspense, Activity), which would shut the device down under a page still shown; nothing hides it today.
  useLayoutEffect(() => {
    return () => {
      const { sessionId, deviceId: dId } = activeSessionRef.current
      if (sessionId && dId) {
        send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } })
      }
    }
  }, [send])

  const agentGroups = sessions.filter((s) => s.devices.some((d) => d.platform === os))

  const startDevice = useCallback((d: DeviceSummary, opts: { resume?: boolean } = {}) => {
    setResumed(opts.resume === true)
    setActiveFormFactor(d.formFactor)
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
    setResumed(false)
    setBooting(false)
    setStatus('')
  }, [send])

  const handleBackToMacs = useCallback(() => {
    const { sessionId, deviceId: dId } = activeSessionRef.current
    if (sessionId && dId) {
      send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } })
    }
    setActiveSessionId(null)
    setResumed(false)
    setSelectedAgent(null)
    setBooting(false)
    setStatus('')
    send({ type: 'agents:list' })
  }, [send])

  /**
   * The relay told us the session is gone (the agent went away). Same destination as
   * `handleBackToMacs` but deliberately **not** the same function: there is no session left, so a
   * `device:shutdown` would be addressed to a sessionId the relay has already dropped. The relay
   * discards it silently (that case has no `else` branch), so nothing breaks — it is simply a
   * message sent about something that no longer exists.
   *
   * The immediate `agents:list` matters here. The list otherwise refreshes on a 5s interval, and
   * this flow puts the user back on it and invites them to pick again straight away — with a stale
   * list that would mean joining a sessionId the relay has already dropped.
   */
  const handleSessionEnded = useCallback(() => {
    setActiveSessionId(null)
    setResumed(false)
    setSelectedAgent(null)
    setBooting(false)
    setStatus('')
    send({ type: 'agents:list' })
  }, [send])

  return {
    sessions,
    activeFormFactor,
    selectedAgent,
    setSelectedAgent,
    activeSessionId,
    resumed,
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
    handleSessionEnded,
  }
}
