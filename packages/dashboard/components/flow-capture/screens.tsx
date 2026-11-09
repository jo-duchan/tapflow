import { useEffect, useId, useRef, useState, type Dispatch, type RefObject } from 'react'
import { ChevronRight, Trash2 } from 'lucide-react'
import {
  capturedStepLabel, rangeWarnings, rawStepLabel, type Flow, type RawStep,
} from '@tapflowio/flow-runner/browser'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { FieldHint } from '@/components/ui/field-hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TechLabel } from '@/components/ui/tech-label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { copy } from '@/lib/flowCapture/copy'
import { fileNameOf, moveEdge, yamlOf, type Edge } from '@/lib/flowCapture/flow'
import type { CaptureEvent, CaptureState } from '@/lib/flowCapture/machine'
import type { CaptureTap } from '@/lib/flowCapture/tap'

type FlowFile = Omit<Flow, 'file'>

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">{children}</div>
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p className="font-medium text-warning-foreground">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  )
}

// ── Range ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function RangeScreen({ state, dispatch, bundleId, onContinue, onCancel, continueRef }: {
  state: CaptureState
  dispatch: Dispatch<CaptureEvent>
  bundleId: string | null
  onContinue: () => void
  onCancel: () => void
  continueRef: RefObject<HTMLButtonElement | null>
}) {
  const nameId = useId()
  const tagsId = useId()
  const tagsHintId = useId()
  const { steps, range } = state
  const warnings = rangeWarnings(steps, range)
  const count = range.end - range.start
  return (
    <div className="grid min-h-0 gap-4">
      <div>
        <h3 className="text-sm font-medium">{copy.rangeHeading}</h3>
        <p className="text-sm text-muted-foreground">{copy.rangeHelp}</p>
      </div>
      <div className="flex items-center justify-between text-xs">
        {/* Sized to the widest count this recording can show, so dragging a handle does not resize it. */}
        <span className="grid rounded-md bg-muted px-2 py-0.5 font-medium tabular-nums">
          <span className="invisible col-start-1 row-start-1" aria-hidden="true">{copy.rangeCount(steps.length, steps.length, steps.length)}</span>
          <span className="col-start-1 row-start-1">{copy.rangeCount(count, range.start + 1, range.end)}</span>
        </span>
        <span className="text-muted-foreground">
          {copy.trim}{' '}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={count <= 1}
            onClick={() => dispatch({ type: 'set-range', range: { start: range.start + 1, end: range.end } })}>{copy.dropFirst}</Button>
          {' · '}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={count <= 1}
            onClick={() => dispatch({ type: 'set-range', range: { start: range.start, end: range.end - 1 } })}>{copy.dropLast}</Button>
        </span>
      </div>
      <RangeStrip steps={steps} range={range} onChange={(next) => dispatch({ type: 'set-range', range: next })} />
      <div className="grid gap-4 sm:grid-cols-2">
        {/* `content-start`: the Tags column is a row taller with its hint, and a stretched grid shares that out. */}
        <div className="grid content-start gap-2">
          <Label htmlFor={nameId}>{copy.nameLabel}</Label>
          <Input id={nameId} value={state.name} onChange={(e) => dispatch({ type: 'set-name', name: e.target.value })} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={tagsId}>{copy.tagsLabel}</Label>
          <Input id={tagsId} aria-describedby={tagsHintId} value={state.tags} onChange={(e) => dispatch({ type: 'set-tags', tags: e.target.value })} />
          <FieldHint id={tagsHintId}>{copy.tagsHint}</FieldHint>
        </div>
      </div>
      {bundleId
        ? <p className="text-xs text-muted-foreground">{copy.appPrefix} <TechLabel>{bundleId}</TechLabel>{copy.appSuffix}</p>
        : <p className="text-xs">{copy.noBundleId}</p>}
      {warnings.map((w) => <p key={w} className="text-sm text-muted-foreground">{copy.rangeWarnings[w]}</p>)}
      <Notice title={copy.replayNoticeTitle}>{copy.replayNotice}</Notice>
      <Footer>
        <Button variant="outline" className="w-24" onClick={onCancel}>{copy.cancel}</Button>
        <Button ref={continueRef} className="w-24" disabled={count === 0} onClick={onContinue}>{copy.continue}</Button>
      </Footer>
    </div>
  )
}

