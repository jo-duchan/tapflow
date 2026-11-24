import { useCallback, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AppLogBuffer } from '@/lib/appLogs'
import { cn } from '@/lib/utils'

/** One row: `text-xs` at `leading-normal` (18px), `py-1`, and the hairline. Measured rows replace it once drawn. */
const ROW_ESTIMATE = 27
/** The "earlier lines dropped" note above the first held line, a single truncated line of a fixed height. */
const DROPPED_NOTE_HEIGHT = 24
/** "At the bottom" within this many pixels, as `useFollowBottom` has it for the other logs. */
const FOLLOW_THRESHOLD = 24

interface AppLogRowsProps {
  /** The viewer's scroll box. Held by the viewer, so it is the same element (and keeps focus) from "Waiting" on. */
  scrollElement: HTMLDivElement | null
  buffer: AppLogBuffer
  version: number
  rows: number
  dropped: number
}

/**
 * Only the rows in view are mounted (#1233), so the log can hold tens of thousands of lines without the DOM growing
 * with it. Rows wrap, so their heights are measured, not assumed. Each row's key is its line number since the launch,
 * not its index: when the oldest lines are dropped every index shifts, and the key is what lets the virtualizer keep
 * the line being read where it is (`anchorTo: 'end'`), and follow the tail when the reader is at the bottom.
 *
 * **Following is the virtualizer's own, not `useFollowBottom`'s.** Measured in Chrome: pinning `scrollTop` from outside
 * the virtualizer left the box's top blank in 30% of frames at 500 lines a second (it learns the new offset only from
 * the next `scroll` event), and at 2,000 lost the bottom for good. `followOnAppend` never left a blank frame or lost
 * the bottom; the paint right after an append can sit a frame short, since it scrolls to an end worked out from
 * estimated heights and corrects once the wrapped rows are measured.
 *
 * In its own chunk, loaded when a launch opens the box (`loadAppLogRows`), so the virtualizer is not part of the QA
 * session's first load. Not compiled by the React Compiler: it skips any component calling `useVirtualizer`, whose return value changes
 * without its identity changing. `version` is why this re-renders on every append.
 */
export default function AppLogRows({ scrollElement, buffer, version, rows, dropped }: AppLogRowsProps) {
  // Stable until lines are dropped: a new key function makes the virtualizer rebuild every row's position (up to
  // 50,000) on any render, a scroll included. A drop shifts the keys and rebuilds them anyway.
  const getItemKey = useCallback((index: number) => dropped + index, [dropped])
  // eslint-disable-next-line react-hooks/incompatible-library -- skipped by the compiler on purpose, see above
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey,
    paddingStart: dropped > 0 ? DROPPED_NOTE_HEIGHT : 0,
    overscan: 8,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: FOLLOW_THRESHOLD,
  })
  // `followOnAppend` follows a count that grows. Mounted with lines already held (the box opened again after a
  // collapse, or this chunk arrived after the first output), there is no growth to follow: start at the tail instead.
  // The virtualizer keeps each drawn row's measured height by key and forgets none, so over a long stream it would
  // hold one for every line ever shown. Keys below `dropped` name lines that are gone. A trim happens once per
  // thousand lines, and the cache holds at most the lines drawn since, so the scan is small.
  useLayoutEffect(() => {
    for (const key of virtualizer.itemSizeCache.keys()) if ((key as number) < dropped) virtualizer.itemSizeCache.delete(key)
  }, [dropped, virtualizer])
  const startedAtTail = useRef(false)
  useLayoutEffect(() => {
    // The box reaches the viewer's state a commit after it mounts, and reopened it is a new element.
    if (startedAtTail.current || rows === 0 || !scrollElement) return
    startedAtTail.current = true
    virtualizer.scrollToEnd()
  }, [rows, scrollElement, virtualizer])

  return (
    <div data-version={version} className="relative font-mono text-xs leading-normal text-foreground/85" style={{ height: virtualizer.getTotalSize() }}>
      {dropped > 0 && (
        <p data-log-dropped className="absolute inset-x-0 top-0 truncate border-b border-border px-2.5 font-sans leading-6 text-muted-foreground" style={{ height: DROPPED_NOTE_HEIGHT }}>
          {dropped.toLocaleString('en-US')} earlier {dropped === 1 ? 'line' : 'lines'} dropped
        </p>
      )}
      {virtualizer.getVirtualItems().map((item) => {
        // A run separator is the box's own line, not the app's: muted, in the interface font, and not a log line.
        const mark = buffer.isMark(item.index)
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            {...(mark ? { 'data-log-mark': '' } : { 'data-log-line': '' })}
            className={cn(
              'absolute inset-x-0 top-0 whitespace-pre-wrap [overflow-wrap:anywhere] border-b border-border px-2.5 py-1',
              mark && 'font-sans text-muted-foreground',
              item.index === rows - 1 && 'border-b-0',
            )}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {buffer.row(item.index) || '\u00a0'}
          </div>
        )
      })}
    </div>
  )
}
