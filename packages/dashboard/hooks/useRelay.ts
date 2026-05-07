'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RelayMessage } from '@/lib/types'

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:3000'

export function useRelay(onMessage: (msg: RelayMessage) => void) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    const socket = new WebSocket(RELAY_URL)
    ws.current = socket

    socket.onopen = () => setConnected(true)
    socket.onclose = () => setConnected(false)
    socket.onmessage = (e) => {
      try {
        onMessageRef.current(JSON.parse(e.data))
      } catch { /* ignore malformed */ }
    }

    return () => socket.close()
  }, [])

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { send, connected }
}
