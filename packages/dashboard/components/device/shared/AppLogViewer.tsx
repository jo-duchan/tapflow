import { useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { ChevronRight } from 'lucide-react'
import { CodeBlockCopyButton } from '@/components/ui/code-block'
import { useFollowBottom } from '@/hooks/useFollowBottom'
import { appendAppLogText } from '@/lib/appLogs'
import { cn } from '@/lib/utils'

/**
 * What DeviceViewer tells the viewer. `launch` opens a new stream (a launch this viewer sent), `text` is a chunk of it,
 * and `clear` ends it: the box is shown only between a launch and whatever ends that app, never before a launch or for
 * an install that failed, where "waiting for logs" would promise output that is not coming.
 */
export type AppLogEvent = { kind: 'launch' } | { kind: 'text'; text: string } | { kind: 'clear' }
export type AppLogHandler = (event: AppLogEvent) => void

const COLLAPSED_KEY = 'tapflow.appLogs.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** A plain-HTTP page has no clipboard API. That is a copy that did not happen, not a failure. */
function copyToClipboard(text: string): Promise<boolean> {
  return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
    .then(() => true, () => false)
}

interface AppLogViewerProps {
  handlerRef: MutableRefObject<AppLogHandler | null>
  supported: boolean
}

/**
 * The launched app's output, below the info card's status line (#1132). Lines wrap rather than scroll sideways, since
 * the card is 300px wide and most logcat lines are longer than that, and a hairline between lines keeps a wrapped line
 * from reading as two. Not a live region: announcing every chunk is the screen-reader choreography the dashboard's
 * accessibility level leaves out (`packages/dashboard/AGENTS.md`, "The level is `core`").
 */
export function AppLogViewer({ handlerRef, supported }: AppLogViewerProps) {
  const [active, setActive] = useState(false)
  const [text, setText] = useState('')
  // Bumped by each launch, so the body remounts and follows the tail again even if the last app's was scrolled up.
  const [launches, setLaunches] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const pendingTextRef = useRef('')
  const animationFrameRef = useRef<number | null>(null)
  const bodyId = useId()

  useEffect(() => {
    const reset = () => {
      pendingTextRef.current = ''
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
      setText('')
    }
    const handle: AppLogHandler = (event) => {
      if (event.kind !== 'text') {
        reset()
        setActive(event.kind === 'launch')
        if (event.kind === 'launch') setLaunches((n) => n + 1)
        return
      }
      pendingTextRef.current += event.text
      if (animationFrameRef.current !== null) return
      // One state update per frame, however many chunks arrive in it.
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null
        const pending = pendingTextRef.current
        pendingTextRef.current = ''
        setText((current) => appendAppLogText(current, pending))
      })
    }
    handlerRef.current = handle
    return () => {
      if (handlerRef.current === handle) handlerRef.current = null
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
    }
  }, [handlerRef])

  if (!active) return null

  const toggle = () => {
    setCollapsed((was) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, was ? '0' : '1')
      } catch {
        /* no storage */
      }
      return !was
    })
  }
  // A chunk can end mid-line; the last entry is that partial line, or nothing after a newline.
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  // With no clipboard (plain HTTP, the usual self-hosted case) the copy icon selects the log instead of doing nothing.
  const copyOrSelect = (value: string) => copyToClipboard(value).then((ok) => {
    const body = document.getElementById(bodyId)
    if (!ok && body) {
      const range = document.createRange()
      range.selectNodeContents(body)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    return ok
  })

  return (
    <section aria-label="App logs" className="overflow-hidden rounded bg-muted">
      <div className="flex items-center gap-1.5 px-2.5 py-[3px]">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggle}
          className="-ms-1 flex min-w-0 items-center gap-1 rounded px-1 text-[11px] leading-[18px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', !collapsed && 'rotate-90')} />
          App logs
        </button>
        {supported && lines.length > 0 && (
          <span className="ms-auto font-mono text-[10px] tabular-nums text-muted-foreground">
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
        )}
        {supported && lines.length > 0 && (
          <CodeBlockCopyButton value={text} copy={copyOrSelect} className="size-6" />
        )}
      </div>
      {!collapsed && <LogBody key={launches} id={bodyId} lines={lines} text={text} supported={supported} />}
    </section>
  )
}

function LogBody({ id, lines, text, supported }: { id: string; lines: string[]; text: string; supported: boolean }) {
  const ref = useFollowBottom<HTMLDivElement>(text)
  return (
    <div
      ref={ref}
      id={id}
      role="region"
      aria-label="App log output"
      tabIndex={0}
      className="max-h-[220px] overflow-y-auto overflow-x-hidden border-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {!supported || lines.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
          {supported ? 'Waiting for app logs…' : 'Update the device agent to view app logs.'}
        </p>
      ) : (
        <div className="font-mono text-xs leading-normal text-foreground/85">
          {lines.map((line, i) => (
            <div key={i} data-log-line className="whitespace-pre-wrap [overflow-wrap:anywhere] border-b border-border px-2.5 py-0.5 last:border-b-0">
              {line || '\u00a0'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
