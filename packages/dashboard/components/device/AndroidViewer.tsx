'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { ArrowLeft, Home, LayoutGrid, Loader2, Play, Power, Volume1, Volume2 } from 'lucide-react';
import { H264Decoder } from '@/lib/H264Decoder';
import { useWebGLRenderer } from '@/lib/WebGLVideoRenderer';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AndroidButton } from '@/lib/types'
import { androidToNorm as toNormPure, toPinchFingers as makePinchFingers } from '@/lib/coordinate-transform';

const CURSOR_RING_R = 13;
const CURSOR_DOT_R = 8;
const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;
const MAX_ANDROID_LONG = 720;

interface AndroidViewerProps {
  sessionId: string;
  buildId?: number;
  send: (msg: object) => void;
  connected: boolean;
  joined: boolean;
  deviceReady: boolean;
  installing: boolean;
  installed: boolean;
  installError: string | null;
  bootError: string | null;
  launching: boolean;
  setLaunching: (v: boolean) => void;
  androidButtons: AndroidButton[] | null;
  binaryFrameHandlerRef: React.RefObject<((data: ArrayBuffer) => void) | undefined>;
  onRecordingUploaded?: () => void;
  screenWidth?: number;
  screenHeight?: number;
  deviceRotation?: number;
  skinBackPng?: string;
  skinMaskPng?: string;
  skinScreenRect?: { x: number; y: number; width: number; height: number };
  skinCompositeSize?: { width: number; height: number };
  skinCornerRadius?: number;
}

