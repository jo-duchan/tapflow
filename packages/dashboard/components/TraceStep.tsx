import type { ReactNode } from 'react'
import { ChevronRight, CircleCheck, CircleDashed, CircleX, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TraceState = 'running' | 'done' | 'failed' | 'skipped'

/**
 * One step of a trace: an icon for how it went, its name, and what it holds when opened — the look of shadcn's Trace
 * ("Thought for 5s"), rebuilt as a plain disclosure because Trace is Base UI and this package is Radix on Tailwind 3.
 * MCP's Agent activity and Flow Capture's Verify draw their steps with it, so a step looks the same wherever a run is
 * watched. With no `children` there is nothing to open, and the row is not a button.
 */
export function TraceStep({ state, label, meta, title, open = false, onToggle, contentId, children }: {
  state: TraceState
  label: ReactNode
  /** Beside the name, quieter: how long it took. */
  meta?: ReactNode
  /** A tooltip on the row, such as when it happened. */
  title?: string
  open?: boolean
  onToggle?: () => void
  contentId?: string
  children?: ReactNode
}) {
  const head = (
    <>
      <TraceIcon state={state} />
      <span className="truncate">{label}</span>
      {meta !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>}
    </>
  )
  const tone = state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
  if (!children || !onToggle) {
    return <div title={title} className={cn('flex min-w-0 items-center gap-2.5', tone)}>{head}</div>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button" title={title} aria-expanded={open} aria-controls={contentId} onClick={onToggle}
        className={cn(
          'flex min-w-0 items-center gap-2.5 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          tone,
        )}
      >
        {head}
        <ChevronRight aria-hidden="true" className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div id={contentId} className="ml-2 border-l pl-4">{children}</div>}
    </div>
  )
}

function TraceIcon({ state }: { state: TraceState }) {
  const c = 'size-4 shrink-0'
  switch (state) {
    case 'running': return <LoaderCircle aria-hidden="true" className={cn(c, 'motion-safe:animate-spin')} />
    case 'done': return <CircleCheck aria-hidden="true" className={c} />
    case 'failed': return <CircleX aria-hidden="true" className={c} />
    case 'skipped': return <CircleDashed aria-hidden="true" className={c} />
  }
}
