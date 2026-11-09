import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserInbound } from '@/lib/types'
import type { BrowserToRelay } from '@tapflowio/protocol'
import { newRequestId } from '@/lib/requestId'

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? `${wsProtocol}//${location.host}`
const RECONNECT_DELAY = 2000

/**
 * Who this tab is, for the relay's ownership check. One value for the whole document, so the three sockets
 * this app opens (`DeviceViewer`, `useAgentSession`, `MacResources`) are one holder — which is what lets
 * the unmount teardown shut down a device the viewer's socket was holding.
 *
 * **In memory, deliberately not `sessionStorage`.** That store is *copied* into a tab opened from this one
 * — duplicate tab, ⌘-click on a same-origin link, session restore — so two tabs would share an identity
 * and the second would silently take the first's device. A per-document value has no such twin: a new
 * document is a new tab is a new identity.
 *
 * It survives what it needs to. The reconnect below runs inside this document, so a Wi-Fi blip returns as
 * the same client and re-joins its own session instead of waiting out the relay's occupancy window. A
 * *reload* is a new document and a new identity, which is correct for a duplicate and costs a reloading
 * tester nothing in the ordinary case — the socket closes cleanly, so the relay releases the session. The
 * exception is a reload *during* a blip: no clean close, new identity, so the relay's window applies.
 *
 * **`newRequestId`, not `crypto.randomUUID`.** The latter is secure-context only and a LAN deployment is
 * plain HTTP — the primary manual-testing path. This module is loaded by every route, so a throw here is
 * a blank page rather than a broken socket, and it would have looked correct in dev (localhost is a secure
 * context) and in vitest (jsdom is not a browser). `lib/requestId.ts` records this exact lesson from the
 * last time; this is the third caller it warned about.
 */
const CLIENT_ID = newRequestId()

/** `RELAY_URL` is operator-supplied and may already carry a path or query, so this is built rather than
 *  concatenated. */
function relayUrl(): string {
  const url = new URL(RELAY_URL)
  url.searchParams.set('client', CLIENT_ID)
  return url.toString()
}

export function useRelay(
  onMessage: (msg: BrowserInbound) => void,
  onBinaryFrame?: (data: ArrayBuffer) => void,
  /** Called the moment the socket closes, before `connected` re-renders: Flow Capture's channel fails its waiters
   *  then, rather than one render later (#1125). */
  onClose?: () => void,
) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  // Latest-callback refs. Written in a layout effect, not during render (lost when a concurrent
  // render is discarded) and not in a passive effect: `useEffect` runs after paint, leaving a gap
  // in which a socket message can still reach the previous callbacks — misrouting a frame right
  // after `sessionId` or `deviceId` changes. A layout effect runs synchronously on commit, so no
  // task can interleave.
  const onMessageRef = useRef(onMessage)
  const onBinaryFrameRef = useRef(onBinaryFrame)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onMessageRef.current = onMessage
    onBinaryFrameRef.current = onBinaryFrame
    onCloseRef.current = onClose
  }, [onMessage, onBinaryFrame, onClose])

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return

      const socket = new WebSocket(relayUrl())
      socket.binaryType = 'arraybuffer'
      ws.current = socket

      socket.onopen = () => setConnected(true)

      socket.onclose = () => {
        onCloseRef.current?.()
        setConnected(false)
        if (!cancelled) setTimeout(connect, RECONNECT_DELAY)
      }

      socket.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          onBinaryFrameRef.current?.(e.data)
          return
        }
        try {
          onMessageRef.current(JSON.parse(e.data))
        } catch { /* ignore malformed */ }
      }
    }

    connect()

    return () => {
      cancelled = true
      ws.current?.close()
    }
  }, [])

  /** Whether the message went out: `false` while the socket is not open, when it is dropped rather than queued. */
  const send = useCallback((msg: BrowserToRelay): boolean => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false
    ws.current.send(JSON.stringify(msg))
    return true
  }, [])

  return { send, connected }
}
