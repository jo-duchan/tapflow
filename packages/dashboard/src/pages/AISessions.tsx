import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot } from 'lucide-react'
import { useRelay } from '@/hooks/useRelay'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, DeviceSummary, SessionInfo } from '@/lib/types'
import { holderKindLabel } from '@/lib/aiSession'

/**
 * **The devices an AI client is driving right now**, each with a link to watch it. Read off the same
 * `agents:listed` the QA session reads: a device carrying `holder` is one the relay will let a teammate
 * watch, and a relay that does not send the field cannot be asked to.
 */
export function AISessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [listed, setListed] = useState(false)
  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(<span className="text-sm font-medium">AI Sessions</span>)
    return () => setBreadcrumb(null)
  }, [setBreadcrumb])

  const handleMessage = useCallback((msg: BrowserInbound) => {
    if (msg.type === 'agents:listed') { setSessions(msg.sessions); setListed(true) }
  }, [])
  const { send, connected } = useRelay(handleMessage)
  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    const id = setInterval(() => send({ type: 'agents:list' }), 5000)
    return () => clearInterval(id)
  }, [connected, send])

  const driven = sessions.flatMap((s) => s.devices).filter((d): d is DeviceSummary & Required<Pick<DeviceSummary, 'holder'>> => d.holder !== undefined)

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">AI Sessions</h1>
        <p className="text-sm text-muted-foreground">
          Devices an AI agent is driving through the MCP server or the flow runner. Watching is read-only.
        </p>
      </div>
      {driven.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          <Bot className="h-8 w-8" aria-hidden="true" />
          <p className="text-sm">
            {!connected || !listed ? 'Connecting to relay…' : 'No AI agent is driving a device right now.'}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
          {driven.map((d) => (
            <li key={d.sessionId}>
              <Link
                to={`/automation/sessions/${encodeURIComponent(d.sessionId)}`}
                className="flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-sm font-medium leading-tight">
                  {d.name}
                  <span className="sr-only">, watch</span>
                </span>
                {d.osVersion && <span className="font-mono text-xs text-muted-foreground">{d.osVersion}</span>}
                <span className="text-xs text-muted-foreground">
                  {holderKindLabel(d.holder.kind)} · {d.holder.user}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
