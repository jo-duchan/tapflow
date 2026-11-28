import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { useWatchSession } from '@/hooks/useWatchSession'
import { WatchedDevice } from '@/components/device/WatchedDevice'
import { AgentActivity } from '@/components/watch/AgentActivity'
import { Separator } from '@/components/ui/separator'
import { holderKindLabel, holderKindNoun, watchEndText, watchRefusalText } from '@/lib/aiSession'

/**
 * **Watch, read-only, the device an AI agent is driving.** Reached through a link, never a list of AI sessions:
 * the one the MCP server hands the person who asked it to test, and the one a running flow run offers on its Flow Runs
 * page, which the whole team may open.
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
  const refused = phase.kind === 'refused'
  // Never a bare "agent": in tapflow's words that is the process that runs the devices.
  const driver = device?.holder ? holderKindNoun(device.holder.kind) : 'AI client'
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
    // Laid out as the QA session is: the device on the left, a rule, the panel on the right — stacked on a narrow
    // screen, where the panel follows the device.
    <div className="flex min-h-0 flex-col gap-6 p-6 lg:h-full lg:flex-row">
      <div className="flex min-w-0 flex-col gap-5">
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
        {/* No back button once the watch ends or is refused (user, 2026-11-21). It went to App Center, which is not where a
            watch is opened from — an agent's link, or a running run on Flow Runs — so it took nobody back. The browser's
            back and the side menu do. */}
        {/* **Kept after the watch ends**: the last picture stays, without the live stall notice, and the activity
            beside it stays to be read. A refused watch never had either. */}
        {!refused && (
          <div role="region" aria-label="Device screen" className="flex justify-center px-8">
            <WatchedDevice
              chrome={watch.chrome}
              deviceReady={watch.deviceReady}
              platform={device?.platform ?? 'ios'}
              formFactor={device?.formFactor}
              binaryFrameHandlerRef={watch.binaryFrameHandlerRef}
              touch={watch.touch}
              replay={over}
            />
          </div>
        )}
      </div>
      {!refused && (
        <>
          <Separator orientation="vertical" className="hidden h-auto lg:block" />
          <AgentActivity actions={watch.actions} driver={driver} live={!over} />
        </>
      )}
    </div>
  )
}
