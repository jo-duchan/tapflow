import { Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronRight } from 'lucide-react'
import { CodeBlockCopyButton } from '@/components/ui/code-block'
import type { AppLogFeed } from '@/lib/appLogs'
import { AppLogRows, loadAppLogRows } from './appLogRowsChunk'
import { cn } from '@/lib/utils'

export type { AppLogEvent } from '@/lib/appLogs'

const COLLAPSED_KEY = 'tapflow.appLogs.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * A plain-HTTP page (the usual self-hosted case) has no clipboard API. Only the rows in view are in the DOM, so
 * selecting the body would take a screenful, not the log: the text goes through a hidden textarea and the older copy
 * command instead, which still works there inside the click. False when neither copied.
 */
function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false)
  const focused = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.focus({ preventScroll: true })
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  if (focused instanceof HTMLElement) focused.focus()
  return Promise.resolve(copied)
}

interface AppLogViewerProps {
  feed: AppLogFeed
  supported: boolean
}

/**
 * The launched app's output, below the info card's status line (#1132). Lines wrap rather than scroll sideways, since
 * the card is 300px wide and most logcat lines are longer than that, and a hairline between lines keeps a wrapped line
 * from reading as two. Not a live region: announcing every chunk is the screen-reader choreography the dashboard's
 * accessibility level leaves out (`packages/dashboard/AGENTS.md`, "The level is `core`").
 */
export function AppLogViewer({ feed, supported }: AppLogViewerProps) {
  const log = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  const { active, opens: launches } = log
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // State, not a ref: the rows read it when they mount, and a ref set in the same commit could still be empty there.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const bodyId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // A failure here is shown by the box when it renders the rows (`appLogRowsChunk.ts`).
    if (active) loadAppLogRows().catch(() => {})
  }, [active])

  if (!active) return null

  const setOpen = (open: boolean) => {
    // Collapsing makes the body inert. Focus inside it would fall to <body>: Safari does not focus a button on click,
    // so a mouse click on the toggle after tabbing into the log leaves focus where it was.
    const body = document.getElementById(bodyId)
    if (!open && body?.contains(document.activeElement)) toggleRef.current?.focus()
    try {
      localStorage.setItem(COLLAPSED_KEY, open ? '0' : '1')
    } catch {
      /* no storage */
    }
    setCollapsed(!open)
  }
  const { buffer, rows, dropped } = log

  return (
    <section aria-label="App logs" className="overflow-hidden rounded bg-muted">
      {/* 28px, the height of the info card's chips above it, with or without the 24px Copy button. */}
      <div className="flex h-7 items-center gap-1.5 px-2.5">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setOpen(collapsed)}
          className="-ms-1 flex min-w-0 items-center gap-1 rounded px-1 text-[11px] leading-[18px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', !collapsed && 'rotate-90')} />
          App logs
        </button>
        {supported && rows > 0 && (
          <span className="ms-auto font-mono text-[10px] tabular-nums text-muted-foreground">
            {rows.toLocaleString('en-US')} {rows === 1 ? 'line' : 'lines'}
            {dropped > 0 && ` (${dropped.toLocaleString('en-US')} dropped)`}
          </span>
        )}
        {/* Open or collapsed alike: it copies from the buffer, not the DOM. Hover as the "App logs" toggle does, since the
            muted header hides the ghost button's own hover background. Icons at 14px, as the card's Focus icon: `Button`
            sets its icons to 16px, which this overrides here only. */}
        {supported && rows > 0 && (
          <CodeBlockCopyButton
            value={() => buffer.text()}
            copy={copyToClipboard}
            className="size-6 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3.5"
          />
        )}
      </div>
      {/*
        Opens by animating the grid row from 0fr to 1fr, not by Radix's Collapsible: that one measures the height to
        open to once, at the start, when the rows still have their estimated heights (one line each), so it opened to
        that and then jumped to the wrapped rows' real height. A grid row follows the content as it is measured.
        Collapsed, the log stays mounted, at no height and inert: the rows keep their measured heights, and reopening
        has nothing to measure. It also keeps drawing the rows in view as lines arrive: collapsed costs what open does.
      */}
      <div
        id={bodyId}
        inert={collapsed}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* Keyed by launch: a new app's log starts at its tail even if the last one was scrolled up. */}
          <div
            key={launches}
            ref={setScrollElement}
            role="region"
            aria-label="App log output"
            tabIndex={0}
            // Chrome's own scroll anchoring would fight the virtualizer's over the same rows. The bottom margin keeps the
            // edge where scrolled text is cut off clear of the card's rounded edge, wherever the box is scrolled.
            style={{ overflowAnchor: 'none' }}
            className="mb-1.5 max-h-[220px] overflow-y-auto overflow-x-hidden border-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {!supported || rows === 0 ? (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
                {supported ? 'Waiting for app logs…' : 'Update the device agent to view app logs.'}
              </p>
            ) : (
              <Suspense fallback={null}>
                <AppLogRows scrollElement={scrollElement} buffer={buffer} version={log.version} rows={rows} dropped={dropped} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
