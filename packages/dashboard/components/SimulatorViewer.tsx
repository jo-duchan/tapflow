'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import type { ChromeData, RelayMessage } from '@/lib/types'
import { Button } from '@/components/ui/button'

interface Props {
  sessionId: string
  onBack: () => void
}

export function SimulatorViewer({ sessionId, onBack }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [joined, setJoined] = useState(false)
  const [fps, setFps] = useState(0)
  const [chrome, setChrome] = useState<ChromeData | null>(null)
  const frameCount = useRef(0)

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'session:joined') {
      setJoined(true)
    }

    if (msg.type === 'session:chrome') {
      setChrome(msg.payload)
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
      img.src = `data:image/jpeg;base64,${msg.payload}`
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

  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const toNorm = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    }
  }

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return
    dragStart.current = toNorm(e)
  }, [])

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!canvasRef.current || !dragStart.current) return
      const from = dragStart.current
      const to = toNorm(e)
      dragStart.current = null

      const dx = to.x - from.x
      const dy = to.y - from.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < 0.02) {
        send({ type: 'input:tap', sessionId, payload: from })
      } else {
        send({ type: 'input:swipe', sessionId, payload: { from, to } })
      }
    },
    [send, sessionId]
  )

  const statusText = !connected
    ? 'Connecting...'
    : !joined
      ? 'Joining session...'
      : `Live · ${fps} fps`

  const screenPctLeft = chrome ? (chrome.screenRect.x / chrome.bezelWidth) * 100 : 0
  const screenPctTop = chrome ? (chrome.screenRect.y / chrome.bezelHeight) * 100 : 0
  const screenPctW = chrome ? (chrome.screenRect.width / chrome.bezelWidth) * 100 : 100
  const screenPctH = chrome ? (chrome.screenRect.height / chrome.bezelHeight) * 100 : 100

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <span className="text-sm text-muted-foreground">{statusText}</span>
      </div>

      {chrome ? (
        /* Bezel mode: device frame image with canvas positioned inside screen area */
        <div className="relative inline-block" style={{ width: chrome.physicalWidthPx }}>
          <img
            src={`data:image/png;base64,${chrome.bezelPng}`}
            className="block w-full select-none"
            draggable={false}
            alt="device frame"
          />
          <canvas
            ref={canvasRef}
            className="absolute cursor-crosshair"
            style={{
              left: `${screenPctLeft}%`,
              top: `${screenPctTop}%`,
              width: `${screenPctW}%`,
              height: `${screenPctH}%`,
            }}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          />
        </div>
      ) : (
        /* Fallback: plain canvas before chrome data arrives */
        <div
          className="overflow-hidden shadow-lg"
          style={{ borderRadius: '11.2% / 5.16%' }}
        >
          <canvas
            ref={canvasRef}
            className="block max-w-full cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          />
        </div>
      )}

      {joined && fps === 0 && (
        <p className="text-sm text-muted-foreground">Waiting for first frame...</p>
      )}
    </div>
  )
}