// The strip is laid out by arithmetic rather than measured: every tile is the same size, so where a step sits, where
// the frame goes and which boundary a pointer is nearest all follow from the index and the range, with nothing to read
// back. Figma 373:89: 96 px tiles 8 px apart; the frame is an 18 px edge holding the handle, then an 8 px inner margin,
// so a step entering the range moves 26 px along — and is animated doing it.
const TILE = 96
const TILE_H = 217
const GAP = 8
const STRIDE = TILE + GAP
const PAD_X = 12
const EDGE = 18
const SHIFT = EDGE + 8
const FRAME_Y = 12
const INNER_Y = 10
const ROW_H = FRAME_Y + INNER_Y + TILE_H + INNER_Y + FRAME_Y
/** Shared by the tiles, the frame and the handles, so they move as one. Off under reduced motion. */
const SLIDE = 'duration-200 ease-out motion-reduce:transition-none'

type Range = { start: number; end: number }

const tileLeft = (i: number, r: Range) => PAD_X + i * STRIDE + (i >= r.start ? SHIFT : 0) + (i >= r.end ? SHIFT : 0)
const frameLeft = (r: Range) => PAD_X + r.start * STRIDE
const frameRight = (r: Range) => frameLeft(r) + (r.end - r.start) * STRIDE - GAP + 2 * SHIFT

/**
 * The range as a frame over the steps, with a handle at each end — a video editor's trim. A step taken in or left out
 * slides into or out of the frame. Each handle is a slider for the keyboard, one step per arrow.
 */
