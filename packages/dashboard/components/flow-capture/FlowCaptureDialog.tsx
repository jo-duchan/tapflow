import { useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isSecretName, toFlowSteps } from '@tapflowio/flow-runner/browser'
import type { CaptureSnapshot } from '@tapflowio/protocol/capture'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Stepper } from '@/components/ui/stepper'
import { getBuild, queryKeys } from '@/lib/queries'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import { DashboardSessionChannel } from '@/lib/flowCapture/channel'
import { copy } from '@/lib/flowCapture/copy'
import { editedCapture, flowOf } from '@/lib/flowCapture/flow'
import { canGoTo, initialState, reachedStep, reduce, stepIndex, type CaptureState } from '@/lib/flowCapture/machine'
import { DialogRun, dropSnapshot, loadSnapshot, matchRange, PauseLease, stepsOf, verifyFlow } from '@/lib/flowCapture/runner'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { EditScreen, ExportScreen, MatchScreen, RangeScreen, VerifyScreen } from './screens'

/**
 * Flow Capture's dialog (#1125): the steps a person took on this device, replayed and matched, edited, verified, and
 * handed back as a flow file. Opened by state from the toolbar's Capture flow button, which is also where focus goes
 * back. Its own chunk — it brings flow-runner's engine.
 */
/** Stop the run, give the relay back its recording, drop the copy of the steps, and free what the dialog made. Once. */
function endDialog(run: DialogRun, lease: PauseLease, channel: DashboardSessionChannel, tap: CaptureTap): void {
  if (!run.end()) return
  run.abort()
  void lease.stop()
  void dropSnapshot(tap)
  channel.close()
  run.release()
}

