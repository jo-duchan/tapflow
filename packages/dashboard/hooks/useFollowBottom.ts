import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Keeps a scrolling list at its newest line while the reader is at the bottom, and leaves them where they are once they
 * scroll up: MCP's Agent activity and Flow Capture's Verify, both logs that grow as a run goes. `changed` is what the
 * list shows; the returned ref goes on the scrolling element.
 *
 * **Before paint, with scroll anchoring off**: Chrome's anchoring adjusts the box as lines are added and fires a scroll
 * event from that layout, which read as the reader having left the bottom, so following stopped for good the first time
 * someone scrolled. Now the only scroll events are the reader's and this one.
 */
export function useFollowBottom<T extends HTMLElement>(changed: unknown): RefObject<T | null> {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.overflowAnchor = 'none'
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
    // Again as the list changes: Verify's is not rendered until its first step, so the element may come later.
  }, [changed])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [changed])
  return ref
}
