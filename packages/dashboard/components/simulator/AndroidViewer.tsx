'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Home, Keyboard, LayoutGrid, Loader2, Play, Power, Volume1, Volume2 } from 'lucide-react';
import { H264Decoder } from '@/lib/H264Decoder';
import { useWebGLRenderer } from '@/lib/WebGLVideoRenderer';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AndroidButton } from '@/lib/types';

const CURSOR_RING_R = 13;
const CURSOR_DOT_R = 8;
const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;
const MAX_ANDROID_H = 700;

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
  binaryFrameHandlerRef: React.MutableRefObject<((data: ArrayBuffer) => void) | undefined>;
  onRecordingUploaded?: () => void;
}

export function AndroidViewer({
  sessionId, buildId, send, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, setLaunching, androidButtons,
  binaryFrameHandlerRef, onRecordingUploaded,
}: AndroidViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glRenderer = useWebGLRenderer(canvasRef);
  const { fps, frameCount } = useFps();

  const [canvasReady, setCanvasReady] = useState(false);
  const [glError, setGlError] = useState(false);
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

  // ── WebGL init + H264Decoder lifecycle ───────────────────────────────────
  useEffect(() => {
    const ok = glRenderer.init()
    if (!ok) { setGlError(true); return }

    const decoder = new H264Decoder((frame) => {
      const size = glRenderer.drawFrame(frame)
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
      glRenderer.dispose()
    }
  }, [glRenderer, frameCount, binaryFrameHandlerRef])

  // ── Recording ─────────────────────────────────────────────────────────────
  const [recordState, setRecordState] = useState<'idle' | 'recording' | 'uploading' | 'done'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordMimeRef = useRef('');

  const startClientRecording = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    if (!mime) { console.error('[record] no supported codec'); return }
    recordMimeRef.current = mime
    recordChunksRef.current = []
    const mr = new MediaRecorder(canvas.captureStream(30), { mimeType: mime })
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data) }
    mediaRecorderRef.current = mr
    mr.start(1000)
    setRecordState('recording')
  }, [])

  const stopClientRecording = useCallback(async () => {
    setRecordState('uploading')
    const mr = mediaRecorderRef.current
    if (!mr) return
    await new Promise<void>((resolve) => { mr.onstop = () => resolve(); mr.stop() })
    mediaRecorderRef.current = null

    const mime = recordMimeRef.current
    const ext = mime.includes('mp4') ? '.mp4' : '.webm'
    const blob = new Blob(recordChunksRef.current, { type: mime })
    recordChunksRef.current = []

    const formData = new FormData()
    formData.append('file', blob, `tapflow-${Date.now()}${ext}`)
    try {
      const params = new URLSearchParams({ sessionId })
      if (buildId) params.set('buildId', String(buildId))
      const res = await fetch(`/api/v1/recordings/upload?${params}`, { method: 'POST', credentials: 'include', body: formData })
      const json = await res.json() as { url?: string }
      if (res.ok && json.url) {
        const a = document.createElement('a'); a.href = json.url; a.download = ''; a.click()
        onRecordingUploaded?.()
        setRecordState('done')
        setTimeout(() => setRecordState('idle'), 2000)
      } else { setRecordState('idle') }
    } catch { setRecordState('idle') }
  }, [sessionId, buildId, onRecordingUploaded])

  useEffect(() => {
    if (recordState !== 'recording') return
    const onVisibility = () => { if (document.visibilityState === 'hidden') stopClientRecording() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [recordState, stopClientRecording])

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
      const area = containerRef.current
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
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
  }, [])

  const toPinchFingers = useCallback((e: { clientX: number; clientY: number }) => {
    const f1 = toNorm(e)
    if (!f1) return null
    return { f0: { x: 1 - f1.x, y: 1 - f1.y }, f1 }
  }, [toNorm])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setKeyboardActive(true)
    if (isOptionHeld.current) {
      const fingers = toPinchFingers(e)
      if (!fingers) return
      isPinchMode.current = true; setPinchActive(true)
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setPinchHint(fingers)
      send({ type: 'input:pinch:start', sessionId, payload: fingers })
      return
    }
    const pos = toNorm(e)
    if (!pos) return
    touchStartPos.current = pos
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const _rect = (e.currentTarget as Element).getBoundingClientRect()
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
        setPinchHint(toPinchFingers(e)); return
      }
      const norm = toNorm(e)
      const _lc = liveCursorRef.current
      if (_lc) {
        if (norm) {
          const _r = (e.currentTarget as Element).getBoundingClientRect()
          _lc.style.display = 'block'
          _lc.style.left = `${e.clientX - _r.left}px`; _lc.style.top = `${e.clientY - _r.top}px`
          _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`
          _lc.style.background = 'transparent'; _lc.style.border = '1.5px solid rgba(255,255,255,0.6)'
          _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)'
        } else { _lc.style.display = 'none' }
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
    const _lc = liveCursorRef.current
    if (_lc && _lc.style.display !== 'none') {
      const _r = (e.currentTarget as Element).getBoundingClientRect()
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
    send({ type: 'input:touch:end', sessionId })
  }, [send, sessionId])

  const handlePointerLeave = useCallback(() => {
    setPinchHint(null)
    const _lc = liveCursorRef.current
    if (_lc) _lc.style.display = 'none'
  }, [])

  // ── Layout ────────────────────────────────────────────────────────────────
  const androidScale = videoSize ? Math.min(1, MAX_ANDROID_H / videoSize.height) : 1;
  const androidDisplayW = videoSize ? Math.round(videoSize.width * androidScale) : 300;
  const androidDisplayH = videoSize ? Math.round(videoSize.height * androidScale) : 560;

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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"
            onClick={() => send({ type: 'input:keyboard:toggle', sessionId })}
          >
            <Keyboard className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Keyboard</TooltipContent>
      </Tooltip>
    </>
  );

  const launchSlot = installed && buildId ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={launching}
          onClick={() => { setLaunching(true); send({ type: 'app:launch', sessionId, buildId }) }}
        >
          {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{launching ? 'Launching…' : 'Launch app'}</TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className="flex items-start justify-center gap-16">
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
        onRecordToggle={() => { if (recordState === 'idle') startClientRecording(); else if (recordState === 'recording') stopClientRecording() }}
        recordState={recordState}
        onRotate={() => send({ type: 'input:rotate', sessionId })}
        platformSlot={platformSlot}
        launchSlot={launchSlot}
      />

      <div className="flex items-start gap-8">
        <div
          ref={containerRef}
          className="relative"
          style={{ width: androidDisplayW, height: androidDisplayH, backgroundColor: '#010101', borderRadius: '28px', flexShrink: 0 }}
        >
          {glError ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>WebGL2 not supported</span>
            </div>
          ) : (
            <>
              <canvas
                ref={canvasRef}
                className="block w-full h-full"
                style={{ borderRadius: '28px', visibility: canvasReady ? 'visible' : 'hidden', cursor: 'none' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onPointerLeave={handlePointerLeave}
              />
              {!canvasReady && (
                <div className="absolute inset-0 animate-pulse bg-zinc-800" style={{ borderRadius: '28px' }} />
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
