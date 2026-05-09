'use client'

import { useCallback, useEffect, useRef, useState, Fragment } from 'react'
import { useRelay } from '@/hooks/useRelay'
import { useWebRTC } from '@/hooks/useWebRTC'
import type { ChromeData, RelayMessage } from '@/lib/types'
import { Button } from '@/components/ui/button'

interface Props {
  sessionId: string
  onBack: () => void
}

export function SimulatorViewer({ sessionId, onBack }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const videoRef     = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [joined, setJoined] = useState(false)
  const [fps, setFps] = useState(0)
  const [chrome, setChrome] = useState<ChromeData | null>(null)
  const [webrtcActive, setWebrtcActive] = useState(false)
  const frameCount = useRef(0)
  const sendRef = useRef<(msg: object) => void>(() => {})

  const { handleOffer, addIceCandidate } = useWebRTC({
    onTrack: (stream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => {})
        setWebrtcActive(true)
      }
    },
    send: (msg) => sendRef.current(msg),
    sessionId,
  })

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'session:joined') {
      setJoined(true)
    }

    if (msg.type === 'session:chrome') {
      setChrome(msg.payload)
    }

    if (msg.type === 'webrtc:offer') {
      handleOffer(msg.payload).catch(() => {})
      return
    }

    if (msg.type === 'webrtc:ice') {
      addIceCandidate(msg.payload).catch(() => {})
      return
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
  }, [handleOffer, addIceCandidate])

  const { send, connected } = useRelay(handleMessage)
  sendRef.current = send

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

  // WebRTC fps counting via requestVideoFrameCallback
  useEffect(() => {
    const video = videoRef.current
    if (!video || !webrtcActive) return

    let rafId: number
    const countFrame = () => {
      frameCount.current += 1
      rafId = video.requestVideoFrameCallback(countFrame)
    }
    rafId = video.requestVideoFrameCallback(countFrame)
    return () => video.cancelVideoFrameCallback(rafId)
  }, [webrtcActive])

  const [flashedButton, setFlashedButton] = useState<string | null>(null)
  const [hoveredButton, setHoveredButton] = useState<string | null>(null)
  const pressedButton   = useRef<string | null>(null)
  const touchStartPos   = useRef<{ x: number; y: number } | null>(null)
  const lastMoveSentAt  = useRef(0)
  const MOVE_THROTTLE_MS = 16
  const DRAG_THRESHOLD   = 0.02

  // Map a pointer event to normalized screen [0,1].
  // Chrome mode: maps composite-sized container coords through screenRect.
  // Fallback mode (chrome null): the canvas itself is the full screen.
  const toNormScreen = useCallback(
    (e: { clientX: number; clientY: number }) => {
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

  const BUTTON_HIT_RADIUS = 100  // 2× composite px (~25 CSS px at typical display scale)

  // Hit-test physical button positions (normalOffset is in 2× composite pixel space).
  const toButton = useCallback(
    (e: { clientX: number; clientY: number }): string | null => {
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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const btn = toButton(e)
      if (btn) {
        pressedButton.current = btn
        setFlashedButton(btn)
        return
      }
      const pos = toNormScreen(e)
      if (!pos) return
      touchStartPos.current = pos
      ;(e.target as Element).setPointerCapture(e.pointerId)
      send({ type: 'input:touch:start', sessionId, payload: pos })
    },
    [toButton, toNormScreen, send, sessionId],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons === 0) {
        setHoveredButton(toButton(e))
        return
      }
      if (pressedButton.current) return
      if (!touchStartPos.current) return
      const pos = toNormScreen(e)
      if (!pos) return
      const dx = pos.x - touchStartPos.current.x
      const dy = pos.y - touchStartPos.current.y
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
      const now = performance.now()
      if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
      lastMoveSentAt.current = now
      send({ type: 'input:touch:move', sessionId, payload: pos })
    },
    [toButton, toNormScreen, send, sessionId],
  )

  const handlePointerLeave = useCallback(() => {
    setHoveredButton(null)
  }, [])

  const handlePointerUp = useCallback(
    () => {
      touchStartPos.current = null
      if (pressedButton.current) {
        send({ type: 'input:button', sessionId, payload: { name: pressedButton.current } })
        pressedButton.current = null
        setTimeout(() => setFlashedButton(null), 100)
        return
      }
      send({ type: 'input:touch:end', sessionId })
    },
    [send, sessionId],
  )

  const handlePointerCancel = useCallback(
    () => {
      touchStartPos.current = null
      if (pressedButton.current) {
        pressedButton.current = null
        setFlashedButton(null)
        return
      }
      send({ type: 'input:touch:end', sessionId })
    },
    [send, sessionId],
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
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
        >
          {/* Device frame — zIndex:2, above buttons (masks inner button portion) but below screen content */}
          <img
            src={`data:image/png;base64,${chrome.framePng}`}
            style={{
              position: 'absolute', top: 0, left: 0,
              zIndex: 2,
              width: '100%', height: '100%',
              display: 'block',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
            draggable={false}
            alt=""
          />
          {/* Screen content — zIndex:3, above framePng so screen is always visible */}
          <video
            ref={videoRef}
            muted
            playsInline
            style={{
              position: 'absolute',
              zIndex: 3,
              left:        `${screenPctLeft}%`,
              top:         `${screenPctTop}%`,
              width:       `${screenPctW}%`,
              height:      `${screenPctH}%`,
              borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
              display:      webrtcActive ? 'block' : 'none',
            }}
          />
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              zIndex: 3,
              left:        `${screenPctLeft}%`,
              top:         `${screenPctTop}%`,
              width:       `${screenPctW}%`,
              height:      `${screenPctH}%`,
              borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
              display:      webrtcActive ? 'none' : 'block',
            }}
          />
          {/* Physical button overlays — CSS-animated between retracted (default) and extended (hover) */}
          {chrome.buttons.map((btn) => {
            const isFlashed = flashedButton === btn.name
            const isHovered = hoveredButton === btn.name

            // For bottom-anchor buttons normalOffset.y is center Y; for all others it's top-edge Y.
            const isBottomAnchor = btn.anchor === 'bottom'
            const imgTopPct = isBottomAnchor
              ? ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
              : (btn.normalOffset.y / chrome.compositeHeight) * 100
            const imgHPct  = (btn.buttonH / chrome.compositeHeight) * 100
            const imgWPct  = (btn.buttonW / chrome.compositeWidth)  * 100
            // Default: rolloverOffset (extended, matches baked frame position).
            // Hover: extend further by the same delta so button pops out visibly.
            //   hoverX = 2*rollover - normal  (mirrors normal→rollover delta beyond rollover)
            const halfW = btn.buttonW / 2
            const rolloverLeftPct = ((btn.rolloverOffset.x - halfW) / chrome.compositeWidth) * 100
            const hoverLeftPct    = ((2 * btn.rolloverOffset.x - btn.normalOffset.x - halfW) / chrome.compositeWidth) * 100

            // Tooltip position: at rollover center
            const tooltipLeftPct = (btn.rolloverOffset.x / chrome.compositeWidth) * 100
            const tooltipTopPct  = isBottomAnchor
              ? ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
              : (btn.normalOffset.y / chrome.compositeHeight) * 100

            // onTop (home) button: above framePng. Side buttons: behind framePng.
            // compositeUnder for home: pressedPng at z-index 3, buttonPng at z-index 4
            //   → pressedPng shows through the semi-transparent ring of buttonPng.
            // Side buttons: both at z-index 1; pressedPng renders AFTER buttonPng in DOM
            //   → DOM order makes pressedPng appear on top.
            const btnZ = btn.onTop ? 4 : 1

            return (
              <Fragment key={btn.name}>
                {/* buttonPng — rendered first so side button pressedPng (below) can overlay via DOM order */}
                {btn.buttonPng && (
                  <img
                    src={`data:image/png;base64,${btn.buttonPng}`}
                    style={{
                      position: 'absolute',
                      zIndex:   btnZ,
                      top:    `${imgTopPct}%`,
                      left:   `${isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                      width:  `${imgWPct}%`,
                      height: `${imgHPct}%`,
                      transition: 'left 0.15s ease',
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}
                    draggable={false}
                    alt=""
                  />
                )}
                {/* pressedPng — side: z-index 1 after buttonPng (DOM on top); home: z-index 3 below buttonPng (compositeUnder) */}
                {isFlashed && btn.pressedPng && btn.pressedRect && (
                  <img
                    src={`data:image/png;base64,${btn.pressedPng}`}
                    style={{
                      position: 'absolute',
                      zIndex:   btn.onTop ? 3 : 1,
                      left:   `${isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                      top:    `${(btn.pressedRect.y / chrome.compositeHeight) * 100}%`,
                      width:  `${(btn.pressedRect.width  / chrome.compositeWidth)  * 100}%`,
                      height: `${(btn.pressedRect.height / chrome.compositeHeight) * 100}%`,
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}
                    draggable={false}
                    alt=""
                  />
                )}
                {/* Hover tooltip */}
                {isHovered && (
                  <div style={{
                    position: 'absolute',
                    zIndex:   5,
                    left: `${tooltipLeftPct}%`,
                    top:  `${tooltipTopPct}%`,
                    transform: 'translate(-50%, calc(-100% - 8px))',
                    background: 'rgba(0,0,0,0.72)',
                    color: '#fff',
                    fontSize: 11,
                    padding: '2px 7px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}>
                    {btn.accessibilityTitle}
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      ) : (
        /* Fallback — no chrome data yet */
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            className="block max-w-full"
            style={{ borderRadius: '10%', display: webrtcActive ? 'block' : 'none' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />
          <canvas
            ref={canvasRef}
            className="block max-w-full cursor-crosshair"
            style={{ borderRadius: '10%', display: webrtcActive ? 'none' : 'block' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />
        </>
      )}

      {joined && fps === 0 && (
        <p className="text-sm text-muted-foreground">Waiting for first frame...</p>
      )}
    </div>
  )
}
