import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { useWatchSession } from '@/hooks/useWatchSession'
import { WatchedDevice } from '@/components/device/WatchedDevice'
import { holderKindLabel, watchEndText, watchRefusalText } from '@/lib/aiSession'

/**
 * **Watch, read-only, the device an AI agent is driving.** Reached from the AI Sessions list, from the QA
 * session's device list, or from the link the MCP server and the flow runner hand out.
 */
export function AISessionWatch() {
  const { sessionId = '' } = useParams()
  const watch = useWatchSession(sessionId)
  const { phase, device } = watch
  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(
      <span className="flex items-center gap-1.5 text-sm">
        <Link to="/automation/sessions" className="text-muted-foreground hover:text-foreground">AI Sessions</Link>
        <span aria-hidden="true" className="text-muted-foreground">/</span>
        <span className="font-medium">{device?.name ?? 'Session'}</span>
      </span>,
    )
    return () => setBreadcrumb(null)
  }, [setBreadcrumb, device?.name])

  const over = phase.kind === 'ended' || phase.kind === 'refused'
  const status =
    phase.kind === 'refused' ? watchRefusalText(phase.reason)
      : phase.kind === 'ended' ? watchEndText(phase.reason)
      : !watch.connected ? 'Reconnecting to the relay…'
      : phase.kind === 'connecting' ? 'Connecting…'
      : watch.agentAway ? 'The Mac running this device went away. Waiting for it to come back.'
      : watch.holderLeft ? 'The agent disconnected. The device stays as it was until it comes back.'
      : !watch.deviceReady ? 'Waiting for the agent to start the device.'
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
            <Link to="/automation/sessions"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to AI Sessions</Link>
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
