import { useState } from 'react'
import { useFollowBottom } from '@/hooks/useFollowBottom'
import {
  CornerDownLeft, Download, Eraser, House, Keyboard, Link2, MousePointerClick, MoveHorizontal, MoveVertical, Play, Scaling,
} from 'lucide-react'
import { TraceStep } from '@/components/TraceStep'
import type { ReactElement } from 'react'
import { actionText, type WatchedAction } from '@/lib/watchActions'
import type { WatchActionKind } from '@tapflowio/protocol'

type Action = Exclude<WatchActionKind, { kind: 'label' }>
/** A step's name and the actions the holder took under it; `label` is null for actions sent with no step before them
 *  (an MCP client tapping directly). */
interface Group { id: number; at: number; label: string | null; actions: { id: number; at: number; action: Action }[] }

/**
 * What the holder has done since this page started watching (A2), oldest first: each step a row that opens onto the
 * actions taken under it, drawn as `TraceStep` (shadcn's Trace look, shared with Flow Capture's Verify). Every step
 * starts open; one someone closed stays closed.
 * The time is a tooltip.
 *
 * `live` is false once the watch is over: the log stays to be read, and no step is shown as still running.
 */
export function AgentActivity({ actions, driver, live }: { actions: WatchedAction[]; driver: string; live: boolean }) {
  const groups = group(actions)
  const latest = groups.at(-1)?.id
  const [opened, setOpened] = useState<Record<number, boolean>>({})
  const follow = useFollowBottom<HTMLDivElement>(actions)

  return (
    <section aria-labelledby="agent-activity-title" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <h2 id="agent-activity-title" className="text-sm font-medium">Agent activity</h2>
      <div
        ref={follow}
        className="h-96 overflow-y-auto rounded-xl border bg-background px-5 py-4 lg:h-auto lg:min-h-48 lg:flex-1"
      >
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet. What the {driver} does appears here as it happens.</p>
        ) : (
          <ol aria-label="Steps and actions" className="flex flex-col gap-2 text-sm">
            {groups.map((g) => g.label === null
              ? g.actions.map((a) => <li key={a.id}><ActionLine {...a} /></li>)
              : (
                <li key={g.id}>
                  <Step
                    group={g}
                    running={live && g.id === latest}
                    open={opened[g.id] ?? true}
                    onToggle={() => setOpened((prev) => ({ ...prev, [g.id]: !(prev[g.id] ?? true) }))}
                  />
                </li>
              ))}
          </ol>
        )}
      </div>
    </section>
  )
}

function Step({ group: g, running, open, onToggle }: { group: Group; running: boolean; open: boolean; onToggle: () => void }) {
  const contentId = `agent-step-${g.id}`
  // A step that took no action (an assertion) has nothing to open.
  return (
    <TraceStep
      state={running ? 'running' : 'done'} label={g.label} title={time(g.at)}
      open={open} contentId={contentId} {...(g.actions.length > 0 ? { onToggle } : {})}
    >
      {g.actions.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {g.actions.map((a) => <li key={a.id}><ActionLine {...a} /></li>)}
        </ul>
      )}
    </TraceStep>
  )
}

function ActionLine({ at, action }: { at: number; action: Action }) {
  return (
    <span title={time(at)} className="flex min-w-0 items-center gap-2.5">
      {iconFor(action)}
      <span className="truncate">{actionText(action)}</span>
    </span>
  )
}

/** Oldest first, each action under the step label before it. */
function group(actions: WatchedAction[]): Group[] {
  const out: Group[] = []
  for (const { id, at, action } of [...actions].reverse()) {
    if (action.kind === 'label') out.push({ id, at, label: action.label, actions: [] })
    else {
      const last = out.at(-1)
      if (last) last.actions.push({ id, at, action })
      else out.push({ id, at, label: null, actions: [{ id, at, action }] })
    }
  }
  return out
}

const time = (at: number) => new Date(at).toLocaleTimeString()

function iconFor(a: Action): ReactElement {
  const c = { 'aria-hidden': true, className: 'size-4 shrink-0 text-muted-foreground' } as const
  switch (a.kind) {
    case 'tap': return <MousePointerClick {...c} />
    case 'swipe': return Math.abs(a.to[0] - a.from[0]) > Math.abs(a.to[1] - a.from[1]) ? <MoveHorizontal {...c} /> : <MoveVertical {...c} />
    case 'key': return <CornerDownLeft {...c} />
    case 'button': return <House {...c} />
    case 'type': return <Keyboard {...c} />
    case 'pinch': return <Scaling {...c} />
    case 'launch': return <Play {...c} />
    case 'install': return <Download {...c} />
    case 'clear-state': return <Eraser {...c} />
    case 'open-url': return <Link2 {...c} />
  }
}
