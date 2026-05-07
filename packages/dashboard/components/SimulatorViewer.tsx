'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { RelayMessage } from '@/lib/types'
import { Button } from '@/components/ui/button'

interface Props {
  sessionId: string
  onBack: () => void
}

export function SimulatorViewer({ sessionId, onBack }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [joined, setJoined] = useState(false)
  const [fps, setFps] = useState(0)
  const frameCount = useRef(0)

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'session:joined') {
      setJoined(true)
    }

    if (msg.type === 'stream:frame' && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d')
      if (!ctx) return

      const img = new Image()
      img.onload = () => {
        if (canvasRef.current) {
          canvasRef.current.width = img.width
          canvasRef.current.height = img.height
          ctx.drawImage(img, 0, 0)
        }
      }
      img.src = `data:image/png;base64,${msg.payload}`
      frameCount.current += 1
    }
  }, [])

  const { send, connected } = useRelay(handleMessage)

  useEffect(() => {
    if (connected) send({ type: 'session:start', sessionId })
  }, [connected, send, sessionId])

  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frameCount.current)
      frameCount.current = 0
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      const scaleX = canvasRef.current.width / rect.width
      const scaleY = canvasRef.current.height / rect.height
      const x = Math.round((e.clientX - rect.left) * scaleX)
      const y = Math.round((e.clientY - rect.top) * scaleY)
      send({ type: 'input:tap', sessionId, payload: { x, y } })
    },
    [send, sessionId]
  )

  const statusText = !connected
    ? 'Connecting...'
    : !joined
      ? 'Joining session...'
      : `Live · ${fps} fps`

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <span className="text-sm text-muted-foreground">{statusText}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="max-w-full cursor-crosshair rounded-lg border border-border"
        onClick={handleCanvasClick}
      />

      {joined && fps === 0 && (
        <p className="text-sm text-muted-foreground">Waiting for first frame...</p>
      )}
    </div>
  )
}
