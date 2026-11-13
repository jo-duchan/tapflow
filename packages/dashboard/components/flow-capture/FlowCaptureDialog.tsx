import { useEffect, useReducer, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isSecretName, toFlowSteps, type RawStep } from '@tapflowio/flow-runner/browser'
import type { CaptureSnapshot } from '@tapflowio/protocol/capture'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Stepper } from '@/components/ui/stepper'
import { getBuild, queryKeys } from '@/lib/queries'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import { DashboardSessionChannel } from '@/lib/flowCapture/channel'
import { copy } from '@/lib/flowCapture/copy'
import { editedCapture, exportedFlow, flowOf, secretRename } from '@/lib/flowCapture/flow'
import { canGoTo, initialState, reachedStep, reduce, stepIndex, withAsked, type CaptureState } from '@/lib/flowCapture/machine'
import { DialogRun, keyboardOf, loadSnapshot, matchRange, PauseLease, stepsOf, verifyFlow } from '@/lib/flowCapture/runner'
import { compareWithRecording } from '@/lib/flowCapture/screenCompare'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { addMark, type StepMark } from '@/lib/flowCapture/marks'
import { chromeOrientation } from '@tapflowio/protocol/screen'
import { NO_MARKS, type WatchMarks } from '@/lib/watchActions'
import { EditScreen, ExportScreen, MatchScreen, RangeScreen, VerifyScreen } from './screens'

/**
 * Flow Capture's dialog (#1125): the steps a person took on this device, replayed and matched, edited, verified, and
 * handed back as a flow file. Opened by state from the toolbar's Capture flow button, which is also where focus goes
 * back. Its own chunk — it brings flow-runner's engine.
 */
/** What the dialog opens on the viewer's socket and the relay: made by an effect and ended by its cleanup. */
interface DialogSession {
  channel: DashboardSessionChannel
  lease: PauseLease
  run: DialogRun
}

function openSession(tap: CaptureTap): DialogSession {
  return { channel: new DashboardSessionChannel(tap), lease: new PauseLease(tap), run: new DialogRun() }
}

/** Stop the run, give the relay back its recording if this session asked for the pause, and free what it made. */
function endSession({ channel, lease, run }: DialogSession): void {
  run.abort()
  void lease.stop()
  channel.close()
  run.release()
}

