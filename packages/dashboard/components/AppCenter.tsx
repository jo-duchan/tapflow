'use client'

import { useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { RelayMessage, SessionInfo } from '@/lib/types'
import { MOCK_BUILDS, type MockBuild } from '@/lib/mock-builds'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Props {
  onSelect: (sessionId: string, deviceId: string) => void
}

type BootingState = Record<string, 'booting' | 'error'>

export function AppCenter({ onSelect }: Props) {
  const [selectedBuild, setSelectedBuild] = useState<MockBuild | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [booting, setBooting] = useState<BootingState>({})

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
    }
  })

  useEffect(() => {
    if (connected) send({ type: 'agents:list' })
  }, [connected, send])

  const handleBoot = (session: SessionInfo, deviceId: string) => {
    setBooting((prev) => ({ ...prev, [deviceId]: 'booting' }))
    send({ type: 'session:start', sessionId: session.sessionId })
    send({ type: 'device:boot', sessionId: session.sessionId, payload: { deviceId } })
  }

  const platformIcon = (platform: 'ios' | 'android') => (platform === 'ios' ? '󰀄' : '')

  if (selectedBuild) {
    const filtered = sessions.filter((s) =>
      s.devices.some((d) => d.platform === selectedBuild.platform)
    )

    return (
      <div>
        <div className="mb-6 flex items-center gap-3">
          <button
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedBuild(null)}
          >
            ← Back
          </button>
          <div>
            <p className="font-semibold">{selectedBuild.name}</p>
            <p className="text-xs text-muted-foreground">
              v{selectedBuild.version} · {selectedBuild.platform}
              {selectedBuild.label && ` · ${selectedBuild.label}`}
            </p>
          </div>
        </div>

        <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Select Device
        </h3>

        {!connected && (
          <p className="text-sm text-muted-foreground">Connecting to relay...</p>
        )}
        {connected && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No {selectedBuild.platform} agents connected.
          </p>
        )}

        <ul className="space-y-3">
          {filtered.flatMap((s) =>
            s.devices
              .filter((d) => d.platform === selectedBuild.platform)
              .map((d) => {
                const isBooting = booting[d.id] === 'booting'
                const isError = booting[d.id] === 'error'
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
                          <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                            {d.platform}
                          </p>
                        </div>

                        {isBusy && <Badge variant="destructive">사용 중</Badge>}
                        {isError && <Badge variant="destructive">오류</Badge>}
                        {isBooting && <Badge variant="secondary">Booting...</Badge>}
                        {!isBusy && !isBooting && !isError && (
                          <Badge variant={isBooted ? 'default' : 'secondary'}>{d.status}</Badge>
                        )}

                        {isBooted && !isBusy && (
                          <Button size="sm" onClick={() => onSelect(s.sessionId, d.id)}>
                            Connect
                          </Button>
                        )}
                        {!isBooted && !isBooting && !isError && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleBoot(s, d.id)}
                          >
                            Boot
                          </Button>
                        )}
                        {isError && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleBoot(s, d.id)}
                          >
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
      </div>
    )
  }

  return (
    <div>
      <p className="mb-6 text-sm text-muted-foreground">
        Select a build to choose a device and start a session.
      </p>
      <ul className="space-y-3">
        {MOCK_BUILDS.map((build) => (
          <li key={build.id}>
            <Card>
              <CardContent className="flex items-center gap-4 p-5">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{build.name}</p>
                    {build.label && (
                      <Badge variant="outline" className="text-xs">
                        {build.label}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    v{build.version} · {build.platform}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelectedBuild(build)}>
                  Select Device
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