export function AndroidViewer({
  sessionId, buildId, send, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, setLaunching, androidButtons,
  binaryFrameHandlerRef, onRecordingUploaded,
  screenWidth, screenHeight, deviceRotation = 0,
  skinBackPng, skinMaskPng, skinScreenRect, skinCompositeSize, skinCornerRadius = 0,
}: AndroidViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { init: glInit, dispose: glDispose, drawFrame: glDrawFrame } = useWebGLRenderer(canvasRef);
  const { fps, frameCount } = useFps();
  const { recordState, recordCanvasRef, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });

  const [canvasReady, setCanvasReady] = useState(false);
  const [glError, setGlError] = useState(false);
  const [pressedButton, setPressedButton] = useState<string | null>(null);
  const videoSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);

  const [keyboardActive, setKeyboardActive] = useState(false);
  const [pinchActive, setPinchActive] = useState(false);
  const [pinchHint, setPinchHint] = useState<{ f0: { x: number; y: number }; f1: { x: number; y: number } } | null>(null);
  const pinchHintRef = useRef(pinchHint);
  useEffect(() => { pinchHintRef.current = pinchHint; }, [pinchHint]);

  const isPinchMode = useRef(false);
  const isOptionHeld = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const lastMoveSentAt = useRef(0);

  // Cursor overlay (imperative — avoids re-renders on every mousemove)
  const liveCursorRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const cursorStateRef = useRef<'idle' | 'down' | 'release'>('idle');
  const releaseAnimRef = useRef<{ startTime: number } | null>(null);
  // In skin mode the cursor div lives in the outer composite wrapper; compositeWrapperRef tracks it.
  const compositeWrapperRef = useRef<HTMLDivElement>(null);
  const coordNeedsRotationRef = useRef(false);
  const hasSkinRef = useRef(false);

  // ── WebGL init + H264Decoder lifecycle ───────────────────────────────────
  useEffect(() => {
    const ok = glInit()
    if (!ok) { setGlError(true); return }

    const decoder = new H264Decoder((frame) => {
      const size = glDrawFrame(frame)
      if (!size) return
      frameCount.current += 1
      setCanvasReady(true)
      const prev = videoSizeRef.current
      if (!prev || prev.width !== size.width || prev.height !== size.height) {
        videoSizeRef.current = size
        setVideoSize(size)
      }
    })

    binaryFrameHandlerRef.current = (data) => decoder.decode(data)

    return () => {
      binaryFrameHandlerRef.current = undefined
      decoder.close()
      glDispose()
    }
  }, [glInit, glDispose, glDrawFrame, frameCount, binaryFrameHandlerRef])

  // ── Recording (composeFrame only — state/refs/lifecycle in useClientRecording) ──
  const composeFrame = useCallback(() => {
    const rc = recordCanvasRef.current; const fc = canvasRef.current
    if (!rc || !fc) return
    const ctx = rc.getContext('2d')
    if (!ctx) return

    ctx.drawImage(fc, 0, 0, rc.width, rc.height)

    // Draw overlays in CSS pixel space so coordinates/radii match the display
    const dpr = window.devicePixelRatio || 1
    const cssW = rc.width / dpr; const cssH = rc.height / dpr
    ctx.save()
    ctx.scale(dpr, dpr)

    const ph = pinchHintRef.current
    if (ph) {
      for (const f of [ph.f0, ph.f1]) {
        const cx = f.x * cssW; const cy = f.y * cssH
        if (isPinchMode.current) {
          ctx.beginPath(); ctx.arc(cx, cy, CURSOR_DOT_R, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill()
          ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; ctx.stroke()
        } else {
          ctx.beginPath(); ctx.arc(cx, cy, CURSOR_RING_R, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3; ctx.stroke()
          ctx.beginPath(); ctx.arc(cx, cy, CURSOR_RING_R, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.5; ctx.stroke()
        }
      }
    }

    const cp = cursorPosRef.current
    if (cp) {
      const state = cursorStateRef.current; const ra = releaseAnimRef.current
      if (state === 'down') {
        ctx.beginPath(); ctx.arc(cp.x, cp.y, CURSOR_DOT_R, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; ctx.stroke()
      } else if (state === 'release' && ra) {
        const t = Math.min((performance.now() - ra.startTime) / 350, 1)
        ctx.beginPath(); ctx.arc(cp.x, cp.y, CURSOR_DOT_R + 26 * t, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.55})`; ctx.lineWidth = 1.5; ctx.stroke()
        if (t >= 1) { cursorStateRef.current = 'idle'; releaseAnimRef.current = null }
      } else {
        ctx.beginPath(); ctx.arc(cp.x, cp.y, CURSOR_RING_R, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3; ctx.stroke()
        ctx.beginPath(); ctx.arc(cp.x, cp.y, CURSOR_RING_R, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }

    ctx.restore()
  }, [])

  // ── Keyboard forwarding ───────────────────────────────────────────────────
  useEffect(() => {
    const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'])
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') { isOptionHeld.current = true; return }
      if (!keyboardActive) return
      if (MODIFIER_CODES.has(e.code)) return
      e.preventDefault()
      const modifiers = (e.shiftKey ? 0x02 : 0) | (e.ctrlKey ? 0x01 : 0) | (e.metaKey ? 0x08 : 0)
      send({ type: 'input:key', sessionId, payload: { code: e.code, modifiers } })
    }
    const endPinch = () => {
      if (isPinchMode.current) {
        isPinchMode.current = false; setPinchActive(false); send({ type: 'input:pinch:end', sessionId })
      }
      isOptionHeld.current = false; setPinchHint(null)
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'AltLeft' || e.code === 'AltRight') endPinch() }
    const onBlur = () => { if (isOptionHeld.current) endPinch() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [keyboardActive, send, sessionId])

  useEffect(() => {
    if (!keyboardActive) return
    const onDown = (e: PointerEvent) => {
      const area = containerRef.current ?? canvasRef.current
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [keyboardActive])

  // ── Pointer interaction ───────────────────────────────────────────────────
  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return toNormPure({ x: e.clientX, y: e.clientY }, rect, coordNeedsRotationRef.current)
  }, [])

  const toPinchFingers = useCallback((e: { clientX: number; clientY: number }) => {
    const f1 = toNorm(e)
    if (!f1) return null
    return makePinchFingers(f1)
  }, [toNorm])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (isOptionHeld.current) {
      const fingers = toPinchFingers(e)
      if (!fingers) return
      isPinchMode.current = true; setPinchActive(true)
      ;(e.target as Element).setPointerCapture(e.pointerId)
      const _lc = liveCursorRef.current; if (_lc) _lc.style.display = 'none'
      setPinchHint(fingers)
      send({ type: 'input:pinch:start', sessionId, payload: fingers })
      return
    }
    const pos = toNorm(e)
    if (!pos) return
    setKeyboardActive(true)
    touchStartPos.current = pos
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const _rect = (e.currentTarget as Element).getBoundingClientRect()
    cursorPosRef.current = { x: e.clientX - _rect.left, y: e.clientY - _rect.top }
    cursorStateRef.current = 'down'; releaseAnimRef.current = null
    const _lc = liveCursorRef.current
    if (_lc) {
      const _pr = (hasSkinRef.current ? compositeWrapperRef : containerRef).current?.getBoundingClientRect()
      _lc.style.display = 'block'
      if (_pr) { _lc.style.left = `${e.clientX - _pr.left}px`; _lc.style.top = `${e.clientY - _pr.top}px` }
      _lc.style.width = `${CURSOR_DOT_R * 2}px`; _lc.style.height = `${CURSOR_DOT_R * 2}px`
      _lc.style.background = 'rgba(255,255,255,0.92)'; _lc.style.border = '1.5px solid rgba(0,0,0,0.2)'
      _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.15), 0 0 8px rgba(255,255,255,0.25)'
    }
    send({ type: 'input:touch:start', sessionId, payload: pos })
  }, [toNorm, toPinchFingers, send, sessionId])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.buttons === 0) {
      if (isOptionHeld.current) {
        setPinchHint(toPinchFingers(e)); cursorPosRef.current = null
        const _lc = liveCursorRef.current; if (_lc) _lc.style.display = 'none'
        return
      }
      const norm = toNorm(e)
      const _r = (e.currentTarget as Element).getBoundingClientRect()
      const _lc = liveCursorRef.current
      if (norm) {
        cursorPosRef.current = { x: e.clientX - _r.left, y: e.clientY - _r.top }
        if (cursorStateRef.current !== 'down') cursorStateRef.current = 'idle'
        if (_lc) {
          const _pr = (hasSkinRef.current ? compositeWrapperRef : containerRef).current?.getBoundingClientRect()
          _lc.style.display = 'block'
          if (_pr) { _lc.style.left = `${e.clientX - _pr.left}px`; _lc.style.top = `${e.clientY - _pr.top}px` }
          _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`
          _lc.style.background = 'transparent'; _lc.style.border = '1.5px solid rgba(255,255,255,0.6)'
          _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)'
        }
      } else {
        cursorPosRef.current = null
        if (_lc) _lc.style.display = 'none'
      }
      return
    }
    if (isPinchMode.current) {
      const fingers = toPinchFingers(e)
      if (!fingers) return
      const now = performance.now()
      if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
      lastMoveSentAt.current = now
      setPinchHint(fingers); send({ type: 'input:pinch:move', sessionId, payload: fingers })
      return
    }
    if (!touchStartPos.current) return
    const pos = toNorm(e)
    if (!pos) return
    const dx = pos.x - touchStartPos.current.x; const dy = pos.y - touchStartPos.current.y
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
    const now = performance.now()
    if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
    lastMoveSentAt.current = now
    const _r = (e.currentTarget as Element).getBoundingClientRect()
    cursorPosRef.current = { x: e.clientX - _r.left, y: e.clientY - _r.top }
    const _lc = liveCursorRef.current
    if (_lc && _lc.style.display !== 'none') {
      const _pr = (hasSkinRef.current ? compositeWrapperRef : containerRef).current?.getBoundingClientRect()
      if (_pr) { _lc.style.left = `${e.clientX - _pr.left}px`; _lc.style.top = `${e.clientY - _pr.top}px` }
    }
    send({ type: 'input:touch:move', sessionId, payload: pos })
  }, [toNorm, toPinchFingers, send, sessionId])

  const handlePointerUp = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null)
      send({ type: 'input:pinch:end', sessionId }); return
    }
    touchStartPos.current = null
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    const _lc = liveCursorRef.current
    if (_lc) {
      _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`
      _lc.style.background = 'transparent'; _lc.style.border = '1.5px solid rgba(255,255,255,0.6)'
      _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)'
    }
    send({ type: 'input:touch:end', sessionId })
  }, [send, sessionId])

  const handlePointerCancel = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null)
      send({ type: 'input:pinch:end', sessionId }); return
    }
    touchStartPos.current = null
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    send({ type: 'input:touch:end', sessionId })
  }, [send, sessionId])

  const handlePointerLeave = useCallback(() => {
    setPinchHint(null)
    cursorPosRef.current = null
    const _lc = liveCursorRef.current
    if (_lc) _lc.style.display = 'none'
  }, [])

  // ── Layout ────────────────────────────────────────────────────────────────
  const hasSkin = Boolean(skinBackPng && skinScreenRect && skinCompositeSize);

  // Skin mode: scale composite so its longest side fits MAX_ANDROID_LONG
  const skinScale = hasSkin
    ? Math.min(1, MAX_ANDROID_LONG / Math.max(skinCompositeSize!.width, skinCompositeSize!.height))
    : 0;
  const compositeDisplayW = hasSkin ? Math.round(skinCompositeSize!.width * skinScale) : 0;
  const compositeDisplayH = hasSkin ? Math.round(skinCompositeSize!.height * skinScale) : 0;

  // Fallback (no-skin) mode: scale by longest screen side
  const effectiveSize = videoSize ?? (screenWidth && screenHeight ? { width: screenWidth, height: screenHeight } : null);
  const androidScale = effectiveSize
    ? Math.min(1, MAX_ANDROID_LONG / Math.max(effectiveSize.width, effectiveSize.height))
    : 0.3;
  const androidDisplayW = effectiveSize ? Math.round(effectiveSize.width * androidScale) : 324;
  const androidDisplayH = effectiveSize ? Math.round(effectiveSize.height * androidScale) : 720;

  const isLandscapeDevice = deviceRotation === 1 || deviceRotation === 3;
  const isLandscapeContent = effectiveSize ? effectiveSize.width > effectiveSize.height : false;
  // Stream is locked portrait by scrcpy capture_orientation=@0, so skin and no-skin both use
  // isLandscapeDevice to drive CSS rotation — same as iOS pattern.
  const skinIsLandscape = hasSkin && isLandscapeDevice;
  const needsCSSRotation = !hasSkin && isLandscapeDevice && !isLandscapeContent;
  // Both skin landscape and no-skin CSS-rotate the canvas 90° CW → same coordinate correction.
  const coordNeedsRotation = needsCSSRotation || skinIsLandscape;
  useLayoutEffect(() => {
    coordNeedsRotationRef.current = coordNeedsRotation;
    hasSkinRef.current = hasSkin;
  }, [coordNeedsRotation, hasSkin])

  // Skin: percentage-based screen position — scales with compositeDisplay dims automatically.
  const screenPctLeft = hasSkin ? (skinScreenRect!.x / skinCompositeSize!.width) * 100 : 0;
  const screenPctTop  = hasSkin ? (skinScreenRect!.y / skinCompositeSize!.height) * 100 : 0;
  const screenPctW    = hasSkin ? (skinScreenRect!.width  / skinCompositeSize!.width) * 100 : 0;
  const screenPctH    = hasSkin ? (skinScreenRect!.height / skinCompositeSize!.height) * 100 : 0;
  const hasMask = hasSkin && Boolean(skinMaskPng);

  // Container uses landscape dims; canvas inside rotated 90° to show portrait content in landscape shell
  const containerW = needsCSSRotation ? androidDisplayH : androidDisplayW;
  const containerH = needsCSSRotation ? androidDisplayW : androidDisplayH;
  const rotatedCanvasStyle: React.CSSProperties = needsCSSRotation ? {
    position: 'absolute',
    width: androidDisplayW,
    height: androidDisplayH,
    top: (androidDisplayW - androidDisplayH) / 2,
    left: (androidDisplayH - androidDisplayW) / 2,
    transform: 'rotate(90deg)',
    transformOrigin: 'center center',
    visibility: canvasReady ? 'visible' : 'hidden',
    cursor: 'none',
  } : {
    visibility: canvasReady ? 'visible' : 'hidden',
    cursor: 'none',
  };

  const navButtons = androidButtons ?? []

  const sendButton = (name: string) => {
    send({ type: 'input:button', sessionId, payload: { name } })
    setPressedButton(name)
    setTimeout(() => setPressedButton(null), 150)
  }

  const btnIcon = (name: string) =>
    name === 'back' ? <ArrowLeft className="h-4 w-4" />
    : name === 'recent_apps' ? <LayoutGrid className="h-4 w-4" />
    : name === 'volume_up' ? <Volume2 className="h-4 w-4" />
    : name === 'volume_down' ? <Volume1 className="h-4 w-4" />
    : name === 'power' ? <Power className="h-4 w-4" />
    : <Home className="h-4 w-4" />

  const toolbarButtons = navButtons

  const platformSlot = (
    <>
      {toolbarButtons.map((btn) => (
        <Tooltip key={btn.name}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8"
              onClick={() => sendButton(btn.name)}
            >
              {btnIcon(btn.name)}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{btn.accessibilityTitle}</TooltipContent>
        </Tooltip>
      ))}
    </>
  );

  const launchSlot = installed && buildId ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={launching || installing}
          onClick={() => { setLaunching(true); send({ type: 'app:launch', sessionId, buildId }) }}
        >
          {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {launching ? 'Launching…' : installing ? 'Installing…' : 'Launch app'}
      </TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className="flex items-start justify-center gap-16">
      <canvas ref={recordCanvasRef} style={{ display: 'none' }} />
      <SimulatorToolbar
        joined={joined}
        onScreenshot={() => {
          const src = canvasRef.current; if (!src) return
          const c = document.createElement('canvas'); const ctx = c.getContext('2d'); if (!ctx) return
          c.width = src.width; c.height = src.height; ctx.drawImage(src, 0, 0)
          c.toBlob((blob) => {
            if (!blob) return
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a'); a.href = url; a.download = `tapflow-${Date.now()}.png`; a.click()
            URL.revokeObjectURL(url)
          }, 'image/png')
        }}
        onRecordToggle={() => {
          if (recordState === 'idle') {
            const rc = recordCanvasRef.current; if (!rc) return
            const dpr = window.devicePixelRatio || 1
            const container = containerRef.current
            if (container && container.clientWidth > 0) { rc.width = container.clientWidth * dpr; rc.height = container.clientHeight * dpr }
            else { const fc = canvasRef.current; if (fc && fc.width > 0) { rc.width = fc.width; rc.height = fc.height } else return }
            startClientRecording(composeFrame)
          } else if (recordState === 'recording') {
            stopClientRecording()
          }
        }}
        recordState={recordState}
        onRotate={() => send({ type: 'input:rotate', sessionId })}
        platformSlot={platformSlot}
        launchSlot={launchSlot}
      />

      <div className="flex items-start gap-8">
        {hasSkin ? (
          // ── Skin mode: iOS-pattern — whole composite rotates as one unit ──
          // Outer div: non-rotating, swaps W/H for landscape to occupy correct visual space.
          // Inner div: CSS rotate(90deg) CW in landscape — same direction as no-skin canvas rotation.
          // Canvas: percent-based position within inner div; no coordinate re-calculation on rotation.
          <div
            ref={compositeWrapperRef}
            style={{
              position: 'relative', flexShrink: 0,
              width: skinIsLandscape ? compositeDisplayH : compositeDisplayW,
              height: skinIsLandscape ? compositeDisplayW : compositeDisplayH,
            }}
          >
            <div
              style={{
                width: compositeDisplayW, height: compositeDisplayH,
                position: 'relative',
                ...(skinIsLandscape ? {
                  position: 'absolute',
                  top:  (compositeDisplayW - compositeDisplayH) / 2,
                  left: (compositeDisplayH - compositeDisplayW) / 2,
                  transform: 'rotate(90deg)', transformOrigin: 'center center',
                } : {}),
              }}
            >
              {/* back.webp background — fills composite, screen interior is transparent */}
              <img
                src={`data:image/webp;base64,${skinBackPng}`}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', userSelect: 'none', display: 'block' }}
                alt="" draggable={false}
              />
              {glError ? (
                <div className="absolute" style={{ left: `${screenPctLeft}%`, top: `${screenPctTop}%`, width: `${screenPctW}%`, height: `${screenPctH}%`, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#010101' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>WebGL2 not supported</span>
                </div>
              ) : (
                <>
                  <canvas
                    ref={canvasRef}
                    style={{
                      position: 'absolute',
                      left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                      width: `${screenPctW}%`, height: `${screenPctH}%`,
                      visibility: canvasReady ? 'visible' : 'hidden',
                      cursor: 'none', backgroundColor: '#010101',
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onPointerLeave={handlePointerLeave}
                  />
                  {!canvasReady && (
                    <div className="absolute animate-pulse bg-zinc-700" style={{ left: `${screenPctLeft}%`, top: `${screenPctTop}%`, width: `${screenPctW}%`, height: `${screenPctH}%` }} />
                  )}
                  {!canvasReady && deviceReady && (
                    <div className="absolute pointer-events-none" style={{ left: `${screenPctLeft}%`, top: `${screenPctTop}%`, width: `${screenPctW}%`, height: `${screenPctH}%`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>Waiting for stream…</span>
                    </div>
                  )}
                  {pinchHint && (
                    <>
                      {([pinchHint.f0, pinchHint.f1] as const).map((f, i) => (
                        <div key={i} style={{
                          position: 'absolute', zIndex: 10, borderRadius: '50%',
                          transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                          transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease',
                          left: `${screenPctLeft + f.x * screenPctW}%`, top: `${screenPctTop + f.y * screenPctH}%`,
                          ...(pinchActive
                            ? { width: CURSOR_DOT_R * 2, height: CURSOR_DOT_R * 2, background: 'rgba(255,255,255,0.92)', border: '1.5px solid rgba(0,0,0,0.2)', boxShadow: '0 0 0 1px rgba(0,0,0,0.15), 0 0 8px rgba(255,255,255,0.25)' }
                            : { width: CURSOR_RING_R * 2, height: CURSOR_RING_R * 2, background: 'transparent', border: '1.5px solid rgba(255,255,255,0.6)', boxShadow: '0 0 0 1px rgba(0,0,0,0.3)' }),
                        }} />
                      ))}
                    </>
                  )}
                </>
              )}
              {/* mask.webp: display-sized alpha overlay — opaque bezel masks canvas corners precisely */}
              {/* fallback: second back.webp for skins without mask.webp */}
              {hasMask ? (
                <img
                  src={`data:image/webp;base64,${skinMaskPng}`}
                  style={{ position: 'absolute', left: `${screenPctLeft}%`, top: `${screenPctTop}%`, width: `${screenPctW}%`, height: `${screenPctH}%`, pointerEvents: 'none', userSelect: 'none', display: 'block', zIndex: 5 }}
                  alt="" draggable={false}
                />
              ) : (
                <img
                  src={`data:image/webp;base64,${skinBackPng}`}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', userSelect: 'none', display: 'block', zIndex: 5 }}
                  alt="" draggable={false}
                />
              )}
            </div>
            {/* cursor — in outer non-rotating div so position maps directly to client coords */}
            <div ref={liveCursorRef} style={{ display: 'none', position: 'absolute', zIndex: 15, borderRadius: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none', transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease, box-shadow 0.1s ease' }} />
          </div>
        ) : (
          // ── Fallback: CSS bezel ───────────────────────────────────────────
          <div style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px', flexShrink: 0, boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}>
          <div
            ref={containerRef}
            className="relative"
            style={{ width: containerW, height: containerH, backgroundColor: '#010101', borderRadius: '22px', overflow: 'hidden' }}
          >
            {glError ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>WebGL2 not supported</span>
              </div>
            ) : (
              <>
                <canvas
                  ref={canvasRef}
                  className={needsCSSRotation ? undefined : 'block w-full h-full'}
                  style={rotatedCanvasStyle}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onPointerLeave={handlePointerLeave}
                />
                {!canvasReady && (
                  <div className="absolute inset-0 animate-pulse bg-zinc-700" />
                )}
                {!canvasReady && deviceReady && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>Waiting for stream…</span>
                  </div>
                )}
                <div
                  ref={liveCursorRef}
                  style={{
                    display: 'none', position: 'absolute', zIndex: 20, borderRadius: '50%',
                    transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                    transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease, box-shadow 0.1s ease',
                  }}
                />
                {pinchHint && (
                  <>
                    {([pinchHint.f0, pinchHint.f1] as const).map((f, i) => (
                      <div key={i} style={{
                        position: 'absolute', zIndex: 10, borderRadius: '50%',
                        transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                        transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease',
                        left: `${f.x * 100}%`, top: `${f.y * 100}%`,
                        ...(pinchActive
                          ? { width: CURSOR_DOT_R * 2, height: CURSOR_DOT_R * 2, background: 'rgba(255,255,255,0.92)', border: '1.5px solid rgba(0,0,0,0.2)', boxShadow: '0 0 0 1px rgba(0,0,0,0.15), 0 0 8px rgba(255,255,255,0.25)' }
                          : { width: CURSOR_RING_R * 2, height: CURSOR_RING_R * 2, background: 'transparent', border: '1.5px solid rgba(255,255,255,0.6)', boxShadow: '0 0 0 1px rgba(0,0,0,0.3)' }),
                      }} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
          </div>
        )}{/* /device frame */}

        <SimulatorInfoCard
          joined={joined} fps={fps} connected={connected}
          deviceReady={deviceReady} bootError={bootError}
          installing={installing} installError={installError}
          keyboardActive={keyboardActive}
        />
      </div>
    </div>
  );
}
