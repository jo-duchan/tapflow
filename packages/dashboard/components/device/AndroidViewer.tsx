'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { ArrowLeft, Home, LayoutGrid, Loader2, Play, Power, Volume1, Volume2 } from 'lucide-react';
import { pickDecoder } from '@/lib/decoders/pickDecoder';
import { createJMuxer } from '@/lib/decoders/createJMuxer';
import type { Decoder } from '@/lib/decoders/types';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { DeepLinkDialog } from './DeepLinkDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AndroidButton } from '@/lib/types'
import type { BinaryFrameHandler } from '@/lib/envelope'
import { androidToNorm as toNormPure, toPinchFingers as makePinchFingers } from '@/lib/coordinate-transform';
import type { MutableRefObject } from 'react';
import type { PerfHook } from '@/components/perf/types';

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
  binaryFrameHandlerRef: React.RefObject<BinaryFrameHandler | undefined>;
  onRecordingUploaded?: () => void;
  screenWidth?: number;
  screenHeight?: number;
  deviceRotation?: number;
  perfHookRef?: MutableRefObject<PerfHook>;
}

export function AndroidViewer({
  sessionId, buildId, send, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, setLaunching, androidButtons,
  binaryFrameHandlerRef, onRecordingUploaded,
  screenWidth, screenHeight, deviceRotation = 0,
  perfHookRef,
}: AndroidViewerProps) {
  const surfaceHostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const decoderRef = useRef<Decoder | null>(null);
  const { fps, frameCount } = useFps();
  const { recordState, recordCanvasRef, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });

  const [deepLinkOpen, setDeepLinkOpen] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [decoderUnsupported, setDecoderUnsupported] = useState(false);
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

  // ── Decoder init + surface mount ──────────────────────────────────────────
  // pickDecoder selects WebCodecs (secure context) or MSE (plain HTTP/LAN). Each
  // decoder owns its render surface (canvas vs video), mounted into the host div.
  useEffect(() => {
    const decoder = pickDecoder(createJMuxer)
    if (!decoder) { setDecoderUnsupported(true); return }
    decoderRef.current = decoder

    const surface = decoder.surface
    surface.style.display = 'block'
    surface.style.width = '100%'
    surface.style.height = '100%'
    surface.style.objectFit = 'fill'
    surfaceHostRef.current?.appendChild(surface)

    decoder.onResize((size) => {
      setCanvasReady(true)
      const prev = videoSizeRef.current
      if (!prev || prev.width !== size.width || prev.height !== size.height) {
        videoSizeRef.current = size
        setVideoSize(size)
      }
    })

    binaryFrameHandlerRef.current = (data) => {
      if (import.meta.env.DEV) perfHookRef?.current?.onFrameBegin()
      frameCount.current += 1
      decoder.decode(data)
    }

    return () => {
      binaryFrameHandlerRef.current = undefined
      decoder.close()
      surface.remove()
      decoderRef.current = null
    }
  }, [frameCount, binaryFrameHandlerRef, perfHookRef])

  // ── Recording (composeFrame only — state/refs/lifecycle in useClientRecording) ──
  const composeFrame = useCallback(() => {
    const rc = recordCanvasRef.current; const fc = decoderRef.current?.surface
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

  const handleScreenshot = useCallback(() => {
    const src = decoderRef.current?.surface; const size = videoSizeRef.current
    if (!src || !size) return
    const c = document.createElement('canvas'); const ctx = c.getContext('2d'); if (!ctx) return
    c.width = size.width; c.height = size.height; ctx.drawImage(src, 0, 0, size.width, size.height)
    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `tapflow-${Date.now()}.png`; a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [])

  const handleRecordToggle = useCallback(() => {
    if (recordState === 'idle') {
      const rc = recordCanvasRef.current; if (!rc) return
      const dpr = window.devicePixelRatio || 1
      const container = containerRef.current
      if (container && container.clientWidth > 0) { rc.width = container.clientWidth * dpr; rc.height = container.clientHeight * dpr }
      else { const size = videoSizeRef.current; if (size) { rc.width = size.width; rc.height = size.height } else return }
      startClientRecording(composeFrame)
    } else if (recordState === 'recording') {
      stopClientRecording()
    }
  }, [recordState, startClientRecording, stopClientRecording, composeFrame])

  const handleRotate = useCallback(() => {
    send({ type: 'input:rotate', sessionId })
  }, [send, sessionId])

  // ── Keyboard forwarding ───────────────────────────────────────────────────
  useEffect(() => {
    const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'])
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') { isOptionHeld.current = true; return }
      if (e.metaKey) {
        const el = document.activeElement
        if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
          if (!e.shiftKey && e.code === 'KeyK') { e.preventDefault(); setDeepLinkOpen(true); return }
          if (!e.shiftKey && e.code === 'KeyS') { e.preventDefault(); handleScreenshot(); return }
          if (e.shiftKey && e.code === 'KeyY') { e.preventDefault(); handleRecordToggle(); return }
          if (e.shiftKey && e.code === 'KeyO') { e.preventDefault(); handleRotate(); return }
        }
      }
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
  }, [keyboardActive, send, sessionId, handleScreenshot, handleRecordToggle, handleRotate])

  useEffect(() => {
    if (!keyboardActive) return
    const onDown = (e: PointerEvent) => {
      const area = containerRef.current ?? surfaceHostRef.current
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [keyboardActive])

  // ── Pointer interaction ───────────────────────────────────────────────────
  const needsCSSRotationRef = useRef(false)

  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const host = surfaceHostRef.current
    if (!host) return null
    const rect = host.getBoundingClientRect()
    return toNormPure({ x: e.clientX, y: e.clientY }, rect, needsCSSRotationRef.current)
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
      _lc.style.display = 'block'
      _lc.style.left = `${e.clientX - _rect.left}px`; _lc.style.top = `${e.clientY - _rect.top}px`
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
          _lc.style.display = 'block'
          _lc.style.left = `${e.clientX - _r.left}px`; _lc.style.top = `${e.clientY - _r.top}px`
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
      _lc.style.left = `${e.clientX - _r.left}px`; _lc.style.top = `${e.clientY - _r.top}px`
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
  // Scale by longest side so portrait and landscape stay the same physical size on screen
  const effectiveSize = videoSize ?? (screenWidth && screenHeight ? { width: screenWidth, height: screenHeight } : null);
  const androidScale = effectiveSize
    ? Math.min(1, MAX_ANDROID_LONG / Math.max(effectiveSize.width, effectiveSize.height))
    : 0.3;
  const androidDisplayW = effectiveSize ? Math.round(effectiveSize.width * androidScale) : 324;
  const androidDisplayH = effectiveSize ? Math.round(effectiveSize.height * androidScale) : 720;

  // CSS rotation: applied when device is landscape but video content is portrait (portrait-locked app).
  // Matches native Android emulator behavior — chrome rotates even when app content stays portrait.
  const isLandscapeDevice = deviceRotation === 1 || deviceRotation === 3;
  const isLandscapeContent = effectiveSize ? effectiveSize.width > effectiveSize.height : false;
  const needsCSSRotation = isLandscapeDevice && !isLandscapeContent;
  useLayoutEffect(() => { needsCSSRotationRef.current = needsCSSRotation }, [needsCSSRotation])
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

  const platformSlot = (
    <>
      {androidButtons?.map((btn) => (
        <Tooltip key={btn.name}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8"
              onClick={() => send({ type: 'input:button', sessionId, payload: { name: btn.name } })}
            >
              {btn.name === 'back' ? <ArrowLeft className="h-4 w-4" />
                : btn.name === 'recent_apps' ? <LayoutGrid className="h-4 w-4" />
                : btn.name === 'volume_up' ? <Volume2 className="h-4 w-4" />
                : btn.name === 'volume_down' ? <Volume1 className="h-4 w-4" />
                : btn.name === 'power' ? <Power className="h-4 w-4" />
                : <Home className="h-4 w-4" />}
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
      <DeepLinkDialog open={deepLinkOpen} onOpenChange={setDeepLinkOpen} sessionId={sessionId} send={send} />

      <SimulatorToolbar
        joined={joined}
        onDeepLink={() => setDeepLinkOpen(true)}
        onScreenshot={handleScreenshot}
        onRecordToggle={handleRecordToggle}
        recordState={recordState}
        onRotate={handleRotate}
        platformSlot={platformSlot}
        launchSlot={launchSlot}
      />

      <div className="flex items-start gap-8">
        {/* phone body bezel */}
        <div style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px', flexShrink: 0, boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}>
        <div
          ref={containerRef}
          className="relative"
          style={{ width: containerW, height: containerH, backgroundColor: '#010101', borderRadius: '22px', overflow: 'hidden' }}
        >
          {decoderUnsupported ? (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>
                이 환경에서는 스트리밍을 표시할 수 없습니다.<br />Chrome/Edge 또는 HTTPS 환경에서 다시 시도해 주세요.
              </span>
            </div>
          ) : (
            <>
              <div
                ref={surfaceHostRef}
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
        </div>{/* /phone body bezel */}

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
