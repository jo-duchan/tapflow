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
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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
          canvasRef.current.width  = img.width
          canvasRef.current.height = img.height
          ctx.drawImage(img, 0, 0)
        }
      }
      img.src = `data:${msg.mimeType ?? 'image/jpeg'};base64,${msg.payload}`
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

  const dragStart     = useRef<{ x: number; y: number } | null>(null)
  const pressedButton = useRef<string | null>(null)

  // Map a mouse event to normalized screen [0,1].
  // Chrome mode: maps composite-sized container coords through screenRect.
  // Fallback mode (chrome null): the canvas itself is the full screen.
  const toNormScreen = useCallback(
    (e: React.MouseEvent) => {
      if (chrome && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        const cw = chrome.compositeWidth  / 2
        const ch = chrome.compositeHeight / 2
        const cx = (e.clientX - rect.left) * (cw / rect.width)
        const cy = (e.clientY - rect.top)  * (ch / rect.height)
        const sx = chrome.screenRect.x      / 2
        const sy = chrome.screenRect.y      / 2
        const sw = chrome.screenRect.width  / 2
        const sh = chrome.screenRect.height / 2
        if (cx < sx || cx > sx + sw || cy < sy || cy > sy + sh) return null
        return { x: (cx - sx) / sw, y: (cy - sy) / sh }
      }
      if (!chrome && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect()
        const x = (e.clientX - rect.left) / rect.width
        const y = (e.clientY - rect.top)  / rect.height
        if (x < 0 || x > 1 || y < 0 || y > 1) return null
        return { x, y }
      }
      return null
    },
    [chrome],
  )

  const BUTTON_HIT_RADIUS = 30  // 2× px

  // Hit-test physical button positions (normalOffset is in 2× composite pixel space).
  const toButton = useCallback(
    (e: React.MouseEvent): string | null => {
      if (!containerRef.current || !chrome) return null
      const rect = containerRef.current.getBoundingClientRect()
      const cx = (e.clientX - rect.left) * (chrome.compositeWidth  / rect.width)
      const cy = (e.clientY - rect.top)  * (chrome.compositeHeight / rect.height)
      for (const btn of chrome.buttons) {
        const dx = cx - btn.normalOffset.x
        const dy = cy - btn.normalOffset.y
        if (dx * dx + dy * dy < BUTTON_HIT_RADIUS ** 2) return btn.name
      }
      return null
    },
    [chrome],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const btn = toButton(e)
      if (btn) {
        pressedButton.current = btn
        return
      }
      const pos = toNormScreen(e)
      if (pos) dragStart.current = pos
    },
    [toButton, toNormScreen],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (pressedButton.current) {
        send({ type: 'input:button', sessionId, payload: { name: pressedButton.current } })
        pressedButton.current = null
        return
      }
      if (!dragStart.current) return
      const from = dragStart.current
      const to = toNormScreen(e)
      dragStart.current = null
      if (!to) return

      const dx = to.x - from.x
      const dy = to.y - from.y
      if (Math.sqrt(dx * dx + dy * dy) < 0.02) {
        send({ type: 'input:tap', sessionId, payload: from })
      } else {
        send({ type: 'input:swipe', sessionId, payload: { from, to } })
      }
    },
    [send, sessionId, toNormScreen],
  )

  const statusText = !connected
    ? 'Connecting...'
    : !joined
      ? 'Joining session...'
      : `Live · ${fps} fps`

  // Container is composite-sized so the device frame image aligns with button positions.
  // Scale down to fit within ~80vh.
  const compositeLogicalW = chrome ? chrome.compositeWidth  / 2 : 0
  const compositeLogicalH = chrome ? chrome.compositeHeight / 2 : 0
  const MAX_DISPLAY_H = 750
  const displayScale = compositeLogicalH > 0 ? Math.min(1, MAX_DISPLAY_H / compositeLogicalH) : 1
  const displayW = Math.round(compositeLogicalW * displayScale)
  const displayH = Math.round(compositeLogicalH * displayScale)

  // Screen rect as % of composite — positions canvas inside device frame image
  const screenPctLeft = chrome ? (chrome.screenRect.x / chrome.compositeWidth)  * 100 : 0
  const screenPctTop  = chrome ? (chrome.screenRect.y / chrome.compositeHeight) * 100 : 0
  const screenPctW    = chrome ? (chrome.screenRect.width  / chrome.compositeWidth)  * 100 : 100
  const screenPctH    = chrome ? (chrome.screenRect.height / chrome.compositeHeight) * 100 : 100

  // Corner radius: screenCornerRadius is in 2× composite px; scale down to CSS display px.
  // canvas CSS display width = compositeLogicalW * displayScale * (screenRect.width / compositeWidth)
  //                          = screenRect.width * displayScale / 2
  // So 2× composite px → CSS px factor = displayScale / 2
  const cssCornerRadius = chrome ? Math.round((chrome.screenCornerRadius / 2) * displayScale) : 0

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <span className="text-sm text-muted-foreground">{statusText}</span>
      </div>

      {chrome ? (
        /* Overlay mode: screen canvas inside device frame image.
           Container is composite-sized so button hit areas align with the frame art. */
        <div
          ref={containerRef}
          className="relative cursor-crosshair"
          style={{ width: displayW, height: displayH }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        >
          {/* Device frame — behind screen canvas; bezel art is outside the screen rect */}
          <img
            src={`data:image/png;base64,${chrome.framePng}`}
            style={{
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%',
              display: 'block',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
            draggable={false}
            alt=""
          />
          {/* Screen content — on top of device frame; positioned over the screen hole */}
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              left:   `${screenPctLeft}%`,
              top:    `${screenPctTop}%`,
              width:  `${screenPctW}%`,
              height: `${screenPctH}%`,
              borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
            }}
          />
        </div>
      ) : (
        /* Fallback — no chrome data yet */
        <canvas
          ref={canvasRef}
          className="block max-w-full cursor-crosshair"
          style={{ borderRadius: '10%' }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        />
      )}

      {joined && fps === 0 && (
        <p className="text-sm text-muted-foreground">Waiting for first frame...</p>
      )}
    </div>
  )
}