export default function FlowCaptureDialog({ tap, returnFocusRef, onClose }: {
  tap: CaptureTap
  returnFocusRef: MutableRefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const [openedAt] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)

  const build = useQuery({ queryKey: queryKeys.build(tap.buildId), queryFn: () => getBuild(tap.buildId) })
  // Read when the dialog opens, which a person asked for by opening it; each opening takes a new copy.
  const snapshot = useQuery({
    queryKey: queryKeys.captureSnapshot(tap.sessionId, openedAt),
    queryFn: () => loadSnapshot(tap),
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false,
  })

  // Made in the effect and ended in its cleanup, so they pair. Built during render instead, StrictMode's mount-time
  // cleanup ended a session the dialog went on using, and the channel subscribed to the viewer from render. Every way
  // out goes through the cleanup: Escape, the ✕, Cancel and Done close the dialog, and the viewer unmounts it, as it
  // does when the session ends under it (review of #1125: left, the lease renewed the pause from this tab). The copy
  // of the steps is the opening's, not this component's: the viewer drops it.
  const session = useRef<DialogSession | null>(null)
  useEffect(() => {
    const opened = openSession(tap)
    session.current = opened
    return () => {
      endSession(opened)
      if (session.current === opened) session.current = null
    }
  }, [tap])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        size="xl"
        // One height for every step, so moving between them does not resize the dialog; each step scrolls inside it and
        // keeps its buttons in view. Capped, so a tall screen does not make it a column. `--picture-max` is what is left
        // for a device picture once the title, the stepper and the buttons are drawn (16rem, measured at this size).
        className="h-[min(calc(100dvh-4rem),56rem)] max-h-[min(calc(100dvh-4rem),56rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden [--picture-max:calc(min(100dvh-4rem,56rem)-16rem)]"
        // A click beside a running replay would end it by accident; Escape and Stop still do, on purpose.
        onInteractOutside={(e) => { if (busy) e.preventDefault() }}
        onCloseAutoFocus={(e) => { e.preventDefault(); returnFocusRef.current?.focus() }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="sr-only">{copy.description}</DialogDescription>
        </DialogHeader>
        {snapshot.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p>
        ) : snapshot.isError ? (
          <p role="status" className="text-sm">{snapshot.error.message}</p>
        // No steps at all (a capture of the frame only, before any input) is nothing captured too: the strip had no step
        // to put its handles on.
        ) : snapshot.data === null || stepsOf(snapshot.data).steps.length === 0 ? (
          <p role="status" className="text-sm">{copy.nothingCaptured}</p>
        ) : (
          <CaptureSession
            tap={tap} session={session} snapshot={snapshot.data}
            bundleId={build.data?.bundle_id ?? null} setBusy={setBusy} close={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The picture of the screen `step` began on, read from the snapshot the dialog took (1b-3b); `null` when there is none. */
function thumbnailUrl(sessionId: string, snapshot: CaptureSnapshot, step: RawStep): string | null {
  const key = step.thumbnailKey
  if (!key || !snapshot.thumbnails?.includes(key)) return null
  return `/api/v1/sessions/${sessionId}/capture/snapshot/thumbnails/${encodeURIComponent(key)}`
}

function initFrom(snapshot: CaptureSnapshot): CaptureState {
  const { steps, range } = stepsOf(snapshot)
  return reduce(initialState, { type: 'loaded', steps, range, name: '' })
}

function CaptureSession({ tap, session, snapshot, bundleId, setBusy, close }: {
  tap: CaptureTap
  /** Read in handlers only: it is set by the dialog's effect, after the first render. */
  session: RefObject<DialogSession | null>
  snapshot: CaptureSnapshot
  bundleId: string | null
  setBusy: (busy: boolean) => void
  close: () => void
}) {
  const [state, dispatch] = useReducer(reduce, snapshot, initFrom)
  const fallback = useRef<HTMLButtonElement>(null)
  // A stop at a step that looked different is a view of its own: its buttons replace Stop, and the focus on Stop with them.
  const swapFocus = useFocusAfterSwap<HTMLDivElement>(state.phase === 'matching' && state.diverged ? 'diverged' : state.phase, fallback)
  // Where the replay is touching, drawn over the device on Match and Verify; each run starts with none.
  const [marks, setMarks] = useState<WatchMarks>(NO_MARKS)
  const markId = useRef(0)
  // Only upright: the flow's points are the app's, the mirror is the framebuffer, and a turned device puts one in the
  // other's wrong place (as `markOf` refuses for Match's recorded points).
  const onTouch = (mark: StepMark) => {
    const chrome = tap.chrome()
    const o = chrome ? chromeOrientation(chrome) : undefined
    if (o !== undefined && o !== 'portrait') return
    // The id is taken here, not in the updater, which React may run twice.
    const id = ++markId.current
    setMarks((m) => addMark(m, id, mark))
  }

  // The keyboard language the range was recorded in, which both replays start from (#1135).
  const keyboard = keyboardOf(snapshot, state.steps, state.range)

  const startMatch = () => {
    const opened = session.current
    if (!opened) return
    const { channel, lease, run } = opened
    const signal = run.begin()
    dispatch({ type: 'match-started', total: state.range.end - state.range.start })
    setMarks(NO_MARKS)
    setBusy(true)
    matchRange(tap, channel, lease, withAsked(state), state.range, bundleId, {
      signal,
      onTouch,
      onReset: (report) => dispatch({ type: 'device-reset', report }),
      onStep: (step, screenshot, inserted) => {
        if (screenshot) run.keep(screenshot)
        dispatch({ type: 'step-matched', step, ...(screenshot ? { screenshot } : {}), ...(inserted ? { inserted } : {}) })
      },
      compare: (step, masks) => {
        const recorded = thumbnailUrl(tap.sessionId, snapshot, step)
        return recorded ? compareWithRecording(recorded, tap.surface(), masks, signal) : Promise.resolve(null)
      },
      onAfter: (index, after) => {
        if (after.screenshot) run.keep(after.screenshot)
        dispatch({ type: 'step-after', index, after })
      },
      onDiverged: (index, divergence) => {
        run.keep(divergence.nowUrl)
        const step = state.steps[index]
        dispatch({ type: 'diverged', index, ...divergence, recordedUrl: step ? thumbnailUrl(tap.sessionId, snapshot, step) : null })
        return run.decide(signal)
      },
    }, keyboard)
      // A run a later one replaced answers into nothing: its failure would be shown on the new one, its end would end it.
      .then((matched) => { if (run.isCurrent(signal)) dispatch({ type: 'match-finished', captured: toFlowSteps(matched) }) })
      .catch((e: unknown) => { if (run.isCurrent(signal)) dispatch({ type: 'match-failed', error: signal.aborted ? copy.matchStopped : (e as Error).message }) })
      .finally(() => { if (run.isCurrent(signal)) setBusy(false) })
  }

  // Without the steps the replay added at the end (a tap on the field the next, unmatched step types into): on their own
  // they are a flow nobody made. Stops the run first when it is waiting at a step that looked different.
  const takeWhatMatched = () => {
    if (state.diverged) session.current?.run.abort()
    dispatch({ type: 'match-finished', captured: toFlowSteps(state.matched.slice(0, state.matched.length - state.insertedTail)) })
  }
  const continueAnyway = () => {
    dispatch({ type: 'went-on' })
    session.current?.run.goOn()
  }
  const backToRange = () => {
    session.current?.run.abort()
    dispatch({ type: 'back-to-range' })
  }

  const flow = flowOf(state, bundleId)
  const startVerify = () => {
    const edited = editedCapture(state)
    const opened = session.current
    if (!flow || !edited || !opened) return
    const { channel, lease } = opened
    dispatch({ type: 'verify-started' })
    setMarks(NO_MARKS)
    setBusy(true)
    verifyFlow(
      tap, channel, lease, flow, edited.secrets, (mark) => dispatch({ type: 'verify-step', mark, at: Date.now() }), keyboard, onTouch,
      (report) => dispatch({ type: 'device-reset', report }),
    )
      .then((result) => dispatch({ type: 'verify-finished', result }))
      .catch((e: unknown) => dispatch({ type: 'match-failed', error: (e as Error).message }))
      .finally(() => setBusy(false))
  }

  // A rename is refused, with the reason, rather than written: a name that is not one, or one another secret has with
  // another value. Another secret's name with the same value is taken, and makes the two one (1b-3c).
  const renameCheck = (current: string, to: string): { error?: string; note?: string } => {
    if (!isSecretName(to)) return { error: copy.secretInvalid }
    const edited = editedCapture(state)
    const verdict = edited ? secretRename(edited, current, to) : null
    return verdict === 'taken' ? { error: copy.secretTaken } : verdict === 'joins' ? { note: copy.secretJoins(to) } : {}
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
        fill
        className="border-b pb-3"
      />
      <div {...swapFocus} className="h-full min-h-0">
        {state.phase === 'range' && (
          <RangeScreen state={state} dispatch={dispatch} bundleId={bundleId} platform={tap.platform} onContinue={startMatch} onCancel={close} continueRef={fallback}
            thumbnailOf={(step) => thumbnailUrl(tap.sessionId, snapshot, step)} />
        )}
        {state.phase === 'matching' && (
          <MatchScreen
            state={state} tap={tap} marks={marks}
            onStop={() => session.current?.run.abort()} onRestart={startMatch} onTakeWhatMatched={takeWhatMatched}
            onBackToRange={backToRange} onContinueAnyway={continueAnyway} stopRef={fallback}
          />
        )}
        {state.phase === 'edit' && (
          <EditScreen
            state={state} dispatch={dispatch} flow={flow} renameCheck={renameCheck}
            onVerify={startVerify} onBackToRange={() => dispatch({ type: 'go-to', step: 0 })} verifyRef={fallback}
          />
        )}
        {state.phase === 'verifying' && (
          <VerifyScreen state={state} tap={tap} marks={marks} total={flow?.steps.length ?? 0} onExport={() => dispatch({ type: 'to-export' })} onBack={() => dispatch({ type: 'go-to', step: 2 })} primaryRef={fallback} />
        )}
        {state.phase === 'export' && flow && <ExportScreen flow={exportedFlow(state, bundleId) ?? flow} bundleId={bundleId} onDone={close} doneRef={fallback} />}
      </div>
    </div>
  )
}
