import { useEffect, useId, useRef, useState, type Dispatch, type RefObject } from 'react'
import { ChevronRight, LoaderCircle, Trash2 } from 'lucide-react'
import {
  askedValues, capturedStepLabel, rangeWarnings, rawStepLabel, type CapturedStep, type Flow, type RawStep, type StepExpect,
} from '@tapflowio/flow-runner/browser'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { FieldHint } from '@/components/ui/field-hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TechLabel } from '@/components/ui/tech-label'
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { useHighlightedCode } from '@/hooks/useHighlightedCode'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { copy } from '@/lib/flowCapture/copy'
import { fileNameOf, moveEdge, yamlOf, type Edge } from '@/lib/flowCapture/flow'
import { askedReady, type CaptureEvent, type CaptureState } from '@/lib/flowCapture/machine'
import type { CaptureTap } from '@/lib/flowCapture/tap'
import { markOf } from '@/lib/flowCapture/marks'
import type { WatchMarks } from '@/lib/watchActions'
import { SwipeStroke, TapMarks } from '@/components/watch/TapMarks'
import { TraceStep } from '@/components/TraceStep'
import { typedOnScreenKeyboard } from '@/lib/flowCapture/runner'

type FlowFile = Omit<Flow, 'file'>

/** The step's buttons, at the bottom of the dialog on every step. As tall as a row of buttons (h-10, its pt-4 and border)
 *  even with none in it (a verification running), so the line above them does not jump when they appear. */
function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:min-h-[calc(2.5rem+1rem+1px)] sm:flex-row sm:items-center sm:justify-end">{children}</div>
}

/** What the device reset before this replay did (#1139), said once it has answered; nothing while it runs. */
function ResetReport({ reset }: { reset: CaptureState['reset'] }) {
  if (reset === undefined) return null
  if (reset === null) return <Notice title={copy.resetUnsupported} />
  const named = (items: string[]) => items.map((i) => copy.resetItems[i] ?? i).join(', ')
  return (
    <>
      {reset.done.length > 0 && <p className="text-sm text-muted-foreground">{copy.resetDone(named(reset.done))}</p>}
      {reset.failed.length > 0 && <Notice title={copy.resetFailed(named(reset.failed))} />}
    </>
  )
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p className="font-medium text-warning-foreground">{title}</p>
      {children && <p className="mt-1">{children}</p>}
    </div>
  )
}

// ── Range ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function RangeScreen({ state, dispatch, bundleId, platform, onContinue, onCancel, continueRef }: {
  state: CaptureState
  platform: string
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
      {/* Flex, not grid: a grid row holding something that scrolls on its own (the strip) shrinks to nothing when the
          step is taller than the dialog, and the strip then scrolls inside itself. Nothing in here shrinks; the body scrolls.
          The 4 px padding, given back by the margin, is room for a focused field's ring, which the scroll would clip. */}
      <div className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1 *:shrink-0">
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
      {/* Notes about the range, one short line each, in one list rather than a paragraph apiece. */}
      {(warnings.length > 0 || typedOnScreenKeyboard(steps, range)) && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {warnings.map((w) => <li key={w}>{copy.rangeWarnings[w]}</li>)}
          {typedOnScreenKeyboard(steps, range) && <li>{copy.screenKeyboardAdvice}</li>}
        </ul>
      )}
      {askedValues(steps, range).map((i) => <AskedPassword key={i} state={state} index={i} dispatch={dispatch} />)}
      <Notice title={copy.replayNoticeTitle}>{copy.replayNotice[platform === 'android' ? 'android' : 'ios']}</Notice>
      </div>
      <Footer>
        <Button variant="outline" className="w-24" onClick={onCancel}>{copy.cancel}</Button>
        <Button ref={continueRef} className="w-24" disabled={count === 0 || !askedReady(state)} onClick={onContinue}>{copy.continue}</Button>
      </Footer>
    </div>
  )
}

/**
 * A password typed on the soft keyboard (#1140): no read can say it, and Match has to type it, so the person does. Held
 * in the dialog only. Starts from what the computer's keyboard typed into the same field, if anything.
 */
