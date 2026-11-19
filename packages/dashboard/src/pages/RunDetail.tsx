import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Eye, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TechLabel } from '@/components/ui/tech-label'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { getRun, queryKeys, runScreenshotUrl } from '@/lib/queries'
import {
  SKIP_REASON_LABEL, UNREPORTED_FLOW_LABEL, failureBadge, formatAgo, formatDuration, runBuildLabel,
  pollWhileRunning, runDuration, runOutcomeText, runSourceLabel, shortCommit,
} from '@/lib/runs'
import type { RunDetail as Run, RunDevice, RunFlow, RunStep, ServiceTier } from '@/lib/types'
import { RunVideo } from '@/components/runs/RunVideo'

/**
 * One run: what each flow did, why it failed, and — while it is running — a link to watch it. The watch link is
 * the session the runner holds **now**, from the relay; a stored one would open whoever took the device next.
 */
export function RunDetail() {
  const { runId = '' } = useParams()
  const runQuery = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) => getRun(runId, signal),
    refetchInterval: (query) => pollWhileRunning(query.state.data ? [query.state.data.status] : undefined),
  })
  const run = runQuery.data

  // The label, not the run: a run in progress is a new object on every poll, and the crumb would be torn down and
  // set again each time for the same words.
  const crumb = run ? runBuildLabel(run.build) : 'Run'
  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(
      <span className="flex items-center gap-1.5 text-sm">
        <Link to="/automation/runs" className="text-muted-foreground hover:text-foreground">Flow Runs</Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{crumb}</span>
      </span>,
    )
    return () => setBreadcrumb(null)
  }, [setBreadcrumb, crumb])

  return (
    <div className="flex flex-col gap-5 p-6">
      {run ? <RunBody run={run} />
        : run === null ? <p className="text-sm text-muted-foreground">This run is gone. A run is deleted with its build, or after 7 days when it has none.</p>
        : runQuery.isError ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load this run.
            <Button variant="outline" size="sm" className="ml-3" onClick={() => void runQuery.refetch()}>Try again</Button>
          </p>
        )
        : <p className="text-sm text-muted-foreground">Loading…</p>}
    </div>
  )
}

