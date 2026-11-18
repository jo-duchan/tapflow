import { useCallback, useRef, useState } from 'react'

export function useDeepLinkDialog() {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLElement | null>(null)

  const openFrom = useCallback((element: Element | null) => {
    if (open) return
    // During the exit animation a dialog button can still have focus when Cmd+K reopens it.
    if (!element?.closest('[data-deeplink-dialog]')) {
      opener.current = element instanceof HTMLElement ? element : null
    }
    setOpen(true)
  }, [open])

  const restoreFocus = useCallback((event: Event) => {
    const element = opener.current
    opener.current = null
    if (!element?.isConnected) return
    event.preventDefault()
    element.focus({ preventScroll: true })
  }, [])

  return { open, setOpen, openFrom, restoreFocus }
}
