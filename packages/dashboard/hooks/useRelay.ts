'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RelayMessage } from '@/lib/types'

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:3000'
const RECONNECT_DELAY = 2000

export function useRelay(
  onMessage: (msg: RelayMessage) => void,
  onBinaryFrame?: (data: ArrayBuffer) => void,
) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const onBinaryFrameRef = useRef(onBinaryFrame)
  onBinaryFrameRef.current = onBinaryFrame

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return

      const socket = new WebSocket(RELAY_URL)
      socket.binaryType = 'arraybuffer'
      ws.current = socket

      socket.onopen = () => setConnected(true)

      socket.onclose = () => {
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

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { send, connected }
}