function RunBody({ run }: { run: Run }) {
  const outcome = runOutcomeText(run)
  const badge = failureBadge(run.status, run.failureKind)
  // A run on several devices says each one's reset and watch link in a list of its own, as a CI page lists its jobs;
  // one device keeps them in the header, where a run has always said them.
  const devices = run.deviceReset?.devices ?? []
  const several = devices.length > 1
  return (
    <>
      {/* Grouped by what each part answers: which run and how it ended, where it came from, why, what to do. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{runBuildLabel(run.build)}</h1>
            <Badge tone={badge.tone} className="text-xs">{badge.label}</Badge>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{runSourceLabel(run)}</span>
            {run.ci?.commit && <TechLabel>{shortCommit(run.ci.commit)}</TechLabel>}
            {/* A flow failing under slim for want of a service is not the app's regression: say what it ran on. */}
            {run.serviceTier && <span>Services <TechLabel>{serviceTierLabel(run.serviceTier)}</TechLabel></span>}
            {/* A run on a device that kept an earlier run's state is not the run it claims to be. */}
            {/* A run that never reached a device has nothing to say about it. */}
            {!several && run.deviceReset?.booted && <span>Device <TechLabel>{deviceResetLabel(run.deviceReset)}</TechLabel></span>}
            <span>Started {formatAgo(run.createdAt)}</span>
            <span>{run.finishedAt ? 'Took' : 'Running for'} <TechLabel>{runDuration(run)}</TechLabel></span>
            {run.exitCode !== null && <span>Exit code <TechLabel>{run.exitCode}</TechLabel></span>}
          </p>
        </div>
        {/* Announced: on a running run this is where the outcome appears when the poll brings it. */}
        <p role="status" className="text-sm">{outcome ?? (run.status === 'running' ? 'Running. This page follows the run.' : '')}</p>
        <div className="flex flex-wrap gap-2">
          {!several && run.watchSessionId && (
            <Button asChild size="sm">
              <Link to={`/automation/sessions/${encodeURIComponent(run.watchSessionId)}`}>
                <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />Watch the device
              </Link>
            </Button>
          )}
          {run.ci?.jobUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={run.ci.jobUrl} target="_blank" rel="noreferrer noopener">
                Open the CI run<ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
              </a>
            </Button>
          )}
          {run.build && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/automation/runs?source=all&build=${run.build.id}`}>Other runs of this build</Link>
            </Button>
          )}
        </div>
      </div>

      {several && <RunDevices run={run} devices={devices} />}

      <ol className="flex flex-col gap-3" aria-label="Flows">
        {run.flows.map((flow) => <FlowItem key={flow.idx} runId={run.id} flow={flow} />)}
      </ol>
    </>
  )
}

/** Each device of a parallel run: what was reset on it, the flow it is on now, and a link to watch it while it runs. */
function RunDevices({ run, devices }: { run: Run; devices: RunDevice[] }) {
  const watchable = new Set(run.watchSessionIds ?? [])
  return (
    <ul className="flex flex-col divide-y rounded-md border bg-card" aria-label="Devices">
      {devices.map((d, i) => {
        // Numbered when the runner named nothing, so two such devices are not two links read as the same "Watch Device".
        const name = d.deviceName ?? d.deviceId ?? `Device ${i + 1}`
        const on = run.flows.find((f) => f.status === 'running' && f.device?.sessionId === d.sessionId)
        return (
          <li key={d.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="font-medium">{name}</span>
            <TechLabel className="text-muted-foreground">
              {deviceResetLabel({ requested: run.deviceReset?.requested ?? false, cold: d.cold, report: d.report })}
            </TechLabel>
            {on && <span className="text-muted-foreground">Running {on.name}</span>}
            {watchable.has(d.sessionId) && (
              <Button asChild size="sm" variant="outline" className="ml-auto h-7">
                <Link to={`/automation/sessions/${encodeURIComponent(d.sessionId)}`} aria-label={`Watch ${name}`}>
                  <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />Watch
                </Link>
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

type ReportedFlow = Extract<RunFlow, { status: 'passed' | 'failed' }>

function isReported(flow: RunFlow): flow is ReportedFlow {
  return flow.status === 'passed' || flow.status === 'failed'
}

function FlowItem({ runId, flow }: { runId: string; flow: RunFlow }) {
  const badge = isReported(flow) ? failureBadge(flow.status, flow.failureKind) : null
  return (
    // Each kind of content is its own group — what the flow is, why it failed, its steps, its screen, its video — with
    // more room between groups than inside one, so the card reads as those parts.
    <li className="flex flex-col gap-6 rounded-md border bg-card p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{flow.name}</span>
          {flow.status === 'skipped' ? (
            <Badge tone="backlog" className="text-xs">{SKIP_REASON_LABEL[flow.skipReason] ?? 'Skipped'}</Badge>
          ) : isReported(flow) ? (
            <>
              <Badge tone={badge?.tone} className="text-xs">{badge?.label}</Badge>
              <TechLabel className="text-muted-foreground">{formatDuration(flow.durationMs)}</TechLabel>
              {flow.device?.name && <span className="text-xs text-muted-foreground">{flow.device.name}</span>}
            </>
          ) : (
            <Badge tone={flow.status === 'running' ? 'progress' : 'backlog'} className="text-xs">
              {flow.status === 'running' && flow.device?.name ? `Running on ${flow.device.name}` : UNREPORTED_FLOW_LABEL[flow.status]}
            </Badge>
          )}
        </div>
        {flow.file && <TechLabel className="block text-muted-foreground">{flow.file}</TechLabel>}
      </div>
      {flow.status === 'skipped' && flow.failureMessage && <p className="text-sm text-muted-foreground">{flow.failureMessage}</p>}
      {isReported(flow) && flow.status === 'failed' && (
        <>
          {flow.failureMessage && <p className="text-sm text-destructive">{flow.failureMessage}</p>}
          {flow.steps.length > 0 && (
            <ol className="flex flex-col gap-1 text-xs" aria-label={`Steps of ${flow.name}`}>
              {flow.steps.map((step) => (
                <li key={step.index} className="flex gap-2">
                  <span className={step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                    {step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–'}
                    <span className="sr-only"> {step.status}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    {step.name}
                    {step.message && <span className="block text-muted-foreground">{step.message}</span>}
                    {step.suggestions && step.suggestions.length > 0 && <StepSuggestions step={step} />}
                  </span>
                  <TechLabel className="text-muted-foreground">{formatDuration(step.durationMs)}</TechLabel>
                </li>
              ))}
            </ol>
          )}
          {flow.hasScreenshot && <LastScreen runId={runId} flow={flow} />}
        </>
      )}
      {isReported(flow) && <UncheckedTouches steps={flow.steps} />}
      {/* A passed flow's last screen is the evidence that it passed — what the login landed on. */}
      {isReported(flow) && flow.status === 'passed' && flow.hasScreenshot && <LastScreen runId={runId} flow={flow} />}
      {/* The whole flow, passed or failed: the screenshot shows where it ended, the video how it got there. */}
      {flow.video && (
        <RunVideo runId={runId} idx={flow.idx} flowName={flow.name} summary={flow.video} running={!flow.video.ended} />
      )}
    </li>
  )
}


/**
 * Touches the device could not judge (#1125), for a flow that passed as well as one that failed: such a step touched its
 * element's centre, which is how a covered row once passed as tapped, so a green flow says it has them.
 */
function UncheckedTouches({ steps }: { steps: RunStep[] }) {
  const unchecked = steps.filter((s) => s.reach === 'unchecked')
  if (unchecked.length === 0) return null
  const why = [...new Set(unchecked.map((s) => s.reachNote).filter((n): n is string => !!n))]
  return (
    <p className="text-sm text-muted-foreground">
      {unchecked.length === 1 ? `1 touch was` : `${unchecked.length} touches were`} not checked to land on {unchecked.length === 1 ? 'its element' : 'their elements'} and
      went to the centre, which something on screen may cover ({unchecked.map((s) => s.name).join(', ')}){why.length > 0 ? `: ${why.join('; ')}` : ''}.
    </p>
  )
}

/**
 * A failed `tapOn`'s lines to try instead (B2), from the screen it failed on. Fields rather than text, so a keyboard
 * user can select one where there is no clipboard (a plain-HTTP page).
 */
function StepSuggestions({ step }: { step: RunStep }) {
  return (
    <span className="mt-1.5 flex flex-col gap-1">
      <span className="text-muted-foreground">Try instead, from the screen it failed on:</span>
      {step.suggestions!.map((s, i) => <SuggestionLine key={s.yaml} yaml={s.yaml} n={i + 1} stepName={step.name} />)}
    </span>
  )
}

function SuggestionLine({ yaml, n, stepName }: { yaml: string; n: number; stepName: string }) {
  const field = useRef<HTMLInputElement>(null)
  return (
    <span className="flex items-center gap-2">
      <Input
        ref={field} readOnly value={yaml} aria-label={`Suggested line ${n} for ${stepName}`}
        onFocus={(e) => e.currentTarget.select()} className="h-7 min-w-0 font-mono"
      />
      <Button
        type="button" size="sm" variant="outline" className="h-7" aria-label={`Copy suggested line ${n}`}
        onClick={() => {
          // Absent on a plain-HTTP page; unchecked, the click throws before .catch is attached.
          void (navigator.clipboard ? navigator.clipboard.writeText(yaml) : Promise.reject(new Error('no clipboard')))
            .then(() => toast.success('Copied'))
            .catch(() => { toast.error('Could not copy — select the line and copy it by hand'); field.current?.focus() })
        }}
      >
        Copy
      </Button>
    </span>
  )
}

function LastScreen({ runId, flow }: { runId: string; flow: ReportedFlow }) {
  const url = runScreenshotUrl(runId, flow.idx)
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
      <img
        src={url}
        alt={flow.status === 'failed' ? `The screen when ${flow.name} failed` : `The screen ${flow.name} ended on`}
        loading="lazy"
        className={`${flow.status === 'failed' ? 'max-h-96' : 'max-h-64'} rounded-md border`}
      />
    </a>
  )
}

/** `reset`, `reset except location`, `reset failed: keychain`, `nothing reset`, `reset not confirmed` or `not reset`, then `, already running`
 *  for a device the run found up. */
function deviceResetLabel(reset: Pick<NonNullable<Run['deviceReset']>, 'requested' | 'cold' | 'report'>): string {
  const failed = reset.report?.failed ?? []
  const state = !reset.requested ? 'not reset'
    : !reset.report ? 'reset not confirmed'
    : reset.report.done.length === 0 ? (failed.length > 0 ? `reset failed: ${failed.join(', ')}` : 'nothing reset')
    : failed.length > 0 ? `reset except ${failed.join(', ')}` : 'reset'
  return reset.cold === false ? `${state}, already running` : state
}

/** `slim`, or `slim, keeping push, photos`. */
function serviceTierLabel(tier: ServiceTier): string {
  return tier.keep.length > 0 ? `${tier.name}, keeping ${tier.keep.join(', ')}` : tier.name
}