function RangeStrip({ steps, range, onChange }: {
  steps: RawStep[]
  range: Range
  onChange: (range: Range) => void
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const row = useRef<HTMLDivElement>(null)
  const dragging = useRef<Edge | null>(null)
  const placed = useRef(false)
  /** The handle whose step is named above it: hovered, focused or held. Controlled, because Radix closes a tooltip on
   *  the press that starts a drag, which is when the name is most wanted. */
  const [named, setNamed] = useState<Edge | null>(null)
  const total = steps.length

  // Opened on a range that starts further in, the strip starts there. Only once: after that the strip is where the
  // person put it. A ref callback, not an effect: an effect on opening alone would need its dependencies suppressed,
  // and that suppression is one of the two that cost the compiler the whole component.
  const attachScroller = (el: HTMLDivElement | null) => {
    scroller.current = el
    if (el && !placed.current) { placed.current = true; el.scrollLeft = Math.max(0, frameLeft(range) - PAD_X) }
  }

  /** Keeps a handle moved by the keyboard in view. Its place is known before it is drawn, so no measuring. */
  const reveal = (x: number) => {
    const el = scroller.current
    if (!el) return
    if (x < el.scrollLeft + EDGE) el.scrollLeft = x - EDGE
    else if (x > el.scrollLeft + el.clientWidth - EDGE) el.scrollLeft = x - el.clientWidth + EDGE
  }

  const change = (next: Range) => {
    if (next.start === range.start && next.end === range.end) return
    onChange(next)
    reveal(next.start !== range.start ? frameLeft(next) : frameRight(next))
  }

  /** The boundary nearest the pointer: how many steps, where they are drawn now, have their middle to its left. */
  const boundaryAt = (clientX: number) => {
    const x = clientX - (row.current?.getBoundingClientRect().left ?? 0)
    let k = 0
    while (k < total && tileLeft(k, range) + TILE / 2 < x) k++
    return k
  }

  const handle = (edge: Edge) => {
    const at = edge === 'start' ? range.start : range.end
    const shown = edge === 'start' ? range.start : range.end - 1
    const keys: Record<string, number> = {
      ArrowLeft: at - 1, ArrowDown: at - 1, ArrowRight: at + 1, ArrowUp: at + 1,
      Home: edge === 'start' ? 0 : range.start + 1, End: edge === 'start' ? range.end - 1 : total,
    }
    const name = copy.rangeHandleText(shown + 1, rawStepLabel(steps[shown]!))
    return (
      <Tooltip key={edge} open={named === edge} onOpenChange={(open) => { if (!open && dragging.current !== edge) setNamed(null) }}>
        <TooltipTrigger asChild>
          <div
            role="slider"
            tabIndex={0}
            aria-label={edge === 'start' ? copy.rangeStart : copy.rangeEnd}
            aria-orientation="horizontal"
            aria-valuemin={edge === 'start' ? 1 : range.start + 1}
            aria-valuemax={edge === 'start' ? range.end : total}
            aria-valuenow={shown + 1}
            aria-valuetext={name}
            className={cn('absolute flex cursor-ew-resize touch-none items-center justify-center rounded-xl transition-[left] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background', SLIDE)}
            style={{ left: edge === 'start' ? frameLeft(range) : frameRight(range) - EDGE, width: EDGE, top: FRAME_Y, bottom: FRAME_Y }}
            onKeyDown={(e) => {
              const next = keys[e.key]
              if (next === undefined) return
              e.preventDefault()
              change(moveEdge(range, edge, next, total))
            }}
            onFocus={() => setNamed(edge)}
            onBlur={() => { if (dragging.current !== edge) setNamed(null) }}
            onPointerEnter={() => setNamed(edge)}
            onPointerLeave={() => { if (dragging.current !== edge) setNamed(null) }}
            onPointerDown={(e) => {
              dragging.current = edge
              setNamed(edge)
              e.currentTarget.setPointerCapture?.(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (dragging.current !== edge) return
              // Held near either end of the strip, it scrolls on, so a range longer than the strip can still be reached.
              const el = scroller.current
              const box = el?.getBoundingClientRect()
              if (el && box) {
                if (e.clientX < box.left + 40) el.scrollLeft -= 20
                else if (e.clientX > box.right - 40) el.scrollLeft += 20
              }
              const next = moveEdge(range, edge, boundaryAt(e.clientX), total)
              if (next.start !== range.start || next.end !== range.end) onChange(next)
            }}
            onPointerUp={(e) => { dragging.current = null; if (e.currentTarget !== document.activeElement) setNamed(null) }}
            onPointerCancel={() => { dragging.current = null; setNamed(null) }}
          >
            <span aria-hidden className="h-6 w-0.5 rounded-full bg-background/70" />
          </div>
        </TooltipTrigger>
        {/* `always`: the handle slides with the range, and the name has to follow it rather than stay where it opened. */}
        <TooltipContent side="top" updatePositionStrategy="always">{name}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    // `overscroll-x-contain`: a swipe that reaches the end of the strip stops there, rather than going on to rubber-band
    // the page under the dialog, which showed the device through the overlay.
    <TooltipProvider delayDuration={300}>
      <div ref={attachScroller} className="overflow-x-auto overscroll-x-contain">
        <div ref={row} className="relative" style={{ width: frameRight({ start: 0, end: total }) + PAD_X, height: ROW_H }}>
          <div
            aria-hidden
            className={cn('absolute rounded-xl bg-foreground transition-[left,width]', SLIDE)}
            style={{ left: frameLeft(range), width: frameRight(range) - frameLeft(range), top: FRAME_Y, bottom: FRAME_Y }}
          >
            <div className="absolute rounded-md bg-muted" style={{ left: EDGE, right: EDGE, top: INNER_Y, bottom: INNER_Y }} />
          </div>
          <ol aria-label={copy.rangeStrip}>
            {steps.map((s, i) => (
              <RangeTile key={i} step={s} index={i} inRange={i >= range.start && i < range.end} left={tileLeft(i, range)} />
            ))}
          </ol>
          {handle('start')}
          {handle('end')}
        </div>
      </div>
    </TooltipProvider>
  )
}

/** A name cut short in the tile is shown whole on hover. The list item already holds it whole for a screen reader. */
function RangeTile({ step, index, inRange, left }: { step: RawStep; index: number; inRange: boolean; left: number }) {
  const label = rawStepLabel(step)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <li
          className={cn('absolute flex flex-col gap-1 p-2 text-xs transition-[left,opacity]', SLIDE, !inRange && 'opacity-50')}
          style={{ left, top: FRAME_Y + INNER_Y, width: TILE, height: TILE_H }}
        >
          <span className="h-4 leading-4 text-muted-foreground">#{index + 1}</span>{' '}
          {/* Where the recorded picture goes (1b-3b). */}
          <span aria-hidden className="h-[166px] w-full shrink-0 rounded-md border bg-background" />
          <span className="truncate font-mono text-[11px] leading-[11px]">{label}</span>
        </li>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono">{label}</TooltipContent>
    </Tooltip>
  )
}

// ── Match ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The device as the viewer draws it, copied each frame: one decoder, two pictures. */
function DeviceMirror({ tap, label }: { tap: CaptureTap; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const src = tap.surface()
      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (src && c && ctx) {
        const w = 'videoWidth' in src ? (src as HTMLVideoElement).videoWidth : (src as HTMLCanvasElement).width
        const h = 'videoHeight' in src ? (src as HTMLVideoElement).videoHeight : (src as HTMLCanvasElement).height
        if (w && h) {
          if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
          ctx.drawImage(src, 0, 0)
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [tap])
  return <canvas ref={canvas} role="img" aria-label={label} className="max-h-[60vh] w-auto max-w-full rounded-lg border bg-muted" />
}

export function MatchScreen({ state, tap, onStop, onRestart, onTakeWhatMatched, stopRef }: {
  state: CaptureState
  tap: CaptureTap
  onStop: () => void
  onRestart: () => void
  onTakeWhatMatched: () => void
  stopRef: RefObject<HTMLButtonElement | null>
}) {
  const { done, total } = state.progress
  const stopped = state.error !== null
  return (
    <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex justify-center"><DeviceMirror tap={tap} label={copy.steps[1]} /></div>
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm font-medium">{stopped ? state.error : copy.matching(Math.min(done + 1, total), total)}</p>
        <p className="text-sm text-muted-foreground">{copy.matchingHelp}</p>
        <div className="mt-auto flex flex-wrap justify-end gap-2 border-t pt-4">
          {stopped ? (
            <>
              {state.matched.length > 0 && <Button variant="outline" onClick={onTakeWhatMatched}>{copy.editWhatMatched}</Button>}
              <Button ref={stopRef} onClick={onRestart}>{copy.restart}</Button>
            </>
          ) : (
            <Button ref={stopRef} variant="outline" className="w-24" onClick={onStop}>{copy.stop}</Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Edit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function EditScreen({ state, dispatch, flow, renameError, onVerify, onBackToRange, verifyRef }: {
  state: CaptureState
  dispatch: Dispatch<CaptureEvent>
  flow: FlowFile | null
  renameError: (from: string, to: string) => string | null
  onVerify: () => void
  onBackToRange: () => void
  verifyRef: RefObject<HTMLButtonElement | null>
}) {
  const steps = state.captured?.steps ?? []
  const kept = steps.map((s, i) => ({ s, i })).filter(({ i }) => !state.removed.includes(i))
  const [selected, setSelected] = useState(kept[0]?.i ?? 0)
  const [showYaml, setShowYaml] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)
  const yaml = flow ? safeYaml(flow) : ''

  const remove = (i: number, position: number) => {
    dispatch({ type: 'remove-step', index: i })
    // Focus goes to the next row's remove button, or the previous one, never to the page.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-remove]')
      if (buttons?.length) buttons[Math.min(position, buttons.length - 1)]?.focus()
      else verifyRef.current?.focus()
    })
  }

  return (
    <div className="grid min-h-0 gap-4">
      <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-2">
          <h3 className="text-sm font-medium">{copy.editHeading(kept.length)}</h3>
          <ol ref={listRef} aria-label={copy.steps[2]} className="min-h-0 max-h-[50vh] space-y-1 overflow-y-auto pr-1">
            {kept.map(({ s, i }, position) => (
              <EditRow key={i} index={i} step={s} selected={selected === i}
                onSelect={() => setSelected(i)} onRemove={() => remove(i, position)}
                renamedTo={s.step?.type === 'inputSecret' ? state.renamed[s.step.name] : undefined}
                onRename={(from, to) => dispatch({ type: 'rename-secret', from, to })} renameError={renameError} />
            ))}
          </ol>
        </div>
        <div className="flex min-h-0 items-start justify-center">
          {state.screenshots[selected]
            ? <img src={state.screenshots[selected]} alt={capturedStepLabel(steps[selected]!)} className="max-h-[50vh] w-auto rounded-lg border" />
            : <div aria-hidden className="aspect-[9/19] h-[50vh] rounded-lg border bg-muted" />}
        </div>
      </div>
      {showYaml && <YamlField yaml={yaml} />}
      <Footer>
        <Button variant="ghost" className="sm:mr-auto" aria-expanded={showYaml} onClick={() => setShowYaml((v) => !v)}>
          {showYaml ? copy.hideYaml : copy.showYaml}
        </Button>
        <Button variant="outline" onClick={onBackToRange}>{copy.backToRange}</Button>
        {/* Not with only left-out rows kept: the flow would have no step, which no YAML can say. */}
        <Button ref={verifyRef} disabled={kept.every(({ s }) => s.step === null)} onClick={onVerify}>{copy.verifyAndExport}</Button>
      </Footer>
    </div>
  )
}

function safeYaml(flow: FlowFile): string {
  try { return yamlOf(flow) } catch (e) { return `# ${(e as Error).message}` }
}

function EditRow({ index, step, selected, onSelect, onRemove, renamedTo, onRename, renameError }: {
  index: number
  step: NonNullable<CaptureState['captured']>['steps'][number]
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  renamedTo: string | undefined
  onRename: (from: string, to: string) => void
  renameError: (from: string, to: string) => string | null
}) {
  const label = capturedStepLabel(step)
  const detailsId = useId()
  const [open, setOpen] = useState(false)
  const secretName = step.step?.type === 'inputSecret' ? step.step.name : null
  const reason = step.skipped ? copy.skipReasons[step.skipped] : step.fragile ? copy.fragileReasons[step.fragile] : step.auto ? copy.autoReason : null
  return (
    <li className={cn('rounded-md border p-2', selected ? 'border-primary' : 'border-border', step.step === null && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}
          className="min-w-0 flex-1 rounded-sm text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-muted-foreground">#{index + 1} </span>{label}
        </button>
        {step.fragile && <Badge variant="outline">{copy.fragile}</Badge>}
        {step.auto && <Badge variant="outline">{copy.auto}</Badge>}
        {step.skipped && <Badge variant="outline">{copy.skipped}</Badge>}
        {secretName && (
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={copy.stepDetails(label)} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
            <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
          </Button>
        )}
        <Button data-remove variant="ghost" size="icon" className="h-7 w-7" aria-label={copy.removeStep(label)} onClick={onRemove}>
          <Trash2 aria-hidden className="h-4 w-4" />
        </Button>
      </div>
      {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
      {secretName && open && (
        <div id={detailsId} className="mt-2">
          <SecretName from={secretName} current={renamedTo ?? secretName} onRename={onRename} renameError={renameError} />
        </div>
      )}
    </li>
  )
}

function SecretName({ from, current, onRename, renameError }: {
  from: string
  current: string
  onRename: (from: string, to: string) => void
  renameError: (from: string, to: string) => string | null
}) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const [value, setValue] = useState(current)
  const error = value === current ? null : renameError(current, value)
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{copy.secretLabel}</Label>
      <Input
        id={id} value={value} className="font-mono"
        aria-describedby={error ? `${hintId} ${errorId}` : hintId} aria-invalid={error ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (!error && value !== current) onRename(from, value) }}
      />
      <FieldHint id={hintId}>{copy.secretHint}</FieldHint>
      {error && <FieldError id={errorId} message={error} />}
    </div>
  )
}

function YamlField({ yaml }: { yaml: string }) {
  return <Textarea readOnly value={yaml} aria-label={copy.yamlLabel} className="h-48 resize-none font-mono text-xs" />
}

// ── Verify ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function VerifyScreen({ state, tap, onExport, onBack, primaryRef }: {
  state: CaptureState
  tap: CaptureTap
  onExport: () => void
  onBack: () => void
  primaryRef: RefObject<HTMLButtonElement | null>
}) {
  const verify = state.verify
  const result = verify?.result
  const failed = result?.status === 'failed' || state.error !== null
  return (
    <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex justify-center"><DeviceMirror tap={tap} label={copy.steps[3]} /></div>
      <div className="flex min-h-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{copy.verifyHeading}</h3>
        <p className="text-sm text-muted-foreground">{copy.verifyHelp}</p>
        <p role="status" className={cn('text-sm', failed && 'text-destructive')}>
          {state.error ?? (verify?.status === 'running' ? copy.verifying(verify.done + 1, result?.steps.length ?? verify.done + 1)
            : verify?.status === 'passed' ? copy.passed : result ? `${copy.failed} ${result.failureMessage ?? ''}` : '')}
        </p>
        {result && (
          <ol aria-label={copy.verifyHeading} className="min-h-0 space-y-1 overflow-y-auto text-sm">
            {result.steps.map((s) => (
              <li key={s.index} className={cn('flex gap-2', s.status === 'failed' && 'text-destructive', s.status === 'skipped' && 'text-muted-foreground')}>
                <span aria-hidden>{s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '–'}</span>
                <span>{s.name}</span>
                <span className="sr-only">, {s.status === 'passed' ? copy.stepPassed : s.status === 'failed' ? copy.stepFailed : copy.stepSkipped}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-auto flex flex-wrap justify-end gap-2 border-t pt-4">
          {(result || state.error) && <Button variant="outline" onClick={onBack}>{copy.backToEdit}</Button>}
          {result && (
            <Button ref={primaryRef} onClick={onExport}>{failed ? copy.exportAnyway : copy.continue}</Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A plain-HTTP page has no clipboard API. That is a copy that did not happen, not a failure. */
function copyToClipboard(text: string): Promise<boolean> {
  return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
    .then(() => true, () => false)
}

export function ExportScreen({ flow, bundleId, onDone, doneRef }: {
  flow: FlowFile
  bundleId: string | null
  onDone: () => void
  doneRef: RefObject<HTMLButtonElement | null>
}) {
  const fileId = useId()
  const yaml = safeYaml(flow)
  const fileName = fileNameOf(flow.name)
  const [copied, setCopied] = useState<boolean | null>(null)
  const secrets = [...new Set(flow.steps.flatMap((s) => (s.type === 'inputSecret' ? [s.name] : [])))]
  const download = () => {
    const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName.split('/').pop()!
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="grid min-h-0 gap-4">
      <div>
        <h3 className="text-sm font-medium">{copy.exportHeading}</h3>
        <p className="text-sm text-muted-foreground">{copy.exportHelp}</p>
      </div>
      <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-h-0 gap-2">
          <Label htmlFor={fileId}>{copy.fileLabel}</Label>
          <Input id={fileId} readOnly value={fileName} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
          <YamlField yaml={yaml} />
        </div>
        <div className="space-y-3 text-sm">
          <p>{copy.howToUse}</p>
          {secrets.length > 0 && <p className="text-muted-foreground">{copy.secretsToSet(secrets)}</p>}
          {bundleId && <p className="text-muted-foreground">{copy.appPinned(bundleId)}</p>}
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground">{copied === true ? copy.copied : copied === false ? copy.copyByHand : ''}</p>
      <Footer>
        <Button variant="outline" onClick={() => { void copyToClipboard(yaml).then(setCopied) }}>{copy.copyYaml}</Button>
        <Button variant="outline" onClick={download}>{copy.download}</Button>
        <Button ref={doneRef} className="w-24" onClick={onDone}>{copy.done}</Button>
      </Footer>
    </div>
  )
}