export default function FlowCaptureDialog({ tap, returnFocusRef, onClose }: {
  tap: CaptureTap
  returnFocusRef: MutableRefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const [openedAt] = useState(() => Date.now())
  const [channel] = useState(() => new DashboardSessionChannel(tap))
  const [lease] = useState(() => new PauseLease(tap))
  const [run] = useState(() => new DialogRun())
  const [busy, setBusy] = useState(false)

  const build = useQuery({ queryKey: queryKeys.build(tap.buildId), queryFn: () => getBuild(tap.buildId) })
  // Read when the dialog opens, which a person asked for by opening it; each opening takes a new copy.
  const snapshot = useQuery({
    queryKey: queryKeys.captureSnapshot(tap.sessionId, openedAt),
    queryFn: () => loadSnapshot(tap),
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false,
  })

  // Every way out runs the same cleanup: Escape, the ✕, Cancel, Done. Stopping a run first, then giving the relay
  // back its recording and dropping the copy, which holds what was typed.
  const close = () => {
    endDialog(run, lease, channel, tap)
    onClose()
  }
  // And when the dialog is taken away without closing: the session ended under it, and the viewer unmounted. Left, the
  // lease went on renewing the pause every 10 s from this tab, and a second tab of the same person on the same session
  // recorded nothing (review of #1125).
  useEffect(() => () => endDialog(run, lease, channel, tap), [run, lease, channel, tap])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent
        size="xl"
        className="max-h-[calc(100dvh-4rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden"
        // A click beside a running replay would end it by accident; Escape and Stop still do, on purpose.
        onInteractOutside={(e) => { if (busy) e.preventDefault() }}
        onCloseAutoFocus={(e) => { e.preventDefault(); returnFocusRef.current?.focus() }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="sr-only">{copy.matchingHelp}</DialogDescription>
        </DialogHeader>
        {snapshot.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p>
        ) : snapshot.isError ? (
          <p role="status" className="text-sm">{snapshot.error.message}</p>
        ) : snapshot.data === null ? (
          <p role="status" className="text-sm">{copy.nothingCaptured}</p>
        ) : (
          <CaptureSession
            tap={tap} channel={channel} lease={lease} snapshot={snapshot.data}
            bundleId={build.data?.bundle_id ?? null} run={run} setBusy={setBusy} close={close}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function initFrom(snapshot: CaptureSnapshot): CaptureState {
  const { steps, range } = stepsOf(snapshot)
  return reduce(initialState, { type: 'loaded', steps, range, name: '' })
}

function CaptureSession({ tap, channel, lease, snapshot, bundleId, run, setBusy, close }: {
  tap: CaptureTap
  channel: DashboardSessionChannel
  lease: PauseLease
  snapshot: CaptureSnapshot
  bundleId: string | null
  run: DialogRun
  setBusy: (busy: boolean) => void
  close: () => void
}) {
  const [state, dispatch] = useReducer(reduce, snapshot, initFrom)
  const fallback = useRef<HTMLButtonElement>(null)
  const swapFocus = useFocusAfterSwap<HTMLDivElement>(state.phase, fallback)

  const startMatch = () => {
    const signal = run.begin()
    dispatch({ type: 'match-started', total: state.range.end - state.range.start })
    setBusy(true)
    matchRange(tap, channel, lease, state.steps, state.range, bundleId, {
      signal,
      onStep: (step, screenshot) => {
        if (screenshot) run.keep(screenshot)
        dispatch({ type: 'step-matched', step, ...(screenshot ? { screenshot } : {}) })
      },
    })
      .then((matched) => dispatch({ type: 'match-finished', captured: toFlowSteps(matched) }))
      .catch((e: unknown) => dispatch({ type: 'match-failed', error: signal.aborted ? copy.matchStopped : (e as Error).message }))
      .finally(() => setBusy(false))
  }

  const takeWhatMatched = () => dispatch({ type: 'match-finished', captured: toFlowSteps(state.matched) })

  const flow = flowOf(state, bundleId)
  const startVerify = () => {
    const edited = editedCapture(state)
    if (!flow || !edited) return
    dispatch({ type: 'verify-started' })
    setBusy(true)
    verifyFlow(tap, channel, lease, flow, edited.secrets, (done) => dispatch({ type: 'verify-step', done }))
      .then((result) => dispatch({ type: 'verify-finished', result }))
      .catch((e: unknown) => dispatch({ type: 'match-failed', error: (e as Error).message }))
      .finally(() => setBusy(false))
  }

  // A rename is refused, with the reason, rather than written: a name that is not one, or one another secret has.
  const renameError = (from: string, to: string): string | null => {
    if (!isSecretName(to)) return copy.secretInvalid
    const names = new Set((editedCapture(state)?.steps ?? []).flatMap((s) => (s.step?.type === 'inputSecret' ? [s.step.name] : [])))
    return to !== from && names.has(to) ? copy.secretTaken : null
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <Stepper
        steps={copy.steps.map((title) => ({ title }))}
        current={stepIndex(state.phase)}
        label={copy.progressLabel}
        reached={reachedStep(state)}
        canGoTo={(i) => canGoTo(state, i)}
        onGoTo={(step) => dispatch({ type: 'go-to', step })}
        className="border-b pb-3"
      />
      <div {...swapFocus} className="min-h-0">
        {state.phase === 'range' && (
          <RangeScreen state={state} dispatch={dispatch} bundleId={bundleId} onContinue={startMatch} onCancel={close} continueRef={fallback} />
        )}
        {state.phase === 'matching' && (
          <MatchScreen
            state={state} tap={tap}
            onStop={() => run.abort()} onRestart={startMatch} onTakeWhatMatched={takeWhatMatched} stopRef={fallback}
          />
        )}
        {state.phase === 'edit' && (
          <EditScreen
            state={state} dispatch={dispatch} flow={flow} renameError={renameError}
            onVerify={startVerify} onBackToRange={() => dispatch({ type: 'go-to', step: 0 })} verifyRef={fallback}
          />
        )}
        {state.phase === 'verifying' && (
          <VerifyScreen state={state} tap={tap} onExport={() => dispatch({ type: 'to-export' })} onBack={() => dispatch({ type: 'go-to', step: 2 })} primaryRef={fallback} />
        )}
        {state.phase === 'export' && flow && <ExportScreen flow={flow} bundleId={bundleId} onDone={close} doneRef={fallback} />}
      </div>
    </div>
  )
}
