'use client'

import { useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { RelayMessage, SessionInfo } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Props {
  onSelect: (sessionId: string) => void
}

export function SessionList({ onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const { send, connected } = useRelay((msg: RelayMessage) => {
    if (msg.type === 'agents:listed') setSessions(msg.sessions)
  })

  useEffect(() => {
    if (connected) send({ type: 'agents:list' })
  }, [connected, send])

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
        s.devices.map((d) => (
          <li key={`${s.sessionId}-${d.id}`}>
            <Card>
              <CardContent className="flex items-center gap-4 p-5">
                <div className="flex-1">
                  <p className="font-semibold">{d.name}</p>
                  <p className="mt-0.5 text-xs capitalize text-muted-foreground">{d.platform}</p>
                </div>
                <Badge variant={d.status === 'booted' ? 'default' : 'secondary'}>
                  {d.status}
                </Badge>
                <Button size="sm" onClick={() => onSelect(s.sessionId)}>
                  Connect
                </Button>
              </CardContent>
            </Card>
          </li>
        ))
      )}
    </ul>
  )
}