function AskedPassword({ state, index, dispatch }: { state: CaptureState; index: number; dispatch: Dispatch<CaptureEvent> }) {
  const id = useId()
  const hintId = useId()
  const step = state.steps[index]
  const prefilled = step?.kind === 'text' ? step.text : ''
  const value = state.asked[index] ?? prefilled
  return (
    <div className="grid content-start gap-2">
      {/* Which field, beside the step: two passwords in one range differ by nothing else here. */}
      <Label htmlFor={id}>
        {copy.askedLabel(index + 1)}
        {step?.kind === 'text' && step.field && <> <TechLabel>{step.field}</TechLabel></>}
      </Label>
      {/* `new-password` and the managers' own opt-outs: `off` is ignored on a password input, and a manager would offer
          to save the app's test password under the dashboard, or fill in the dashboard's own. */}
      <Input id={id} type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" aria-describedby={hintId} value={value}
        onChange={(e) => dispatch({ type: 'set-asked', index, value: e.target.value })} />
      {/* Said apart from an empty one: dots alone do not say they came from the computer's keyboard. */}
      <FieldHint id={hintId}>{prefilled ? copy.askedPrefilledHint : copy.askedHint}</FieldHint>
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
function DeviceMirror({ tap, label, marks }: { tap: CaptureTap; label: string; marks: WatchMarks }) {
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
  // The replay's touches drawn over the device, as the MCP watch view draws an agent's: the canvas is the screen, so the
  // box the marks are placed in must be exactly its size — `self-start`, or the column stretches it below the picture.
  return (
    <div className="relative max-h-full self-start">
      <canvas ref={canvas} role="img" aria-label={label} className="block max-h-[var(--picture-max,60vh)] w-auto max-w-full rounded-lg border bg-muted" />
      <TapMarks marks={marks} place={(x, y) => ({ left: x, top: y })} />
    </div>
  )
}

/**
 * A count that changes as a run goes ("Step 3 of 15"), in the room its widest value takes, so the line does not move
 * as the numbers do — the Range count's way.
 */
function SteadyCount({ text, widest }: { text: string; widest: string }) {
  return (
    <span className="grid tabular-nums">
      <span className="invisible col-start-1 row-start-1" aria-hidden="true">{widest}</span>
      <span className="col-start-1 row-start-1">{text}</span>
    </span>
  )
}

/** Something is running on the device: said beside the line that says what. Still under reduced motion. */
function Busy() {
  return <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
}

export function MatchScreen({ state, tap, marks, onStop, onRestart, onTakeWhatMatched, stopRef }: {
  state: CaptureState
  tap: CaptureTap
  marks: WatchMarks
  onStop: () => void
  onRestart: () => void
  onTakeWhatMatched: () => void
  stopRef: RefObject<HTMLButtonElement | null>
}) {
  const { done, total } = state.progress
  const stopped = state.error !== null
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
      <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 justify-center"><DeviceMirror tap={tap} label={copy.steps[1]} marks={marks} /></div>
        <div className="flex min-h-0 flex-col gap-3">
          <p role="status" className="flex items-center gap-2 text-sm font-medium">
            {!stopped && <Busy />}
          {/* The reset before the first step takes seconds and is not a step: said as what it is (#1139). */}
          {stopped ? state.error : state.reset === undefined && done === 0 ? copy.resetting
            : <SteadyCount text={copy.matching(Math.min(done + 1, total), total)} widest={copy.matching(total, total)} />}
          </p>
          <p className="text-sm text-muted-foreground">{copy.matchingHelp}</p>
          <ResetReport reset={state.reset} />
        </div>
      </div>
      <Footer>
        {stopped && state.matched.length > 0 && <Button variant="outline" onClick={onTakeWhatMatched}>{copy.editWhatMatched}</Button>}
        {/* One button that turns from Stop into Start again and back, not two: swapping elements dropped the focus of the
            one pressed to the page (review of #1125). */}
        <Button ref={stopRef} variant={stopped ? 'default' : 'outline'} className={stopped ? undefined : 'w-24'} onClick={stopped ? onRestart : onStop}>
          {stopped ? copy.restart : copy.stop}
        </Button>
      </Footer>
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
      <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* The device on the left, as on Match and Verify, so it does not jump sides between steps. The YAML takes the
            picture's place rather than pushing the buttons down: one or the other is looked at. */}
        <div className={cn('flex min-h-0 justify-center', showYaml ? 'items-stretch' : 'items-start')}>
          {showYaml
            ? <YamlField yaml={yaml} fill />
            : state.screenshots[selected]
              ? <StepPicture src={state.screenshots[selected]!} step={steps[selected]!} />
              : <div aria-hidden className="aspect-[9/19] h-full max-h-[var(--picture-max,60vh)] rounded-lg border bg-muted" />}
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <h3 className="text-sm font-medium">{copy.editHeading(kept.length)}</h3>
          <ol ref={listRef} aria-label={copy.steps[2]} className="-m-1 min-h-0 flex-1 space-y-1 overflow-y-auto p-1">
            {kept.map(({ s, i }, position) => (
              <EditRow key={i} index={i} step={s} selected={selected === i}
                onSelect={() => setSelected(i)} onRemove={() => remove(i, position)}
                renamedTo={s.step?.type === 'inputSecret' ? state.renamed[s.step.name] : undefined}
                onRename={(from, to) => dispatch({ type: 'rename-secret', from, to })} renameError={renameError} />
            ))}
          </ol>
        </div>
      </div>
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
    // Figma 394:1041 (List Item): 12 px in on the left, 8 px elsewhere; the head row centred on the 28 px buttons; the
    // reason 8 px under it with 4 px below.
    // The label's button stretches over the whole card (its `after:` box), so the card is one target with no click
    // handler of its own; the buttons and the field on it sit a layer above (`relative z-10`) and keep their own clicks.
    // Keyboard and screen reader still meet the one button that selects. `data-stretched` keeps it out of the press
    // nudge in index.css: a transform on it would shrink the `after:` box to the label mid-click.
    <li className={cn('relative rounded-md border py-2 pl-3 pr-2 hover:bg-accent/40', selected ? 'border-primary' : 'border-border', step.step === null && 'opacity-60')}>
      <div className="flex items-center gap-2">
        {/* One line, as drawn; the whole label is the tooltip when it does not fit. */}
        <button type="button" data-stretched onClick={onSelect} aria-current={selected ? 'true' : undefined} title={label}
          className="min-w-0 flex-1 truncate text-left text-sm leading-5 after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
          <span className="text-muted-foreground">#{index + 1} </span>{label}
        </button>
        {step.fragile && <Badge variant="outline" className="shrink-0">{copy.fragile}</Badge>}
        {step.auto && <Badge variant="outline" className="shrink-0">{copy.auto}</Badge>}
        {step.skipped && <Badge variant="outline" className="shrink-0">{copy.skipped}</Badge>}
        {secretName && (
          <Button variant="ghost" size="icon" className="relative z-10 size-7 shrink-0" aria-label={copy.stepDetails(label)} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
            <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
          </Button>
        )}
        <Button data-remove variant="ghost" size="icon" className="relative z-10 size-7 shrink-0" aria-label={copy.removeStep(label)} onClick={onRemove}>
          <Trash2 aria-hidden className="h-4 w-4" />
        </Button>
      </div>
      {reason && <p className="pb-1 pt-2 text-xs text-muted-foreground">{reason}</p>}
      {secretName && open && (
        <div id={detailsId} className="relative z-10 mt-2">
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

/**
 * A step's replay picture, with where the person touched drawn on it, as the MCP watch view draws an agent's: a tap is
 * a ring, a swipe the same stroke (`SwipeStroke`).
 */
function StepPicture({ src, step }: { src: string; step: CapturedStep }) {
  const mark = markOf(step.raw)
  const pct = (n: number) => `${n * 100}%`
  return (
    <div className="relative max-h-full self-start">
      <img src={src} alt={capturedStepLabel(step)} className="block max-h-[var(--picture-max,60vh)] w-auto max-w-full rounded-lg border" />
      {mark && (
        <svg aria-hidden="true" data-testid="step-mark" className="pointer-events-none absolute inset-0 size-full overflow-visible">
          {mark.kind === 'swipe' ? (
            <SwipeStroke from={{ left: mark.from[0], top: mark.from[1] }} to={{ left: mark.to[0], top: mark.to[1] }} />
          ) : (
            <circle cx={pct(mark.x)} cy={pct(mark.y)} r={11} fill={MARK_BLUE} fillOpacity={0.3} stroke={MARK_BLUE} strokeWidth={2} />
          )}
        </svg>
      )}
    </div>
  )
}

/** The blue the MCP watch view's marks are drawn in (`TapMarks`). */
const MARK_BLUE = 'rgb(59 130 246)'

/** The flow's YAML, highlighted, with line numbers and a copy button: the shared CodeBlock, as Flow Runs and MCP's
 *  capture page will show a flow. */
function YamlField({ yaml, fill = false, contentRef }: { yaml: string; fill?: boolean; contentRef?: RefObject<HTMLPreElement | null> }) {
  const lines = useHighlightedCode(yaml, 'yaml')
  const ownRef = useRef<HTMLPreElement>(null)
  const ref = contentRef ?? ownRef
  // With no clipboard (plain HTTP, the usual self-hosted case) the copy icon selects the YAML instead of doing nothing.
  const copyOrSelect = (text: string) => copyToClipboard(text).then((ok) => { if (!ok) selectYaml(ref.current); return ok })
  return (
    <CodeBlock size="sm" className={fill ? 'h-full' : 'max-h-72'}>
      <CodeBlockHeader>
        <CodeBlockTitle>{copy.yamlLabel}</CodeBlockTitle>
        <CodeBlockActions><CodeBlockCopyButton value={yaml} copy={copyOrSelect} /></CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent ref={ref} aria-label={copy.yamlLabel} lineNumbers>
        {lines.map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
  )
}

// ── Verify ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function VerifyScreen({ state, tap, marks, total, onExport, onBack, primaryRef }: {
  state: CaptureState
  tap: CaptureTap
  marks: WatchMarks
  /** The flow's steps, which the run counts through; known before its result is. */
  total: number
  onExport: () => void
  onBack: () => void
  primaryRef: RefObject<HTMLButtonElement | null>
}) {
  const verify = state.verify
  const result = verify?.result
  const failed = result?.status === 'failed' || state.error !== null
  const stuck = state.error !== null && !result
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
    <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-h-0 justify-center"><DeviceMirror tap={tap} label={copy.steps[3]} marks={marks} /></div>
      <div className="flex min-h-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{copy.verifyHeading}</h3>
        <p className="text-sm text-muted-foreground">{copy.verifyHelp}</p>
        <ResetReport reset={state.reset} />
        <p role="status" className={cn('flex items-center gap-2 text-sm', failed && 'text-destructive')}>
          {verify?.status === 'running' && !state.error && <Busy />}
          {state.error ?? (verify?.status === 'running' && state.reset === undefined && verify.done === 0 ? copy.resetting
            : verify?.status === 'running'
            ? <SteadyCount text={copy.verifying(Math.min(verify.done + 1, total), total)} widest={copy.verifying(total, total)} />
            : verify?.status === 'passed' ? copy.passed : result ? `${copy.failed} ${result.failureMessage ?? ''}` : '')}
        </p>
        <VerifyTrace verify={verify} />
      </div>
    </div>
      {/* The same footer as every step, at the bottom of the dialog: buttons that move between steps do not move. */}
      <Footer>
        {result && <Button variant="outline" onClick={onBack}>{copy.backToEdit}</Button>}
        {/* There while it runs, busy (`aria-disabled`, not `disabled`, which drops focus): with nothing to hold, focus
            fell to the page when Verify began and stayed there after it finished (review of #1125). A run that threw
            has no result to export, so the same button, still holding focus, goes back to Edit instead of staying
            unavailable for good. */}
        <Button
          ref={primaryRef} aria-disabled={(!result && !stuck) || undefined}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => { if (result) onExport(); else if (stuck) onBack() }}
        >
          {stuck ? copy.backToEdit : failed ? copy.exportAnyway : copy.continue}
        </Button>
      </Footer>
    </div>
  )
}

/**
 * The verification as a trace, as MCP's Agent activity shows a run (`TraceStep`): each step as it starts and ends while
 * the run goes, then every step of the result, the one that failed open onto why and on what to select instead.
 */
function VerifyTrace({ verify }: { verify: CaptureState['verify'] }) {
  const [toggled, setToggled] = useState<Record<number, boolean>>({})
  const id = useId()
  if (!verify) return null
  const rows: Array<{
    index: number; name: string; status: 'running' | 'passed' | 'failed' | 'skipped'; durationMs?: number; message?: string
    reach?: string; reachNote?: string; suggestions?: { yaml: string }[]; observed?: StepExpect | null
  }> =
    verify.result ? verify.result.steps : verify.live
  if (rows.length === 0) return null
  return (
    <ol aria-label={copy.verifyHeading} className="-m-1 flex min-h-0 flex-col gap-2 overflow-y-auto p-1 text-sm">
      {rows.map((s) => {
        // A touch the device could not judge opens too, on a passed step: a covered element passes that way (#1125). So
        // does one that changed nothing: an overlay the tree does not show takes the touch and the step still passes.
        const unchecked = s.reach === 'unchecked'
        const unchanged = s.status === 'passed' && s.observed === null
        const opens = Boolean((s.status === 'failed' && (s.message || s.suggestions?.length)) || unchecked || unchanged)
        const effect = s.observed ? effectLine(s.observed) : null
        const why = opens || effect !== null
        const open = toggled[s.index] ?? opens
        return (
          <li key={s.index}>
            <TraceStep
              state={s.status === 'passed' ? 'done' : s.status}
              label={<>{s.name}<span className="sr-only">, {copy.stepStatus[s.status]}</span></>}
              {...(s.durationMs !== undefined && s.status !== 'running' ? { meta: seconds(s.durationMs) } : {})}
              {...(why ? { open, onToggle: () => setToggled((t) => ({ ...t, [s.index]: !open })), contentId: `${id}-${s.index}` } : {})}
            >
              {why && (
                <div className="flex flex-col gap-1.5 text-foreground">
                  {s.status === 'failed' && s.message && <p>{s.message}</p>}
                  {unchecked && <p className="text-muted-foreground">{copy.uncheckedTouch(s.reachNote)}</p>}
                  {unchanged && <p className="text-muted-foreground">{copy.touchChangedNothing}</p>}
                  {effect && <p className="text-muted-foreground">{copy.touchEffect(effect)}</p>}
                  {s.status === 'failed' && s.suggestions && s.suggestions.length > 0 && (
                    <>
                      <p className="text-muted-foreground">{copy.suggestionsHeading}</p>
                      <ul className="flex flex-col gap-1 font-mono text-xs">
                        {s.suggestions.map((g) => <li key={g.yaml}>{g.yaml}</li>)}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </TraceStep>
          </li>
        )
      })}
    </ol>
  )
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** What a run will look for after a touch, in a line: `"Saved" appears, "Save" goes`. */
function effectLine(seen: StepExpect): string {
  const name = (a: NonNullable<StepExpect['appear']>[number]) => (a.text !== undefined ? `"${a.text}"` : a.id ?? '')
  return [...(seen.appear ?? []).map((a) => `${name(a)} appears`), ...(seen.gone ?? []).map((a) => `${name(a)} goes`)].join(', ')
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Focus the YAML and select it alone, for the keyboard to copy: select-all in a focused block takes the page. */
function selectYaml(pre: HTMLPreElement | null): void {
  if (!pre) return
  pre.focus()
  window.getSelection()?.selectAllChildren(pre.querySelector('[data-slot=code-block-code]') ?? pre)
}

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
  const yamlRef = useRef<HTMLPreElement>(null)
  // No clipboard (a plain-HTTP page): the YAML is selected and focused instead, so ⌘C copies it — and only it, which
  // select-all in a focused block would not (it takes the page).
  const copyYaml = () => {
    void copyToClipboard(yaml).then((ok) => {
      setCopied(ok)
      if (!ok) selectYaml(yamlRef.current)
    })
  }
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
      {/* The YAML takes the height the rest leaves, and scrolls inside itself; the notes on using it sit under it. The
          4 px padding, given back by the margin, is room for the file field's focus ring. */}
      <div className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1">
        <div className="shrink-0">
          <h3 className="text-sm font-medium">{copy.exportHeading}</h3>
          <p className="text-sm text-muted-foreground">{copy.exportHelp}</p>
        </div>
        <div className="grid shrink-0 gap-2">
          <Label htmlFor={fileId}>{copy.fileLabel}</Label>
          <Input id={fileId} readOnly value={fileName} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className="flex min-h-40 flex-1 flex-col">
          <YamlField yaml={yaml} contentRef={yamlRef} fill />
        </div>
        <ul className="shrink-0 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li className="text-foreground">{copy.howToUse}</li>
          {secrets.length > 0 && <li>{copy.secretsToSet(secrets)}</li>}
          {bundleId && <li>{copy.appPinned(bundleId)}</li>}
        </ul>
        <p role="status" className="min-h-5 shrink-0 text-sm text-muted-foreground">{copied === true ? copy.copied : copied === false ? copy.copyByHand : ''}</p>
      </div>
      <Footer>
        <Button variant="outline" onClick={copyYaml}>{copy.copyYaml}</Button>
        <Button variant="outline" onClick={download}>{copy.download}</Button>
        <Button ref={doneRef} className="w-24" onClick={onDone}>{copy.done}</Button>
      </Footer>
    </div>
  )
}

