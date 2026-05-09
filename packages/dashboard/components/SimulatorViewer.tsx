'use client'

import { useCallback, useEffect, useRef, useState, Fragment } from 'react'
import { Home, Camera, RotateCw } from 'lucide-react'
import { useRelay } from '@/hooks/useRelay'
import { useWebRTC } from '@/hooks/useWebRTC'
import type { ChromeData, DeviceInfo, RelayMessage } from '@/lib/types'
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
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
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

    if (msg.type === 'session:deviceInfo') {
      setDeviceInfo(msg.payload)
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

  const [isLandscape, setIsLandscape] = useState(false)
  const [flashedButton, setFlashedButton] = useState<string | null>(null)
  const [hoveredButton, setHoveredButton] = useState<string | null>(null)
  const [pinchHint, setPinchHint] = useState<{ f0: { x: number; y: number }; f1: { x: number; y: number } } | null>(null)
  const pressedButton   = useRef<string | null>(null)
  const touchStartPos   = useRef<{ x: number; y: number } | null>(null)
  const isPinchMode     = useRef(false)
  const isOptionHeld    = useRef(false)
  const lastMoveSentAt  = useRef(0)
  const MOVE_THROTTLE_MS = 16
  const DRAG_THRESHOLD   = 0.02

  // Track Option/Alt key for pinch mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Alt') isOptionHeld.current = true }
    const onKeyUp   = (e: KeyboardEvent) => { if (e.key === 'Alt') { isOptionHeld.current = false; setPinchHint(null) } }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  // Map a pointer event to normalized screen [0,1].
  // Portrait chrome: maps composite container coords through screenRect.
  // Landscape chrome: container is rotated 90° CW → invert (u,v) to portrait composite coords.
  // No chrome: canvas rect directly.
  const toNormScreen = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (chrome && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        const cw = chrome.compositeWidth  / 2
        const ch = chrome.compositeHeight / 2
        const sx = chrome.screenRect.x      / 2
        const sy = chrome.screenRect.y      / 2
        const sw = chrome.screenRect.width  / 2
        const sh = chrome.screenRect.height / 2
        let cx: number, cy: number
        if (isLandscape) {
          // getBoundingClientRect() returns the rotated (landscape) bounding box.
          // u,v are 0-1 in visible landscape space.
          // 90° CW inverse: portrait_x = v, portrait_y = 1 - u
          const u = (e.clientX - rect.left) / rect.width
          const v = (e.clientY - rect.top)  / rect.height
          cx = v * cw
          cy = (1 - u) * ch
        } else {
          cx = (e.clientX - rect.left) * (cw / rect.width)
          cy = (e.clientY - rect.top)  * (ch / rect.height)
        }
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
    [chrome, isLandscape],
  )

  // Compute pinch finger positions: f1 = cursor, f0 = screen-center mirror (Xcode style).
  const toPinchFingers = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const f1 = toNormScreen(e)
      if (!f1) return null
      const f0 = { x: 1 - f1.x, y: 1 - f1.y }
      return { f0, f1 }
    },
    [toNormScreen],
  )

  const BUTTON_HIT_RADIUS = 100  // 2× composite px (~25 CSS px at typical display scale)

  // Hit-test physical button positions (normalOffset is in 2× composite pixel space).
  const toButton = useCallback(
    (e: { clientX: number; clientY: number }): string | null => {
      if (!containerRef.current || !chrome || isLandscape) return null
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
      if (isOptionHeld.current) {
        const fingers = toPinchFingers(e)
        if (!fingers) return
        isPinchMode.current = true
        ;(e.target as Element).setPointerCapture(e.pointerId)
        setPinchHint(fingers)
        send({ type: 'input:pinch:start', sessionId, payload: fingers })
        return
      }
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
    [toButton, toNormScreen, toPinchFingers, send, sessionId],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons === 0) {
        // Hover: update button highlight and pinch preview circles
        setHoveredButton(toButton(e))
        if (isOptionHeld.current) setPinchHint(toPinchFingers(e))
        else setPinchHint(null)
        return
      }
      if (isPinchMode.current) {
        const fingers = toPinchFingers(e)
        if (!fingers) return
        const now = performance.now()
        if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
        lastMoveSentAt.current = now
        setPinchHint(fingers)
        send({ type: 'input:pinch:move', sessionId, payload: fingers })
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
    [toButton, toNormScreen, toPinchFingers, send, sessionId],
  )

  const handlePointerLeave = useCallback(() => {
    setHoveredButton(null)
    setPinchHint(null)
  }, [])

  const handlePointerUp = useCallback(
    () => {
      if (isPinchMode.current) {
        isPinchMode.current = false
        setPinchHint(null)
        send({ type: 'input:pinch:end', sessionId })
        return
      }
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
      if (isPinchMode.current) {
        isPinchMode.current = false
        setPinchHint(null)
        send({ type: 'input:pinch:end', sessionId })
        return
      }
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

  const handleScreenshot = useCallback(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (webrtcActive && videoRef.current) {
      canvas.width  = videoRef.current.videoWidth
      canvas.height = videoRef.current.videoHeight
      ctx.drawImage(videoRef.current, 0, 0)
    } else if (canvasRef.current) {
      canvas.width  = canvasRef.current.width
      canvas.height = canvasRef.current.height
      ctx.drawImage(canvasRef.current, 0, 0)
    } else return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tapflow-${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [webrtcActive])

  const handleRotate = useCallback(() => {
    send({ type: 'input:rotate', sessionId })
    setIsLandscape((prev) => !prev)
  }, [send, sessionId])

  const handleSoftHome = useCallback(() => {
    send({ type: 'input:button', sessionId, payload: { name: 'home' } })
  }, [send, sessionId])

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
           In landscape the outer wrapper holds landscape dimensions; the inner container
           is rotated 90° CW so the chrome frame, canvas, and buttons rotate together.
           Touch coordinates are inverse-mapped in toNormScreen when isLandscape. */
        <div style={{
          width:  isLandscape ? displayH : displayW,
          height: isLandscape ? displayW : displayH,
          position: 'relative',
          flexShrink: 0,
        }}>
        <div
          ref={containerRef}
          className="relative cursor-crosshair"
          style={{
            width: displayW,
            height: displayH,
            ...(isLandscape ? {
              position: 'absolute',
              top:  (displayW - displayH) / 2,
              left: (displayH - displayW) / 2,
              transform: 'rotate(90deg)',
              transformOrigin: 'center center',
            } : {}),
          }}
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
              objectFit:    isLandscape ? 'fill' : undefined,
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
          {/* Pinch finger hints — two semi-transparent circles at f0/f1 positions */}
          {pinchHint && (() => {
            const screenLeft = screenPctLeft / 100
            const screenTop  = screenPctTop  / 100
            const screenW    = screenPctW    / 100
            const screenH    = screenPctH    / 100
            const toCSS = (nx: number, ny: number) => ({
              left: `${(screenLeft + nx * screenW) * 100}%`,
              top:  `${(screenTop  + ny * screenH) * 100}%`,
            })
            return (
              <>
                {([pinchHint.f0, pinchHint.f1] as const).map((f, i) => (
                  <div key={i} style={{
                    position: 'absolute',
                    zIndex: 10,
                    width: 28, height: 28,
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.45)',
                    border: '2px solid rgba(255,255,255,0.85)',
                    transform: 'translate(-50%, -50%)',
                    pointerEvents: 'none',
                    ...toCSS(f.x, f.y),
                  }} />
                ))}
              </>
            )
          })()}
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

      {/* Control bar */}
      {joined && (
        <div
          className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-1.5"
          style={{ width: chrome ? (isLandscape ? displayH : displayW) : '100%', minWidth: 200 }}
        >
          <span className="text-xs text-muted-foreground truncate">
            {deviceInfo
              ? `${deviceInfo.deviceName}${deviceInfo.osVersion ? ` · ${deviceInfo.osVersion}` : ''}`
              : '—'}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Home" onClick={handleSoftHome}>
              <Home className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Screenshot" onClick={handleScreenshot}>
              <Camera className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Rotate" onClick={handleRotate}>
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
