import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { useWatchSession } from '@/hooks/useWatchSession'
import { WatchedDevice } from '@/components/device/WatchedDevice'
import { holderKindLabel, watchEndText, watchRefusalText } from '@/lib/aiSession'

/**
 * **Watch, read-only, the device an AI agent is driving.** Reached only through the link the MCP server and the
 * flow runner hand out: watching an agent is for the person who asked it to test, so there is no list of AI
 * sessions to browse. Runs the team cares about — CI — are to get their own page with the flow run records
 * (ROADMAP, "Flow run records"); until then a CI run cannot be watched.
 */
export function AISessionWatch() {
  const { sessionId = '' } = useParams()
  // Keyed by session, so moving to another session's watch starts from nothing: the socket, the decoder and
  // a final "ended" are all one session's, and frames carry no session to filter by.
  return <WatchView key={sessionId} sessionId={sessionId} />
}

function WatchView({ sessionId }: { sessionId: string }) {
  const watch = useWatchSession(sessionId)
  const { phase, device } = watch
  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(
      <span className="text-sm font-medium">Watching {device?.name ?? 'a device'}</span>,
    )
    return () => setBreadcrumb(null)
  }, [setBreadcrumb, device?.name])

  const over = phase.kind === 'ended' || phase.kind === 'refused'
  // Never a bare "agent": in tapflow's words that is the process on the Mac, which the line above names.
  const driver = device?.holder ? holderKindLabel(device.holder.kind).toLowerCase() : 'AI client'
  const status =
    phase.kind === 'refused' ? watchRefusalText(phase.reason)
      : phase.kind === 'ended' ? watchEndText(phase.reason)
      : !watch.connected ? (phase.kind === 'connecting' ? 'Connecting to the relay…' : 'Reconnecting to the relay…')
      : phase.kind === 'connecting' ? 'Connecting…'
      : watch.agentAway ? 'The Mac running this device went away. Waiting for it to come back.'
      : watch.holderLeft ? `The ${driver} disconnected. The device stays as it was until it comes back.`
      : !watch.deviceReady ? `Waiting for the ${driver} to start the device.`
      : 'Watching. Nothing you do here reaches the device.'

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{device?.name ?? 'AI session'}</h1>
        {device?.holder && (
          <p className="text-sm text-muted-foreground">
            {holderKindLabel(device.holder.kind)} · {device.holder.user}
          </p>
        )}
      </div>
      {/* Mounted once with only the text changing: a live region inserted together with its first sentence is
          routinely not announced, and each of these states is one a viewer is waiting on. */}
      <p role="status" className="text-sm text-muted-foreground">{status}</p>
      {over ? (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link to="/app-center"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to App Center</Link>
          </Button>
        </div>
      ) : (
        <div role="region" aria-label="Device screen" className="flex items-start gap-8">
          <WatchedDevice
            chrome={watch.chrome}
            deviceReady={watch.deviceReady}
            platform={device?.platform ?? 'ios'}
            formFactor={device?.formFactor}
            binaryFrameHandlerRef={watch.binaryFrameHandlerRef}
          />
        </div>
      )}
    </div>
  )
}
