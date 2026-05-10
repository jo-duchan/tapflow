'use client'

import { useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { RelayMessage, SessionInfo } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Props {
  onSelect: (sessionId: string, deviceId: string) => void
}

type BootingState = Record<string, 'booting' | 'error'>
type ShuttingState = Record<string, boolean>

export function SessionList({ onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [booting, setBooting] = useState<BootingState>({})
  const [shutting, setShutting] = useState<ShuttingState>({})

  const { send, connected } = useRelay((msg: RelayMessage) => {
    if (msg.type === 'agents:listed') {
      setSessions(msg.sessions)
    } else if (msg.type === 'device:ready') {
      const { deviceId } = msg.payload
      setBooting((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          devices: s.devices.map((d) => (d.id === deviceId ? { ...d, status: 'booted' } : d)),
        }))
      )
    } else if (msg.type === 'device:boot-error') {
      setBooting((prev) => {
        const next: BootingState = {}
        for (const k of Object.keys(prev)) next[k] = 'error'
        return next
      })
    } else if (msg.type === 'device:shutdown-done') {
      const { deviceId } = msg.payload
      setShutting((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          devices: s.devices.map((d) => (d.id === deviceId ? { ...d, status: 'shutdown' } : d)),
        }))
      )
    }
  })

  useEffect(() => {
    if (connected) send({ type: 'agents:list' })
  }, [connected, send])

  const handleBoot = (session: SessionInfo, deviceId: string) => {
    onSelect(session.sessionId, deviceId)
  }

  const handleShutdown = (session: SessionInfo, deviceId: string) => {
    setShutting((prev) => ({ ...prev, [deviceId]: true }))
    send({ type: 'session:start', sessionId: session.sessionId })
    send({ type: 'device:shutdown', sessionId: session.sessionId, payload: { deviceId } })
  }

  if (!connected) {
    return <p className="text-sm text-muted-foreground">Connecting to relay...</p>
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">No agents connected.</p>
        <p className="text-sm text-muted-foreground">
          Run:{' '}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            npm run dev:ios-agent
          </code>
        </p>
        <Button variant="outline" size="sm" onClick={() => send({ type: 'agents:list' })}>
          Refresh
        </Button>
      </div>
    )
  }

  return (
    <ul className="space-y-3">
      {sessions.flatMap((s) =>
        s.devices.map((d) => {
          const isBooting = booting[d.id] === 'booting'
          const isError = booting[d.id] === 'error'
          const isShutting = shutting[d.id] === true
          const isBusy = s.busy
          const isBooted = d.status === 'booted'

          return (
            <li key={`${s.sessionId}-${d.id}`}>
              <Card>
                <CardContent className="flex items-center gap-4 p-5">
                  <div className="flex-1">
                    <p className="font-semibold">
                      {s.agentName ? `${s.agentName} · ${d.name}` : d.name}
                    </p>
                    <p className="mt-0.5 text-xs capitalize text-muted-foreground">{d.platform}</p>
                  </div>

                  {isBusy && <Badge variant="destructive">사용 중</Badge>}
                  {isError && <Badge variant="destructive">오류</Badge>}
                  {isBooting && <Badge variant="secondary">Booting...</Badge>}
                  {isShutting && <Badge variant="secondary">Shutting down...</Badge>}
                  {!isBusy && !isBooting && !isError && !isShutting && (
                    <Badge variant={isBooted ? 'default' : 'secondary'}>{d.status}</Badge>
                  )}

                  {isBooted && !isBusy && !isShutting && (
                    <Button size="sm" onClick={() => onSelect(s.sessionId, d.id)}>
                      Connect
                    </Button>
                  )}
                  {isBooted && !isBusy && !isShutting && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleShutdown(s, d.id)}
                    >
                      Shutdown
                    </Button>
                  )}
                  {!isBooted && !isBooting && !isError && !isShutting && (
                    <Button size="sm" variant="outline" onClick={() => handleBoot(s, d.id)}>
                      Boot
                    </Button>
                  )}
                  {isError && (
                    <Button size="sm" variant="outline" onClick={() => handleBoot(s, d.id)}>
                      Retry
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          )
        })
      )}
    </ul>
  )
}
