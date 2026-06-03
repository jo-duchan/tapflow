'use client';

import { useCallback, useEffect, useRef, useState, Fragment } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { Home, Keyboard, Loader2, Play } from 'lucide-react';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { DeepLinkDialog } from './DeepLinkDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import type { ChromeData } from '@/lib/types'
import { iosToNormScreen, toPinchFingers as makePinchFingers, iosDisplayScale } from '@/lib/coordinate-transform';
import { pickDecoder } from '@/lib/decoders/pickDecoder';
import type { Decoder } from '@/lib/decoders/types';
import { WASMDecoder } from '@/lib/decoders/WASMDecoder';
import { CODEC_H264, type BinaryFrameHandler } from '@/lib/envelope';
import { FrameLatencyTracker } from '@/components/perf/FrameLatencyTracker';
import type { MutableRefObject } from 'react';
import type { PerfHook } from '@/components/perf/types';

const CURSOR_RING_R = 13;
const CURSOR_DOT_R = 8;
const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;
const BUTTON_HIT_RADIUS = 100;

interface IOSViewerProps {
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
  chrome: ChromeData;
  binaryFrameHandlerRef: React.MutableRefObject<BinaryFrameHandler | undefined>;
  onRecordingUploaded?: () => void;
  swKeyboardVisible: boolean;
  swKeyboardPending: boolean;
  onKbdToggle: () => void;
  perfHookRef?: MutableRefObject<PerfHook>;
}

export function IOSViewer({
  sessionId, buildId, send, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, setLaunching, chrome,
  binaryFrameHandlerRef, onRecordingUploaded,
  swKeyboardVisible, swKeyboardPending, onKbdToggle,
  perfHookRef,
}: IOSViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const screenAreaRef = useRef<HTMLDivElement>(null);
  const { fps, frameCount } = useFps();
  const lastFrameRecvAtRef = useRef<number>(0);
  const { recordState, recordCanvasRef, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });
  const deviceSeq = useRef(0);

  const [deepLinkOpen, setDeepLinkOpen] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [flashedButton, setFlashedButton] = useState<string | null>(null);
  const [hoveredButton, setHoveredButton] = useState<string | null>(null);
  const [pinchActive, setPinchActive] = useState(false);
  const [pinchHint, setPinchHint] = useState<{ f0: { x: number; y: number }; f1: { x: number; y: number } } | null>(null);
  const pinchHintRef = useRef(pinchHint);
  useEffect(() => { pinchHintRef.current = pinchHint; }, [pinchHint]);

  const pressedButton = useRef<string | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const isPinchMode = useRef(false);
  const isOptionHeld = useRef(false);
  const lastMoveSentAt = useRef(0);

  const liveCursorRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const cursorStateRef = useRef<'idle' | 'down' | 'release'>('idle');
  const releaseAnimRef = useRef<{ startTime: number } | null>(null);

  // ── Chrome image cache ────────────────────────────────────────────────────
  const chromeImgRef = useRef<HTMLImageElement | null>(null);
  const chromeRef = useRef<ChromeData | null>(null);
  useEffect(() => { chromeRef.current = chrome; }, [chrome]);
  useEffect(() => {
    const img = new Image()
    img.onload = () => { chromeImgRef.current = img }
    img.src = `data:image/png;base64,${chrome.framePng}`
  }, [chrome.framePng])

  // ── Binary frame handler: JPEG via createImageBitmap, H.264 via pickDecoder ──
  useEffect(() => {
    let decoder: Decoder | null = null
    let decoderFailed = false
    let raf: number | null = null
    // Correlates the decoder's async present back to its submit so the H.264 path
    // reports decodeMs / glass-to-glass like the synchronous JPEG path.
    const tracker = new FrameLatencyTracker()
    // glass-to-glass needs agent and browser on one clock — true only on localhost.
    const singleClock = typeof location !== 'undefined'
      && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

    const ensureDecoder = (): Decoder | null => {
      if (decoder) return decoder
      if (decoderFailed) return null // latch: don't re-pick/re-warn on every frame
      // Dev override: ?decoder=wasm forces the WASM tier on localhost (which is a
      // secure context, so it would otherwise auto-pick WebCodecs) for measurement.
      const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get('decoder') : null
      const d = forced === 'wasm' ? new WASMDecoder() : pickDecoder()
      if (!d) { decoderFailed = true; console.warn('[IOSViewer] no H.264 decoder available — set up HTTPS or use a supported browser'); return null }
      decoder = d
      if (import.meta.env.DEV) {
        console.log(`[decoder] using ${d instanceof WASMDecoder ? 'WASM' : 'WebCodecs'}${forced ? ` (forced: ${forced})` : ''}`)
        let diagN = 0
        d.onDecodedFrame?.((presentTime, sample) => {
          const timing = tracker.onPresented(
            presentTime,
            singleClock ? performance.timeOrigin + presentTime : undefined,
          )
          if (timing) {
            // Prefer the decoder's exact, timestamp-matched decodeMs (drop-immune)
            // over the FIFO estimate — distinguishes real decode latency from drift.
            if (sample) timing.decodeMs = sample.decodeMs
            perfHookRef?.current?.onFrameEnd(timing)
          }
          // Diagnostic: queueSize ~0 ⇒ FIFO artifact; steadily high ⇒ real backlog.
          if (sample && diagN++ % 30 === 0) {
            console.log(`[wc-diag] decodeMs=${sample.decodeMs.toFixed(1)} queueSize=${sample.queueSize}`)
          }
        })
      }
      const surface = d.surface
      // Display the decoder surface directly (like AndroidViewer) for smooth compositing;
      // it overlays the canvas, which stays behind, mirrored, for recording/screenshot.
      const c = canvasRef.current
      surface.style.position = 'absolute'
      if (c) {
        surface.style.left = c.style.left
        surface.style.top = c.style.top
        surface.style.width = c.style.width
        surface.style.height = c.style.height
        surface.style.borderRadius = c.style.borderRadius
      }
      surface.style.objectFit = 'fill'
      surface.style.zIndex = '3'
      surface.style.pointerEvents = 'none'
      containerRef.current?.appendChild(surface)
      d.onResize((size) => {
        const canvas = canvasRef.current
        if (canvas && (canvas.width !== size.width || canvas.height !== size.height)) {
          canvas.width = size.width; canvas.height = size.height
          if (!chromeRef.current) {
            const rc = recordCanvasRef.current
            if (rc) { rc.width = size.width; rc.height = size.height }
          }
        }
        setCanvasReady(true)
      })
      // The <video> is the live display; the canvas mirrors it (behind) only so the
      // existing recording/screenshot paths, which read canvasRef, keep working.
      const blit = () => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        const surface = decoder?.surface
        if (canvas && ctx && surface && decoder?.size) {
          try { ctx.drawImage(surface, 0, 0, canvas.width, canvas.height) } catch { /* surface not paintable yet */ }
        }
        raf = requestAnimationFrame(blit)
      }
      raf = requestAnimationFrame(blit)
      return d
    }

    binaryFrameHandlerRef.current = (data: ArrayBuffer, meta) => {
      if (meta?.codec === CODEC_H264) {
        const d = ensureDecoder()
        if (!d) return
        const recvAt = performance.now()
        const recvInterval = lastFrameRecvAtRef.current ? recvAt - lastFrameRecvAtRef.current : 0
        lastFrameRecvAtRef.current = recvAt
        if (import.meta.env.DEV) {
          perfHookRef?.current?.onFrameBegin()
          // onFrameEnd fires later, from onDecodedFrame, once this frame presents.
          tracker.onSubmit({ submitTime: recvAt, recvAt, recvInterval, capturedAt: meta.capturedAt, relayedAt: meta.relayedAt })
        }
        d.decode(data)
        frameCount.current += 1
        return
      }

      const recvAt = performance.now()
      const recvInterval = lastFrameRecvAtRef.current ? recvAt - lastFrameRecvAtRef.current : 0
      lastFrameRecvAtRef.current = recvAt
      if (import.meta.env.DEV) perfHookRef?.current?.onFrameBegin()

      const seq = deviceSeq.current
      createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
        .then((bitmap) => {
          const decodeMs = performance.now() - recvAt
          if (deviceSeq.current !== seq) { bitmap.close(); return }
          const canvas = canvasRef.current
          const ctx = canvas?.getContext('2d')
          if (!canvas || !ctx) { bitmap.close(); return }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width; canvas.height = bitmap.height
            if (!chromeRef.current) {
              const rc = recordCanvasRef.current
              if (rc) { rc.width = bitmap.width; rc.height = bitmap.height }
            }
          }
          const paintStart = performance.now()
          ctx.drawImage(bitmap, 0, 0)
          const paintMs = performance.now() - paintStart
          bitmap.close()
          setCanvasReady(true)
          frameCount.current += 1
          if (import.meta.env.DEV) {
            perfHookRef?.current?.onFrameEnd({ recvAt, recvInterval, decodeMs, paintMs })
          }
        })
        .catch(() => {})
    }
    return () => {
      binaryFrameHandlerRef.current = undefined
      if (raf !== null) cancelAnimationFrame(raf)
      decoder?.close()
      decoder?.surface.remove()
      decoder = null
    }
  }, [binaryFrameHandlerRef, frameCount, perfHookRef])

  // Sync record canvas size when chrome arrives
  useEffect(() => {
    const rc = recordCanvasRef.current; const container = containerRef.current
    if (rc && container) { rc.width = container.clientWidth; rc.height = container.clientHeight }
  }, [chrome])

  // ── Recording (composeFrame only — state/refs/lifecycle in useClientRecording) ──
  const composeFrame = useCallback(() => {
    const rc = recordCanvasRef.current; const fc = canvasRef.current
    if (!rc || !fc) return
    const ctx = rc.getContext('2d')
    if (!ctx) return

    const ch = chromeRef.current
    ctx.clearRect(0, 0, rc.width, rc.height)

    if (ch) {
      if (chromeImgRef.current) ctx.drawImage(chromeImgRef.current, 0, 0, rc.width, rc.height)
      const r = Math.round((ch.screenCornerRadius / 2) * (rc.height / (ch.compositeHeight / 2)))
      ctx.save(); ctx.beginPath()
      if (r > 0) {
        (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void })
          .roundRect(fc.offsetLeft, fc.offsetTop, fc.clientWidth, fc.clientHeight, r)
      } else { ctx.rect(fc.offsetLeft, fc.offsetTop, fc.clientWidth, fc.clientHeight) }
      ctx.clip(); ctx.drawImage(fc, fc.offsetLeft, fc.offsetTop, fc.clientWidth, fc.clientHeight); ctx.restore()
    } else {
      ctx.drawImage(fc, 0, 0, rc.width, rc.height)
    }

    // Pinch hint
    const ph = pinchHintRef.current
    if (ph) {
      for (const f of [ph.f0, ph.f1]) {
        const cx = ch ? fc.offsetLeft + f.x * fc.clientWidth : f.x * rc.width
        const cy = ch ? fc.offsetTop  + f.y * fc.clientHeight : f.y * rc.height
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

    // Cursor
    const cp = cursorPosRef.current
    if (cp) {
      const state = cursorStateRef.current; const ra = releaseAnimRef.current
      ctx.save()
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
      ctx.restore()
    }
  }, [])

  const handleScreenshot = useCallback(() => {
    const src = canvasRef.current; if (!src) return
    const c = document.createElement('canvas'); const ctx = c.getContext('2d'); if (!ctx) return
    c.width = src.width; c.height = src.height; ctx.drawImage(src, 0, 0)
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
      const container = containerRef.current
      if (container && container.clientWidth > 0) { rc.width = container.clientWidth; rc.height = container.clientHeight }
      else { const fc = canvasRef.current; if (fc && fc.width > 0) { rc.width = fc.width; rc.height = fc.height } else return }
      startClientRecording(composeFrame)
    } else if (recordState === 'recording') {
      stopClientRecording()
    }
  }, [recordState, startClientRecording, stopClientRecording, composeFrame])

  const handleRotate = useCallback(() => {
    send({ type: 'input:rotate', sessionId }); setIsLandscape(prev => !prev)
  }, [send, sessionId])

  const isLandscapeRef = useRef(isLandscape)
  useEffect(() => { isLandscapeRef.current = isLandscape }, [isLandscape])
  useEffect(() => {
    return () => { if (isLandscapeRef.current) send({ type: 'input:rotate', sessionId }) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          if (e.shiftKey && e.code === 'KeyU') { e.preventDefault(); send({ type: 'input:button', sessionId, payload: { name: 'home' } }); return }
          if (e.shiftKey && e.code === 'KeyK') { e.preventDefault(); if (!swKeyboardPending) onKbdToggle(); return }
        }
      }
      if (!keyboardActive) return
      if (MODIFIER_CODES.has(e.code)) return
      e.preventDefault()
      const modifiers = (e.shiftKey ? 0x02 : 0) | (e.ctrlKey ? 0x01 : 0) | (e.metaKey ? 0x08 : 0)
      send({ type: 'input:key', sessionId, payload: { code: e.code, modifiers } })
    }
    const endPinch = () => {
      if (isPinchMode.current) { isPinchMode.current = false; setPinchActive(false); send({ type: 'input:pinch:end', sessionId }) }
      isOptionHeld.current = false; setPinchHint(null)
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'AltLeft' || e.code === 'AltRight') endPinch() }
    const onBlur = () => { if (isOptionHeld.current) endPinch() }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [keyboardActive, send, sessionId, handleScreenshot, handleRecordToggle, handleRotate, onKbdToggle, swKeyboardPending])

  useEffect(() => {
    if (!keyboardActive) return
    const onDown = (e: PointerEvent) => {
      const area = containerRef.current ?? canvasRef.current
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [keyboardActive])

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const toNormScreen = useCallback((e: { clientX: number; clientY: number }) => {
    // In landscape, use the outer wrapper div (no CSS transform) to avoid
    // getBoundingClientRect inaccuracies on CSS-rotated elements.
    const target = (isLandscape ? screenAreaRef.current : null) ?? containerRef.current
    if (!target) return null
    const rect = target.getBoundingClientRect()
    const cw = chrome.compositeWidth / 2; const ch2 = chrome.compositeHeight / 2
    const sx = chrome.screenRect.x / 2; const sy = chrome.screenRect.y / 2
    const sw = chrome.screenRect.width / 2; const sh = chrome.screenRect.height / 2
    return iosToNormScreen(
      { x: e.clientX, y: e.clientY },
      rect,
      cw, ch2,
      { x: sx, y: sy, width: sw, height: sh },
      isLandscape,
    )
  }, [chrome, isLandscape])

  const toPinchFingers = useCallback((e: { clientX: number; clientY: number }) => {
    const f1 = toNormScreen(e); if (!f1) return null
    return makePinchFingers(f1)
  }, [toNormScreen])

  const toButton = useCallback((e: { clientX: number; clientY: number }): string | null => {
    const target = (isLandscape ? screenAreaRef.current : containerRef.current)
    if (!target) return null
    const rect = target.getBoundingClientRect()
    let cx: number, cy: number
    if (isLandscape) {
      // screenAreaRef is the untransformed wrapper (width=displayH, height=displayW in landscape)
      // inverse of rotate(-90deg): portrait X ← bottom edge distance, portrait Y ← left edge distance
      const lx = rect.height - (e.clientY - rect.top)
      const ly = e.clientX - rect.left
      cx = lx * (chrome.compositeWidth / rect.height)
      cy = ly * (chrome.compositeHeight / rect.width)
    } else {
      cx = (e.clientX - rect.left) * (chrome.compositeWidth / rect.width)
      cy = (e.clientY - rect.top) * (chrome.compositeHeight / rect.height)
    }
    for (const btn of chrome.buttons) {
      const dx = cx - btn.normalOffset.x; const dy = cy - btn.normalOffset.y
      if (dx * dx + dy * dy < BUTTON_HIT_RADIUS ** 2) return btn.name
    }
    return null
  }, [chrome, isLandscape])

  const normToRecordCanvas = useCallback((norm: { x: number; y: number }) => {
    const fc = canvasRef.current; const rc = recordCanvasRef.current
    if (fc && fc.clientWidth > 0) return { x: fc.offsetLeft + norm.x * fc.clientWidth, y: fc.offsetTop + norm.y * fc.clientHeight }
    return { x: norm.x * (rc?.width ?? 1), y: norm.y * (rc?.height ?? 1) }
  }, [])

  // ── Pointer interaction ───────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setKeyboardActive(true)
    if (isOptionHeld.current) {
      const fingers = toPinchFingers(e); if (!fingers) return
      isPinchMode.current = true; setPinchActive(true)
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setPinchHint(fingers); send({ type: 'input:pinch:start', sessionId, payload: fingers }); return
    }
    const btn = toButton(e)
    if (btn) { pressedButton.current = btn; setFlashedButton(btn); return }
    const pos = toNormScreen(e); if (!pos) return
    touchStartPos.current = pos
    ;(e.target as Element).setPointerCapture(e.pointerId)
    cursorPosRef.current = normToRecordCanvas(pos); cursorStateRef.current = 'down'; releaseAnimRef.current = null
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
  }, [toButton, toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.buttons === 0) {
      setHoveredButton(toButton(e))
      if (isOptionHeld.current) {
        setPinchHint(toPinchFingers(e)); cursorPosRef.current = null
        const _lc = liveCursorRef.current; if (_lc) _lc.style.display = 'none'
      } else {
        setPinchHint(null)
        const norm = toNormScreen(e); cursorPosRef.current = norm ? normToRecordCanvas(norm) : null
        if (cursorStateRef.current !== 'down') cursorStateRef.current = 'idle'
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
      }
      return
    }
    if (isPinchMode.current) {
      const fingers = toPinchFingers(e); if (!fingers) return
      const now = performance.now(); if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
      lastMoveSentAt.current = now; setPinchHint(fingers); send({ type: 'input:pinch:move', sessionId, payload: fingers }); return
    }
    if (pressedButton.current) return
    if (!touchStartPos.current) return
    const pos = toNormScreen(e); if (!pos) return
    const dx = pos.x - touchStartPos.current.x; const dy = pos.y - touchStartPos.current.y
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
    const now = performance.now(); if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
    lastMoveSentAt.current = now
    cursorPosRef.current = normToRecordCanvas(pos)
    const _lc = liveCursorRef.current
    if (_lc && _lc.style.display !== 'none') {
      const _r = (e.currentTarget as Element).getBoundingClientRect()
      _lc.style.left = `${e.clientX - _r.left}px`; _lc.style.top = `${e.clientY - _r.top}px`
    }
    send({ type: 'input:touch:move', sessionId, payload: pos })
  }, [toButton, toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId])

  const handlePointerUp = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null); send({ type: 'input:pinch:end', sessionId }); return
    }
    touchStartPos.current = null
    if (pressedButton.current) {
      send({ type: 'input:button', sessionId, payload: { name: pressedButton.current } })
      pressedButton.current = null; setTimeout(() => setFlashedButton(null), 100); return
    }
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
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null); send({ type: 'input:pinch:end', sessionId }); return
    }
    touchStartPos.current = null
    if (pressedButton.current) { pressedButton.current = null; setFlashedButton(null); return }
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    send({ type: 'input:touch:end', sessionId })
  }, [send, sessionId])

  const handlePointerLeave = useCallback(() => {
    setHoveredButton(null); setPinchHint(null); cursorPosRef.current = null
    const _lc = liveCursorRef.current; if (_lc) _lc.style.display = 'none'
  }, [])

  // ── Layout ────────────────────────────────────────────────────────────────
  const compositeLogicalW = chrome.compositeWidth / 2;
  const compositeLogicalH = chrome.compositeHeight / 2;
  const MAX_DISPLAY_H = 750;
  const displayScale = iosDisplayScale(compositeLogicalH, MAX_DISPLAY_H);
  const displayW = Math.round(compositeLogicalW * displayScale);
  const displayH = Math.round(compositeLogicalH * displayScale);
  const screenPctLeft = (chrome.screenRect.x / chrome.compositeWidth) * 100;
  const screenPctTop = (chrome.screenRect.y / chrome.compositeHeight) * 100;
  const screenPctW = (chrome.screenRect.width / chrome.compositeWidth) * 100;
  const screenPctH = (chrome.screenRect.height / chrome.compositeHeight) * 100;
  const cssCornerRadius = Math.round((chrome.screenCornerRadius / 2) * displayScale);

  const platformSlot = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"
            onClick={() => send({ type: 'input:button', sessionId, payload: { name: 'home' } })}
          >
            <Home className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left"><span className="flex items-center gap-3">Home <KbdGroup><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>U</Kbd></KbdGroup></span></TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"
            disabled={swKeyboardPending}
            onClick={onKbdToggle}
            data-active={swKeyboardVisible}
          >
            {swKeyboardPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Keyboard className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left"><span className="flex items-center gap-3">Software keyboard <KbdGroup><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>K</Kbd></KbdGroup></span></TooltipContent>
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
        <div ref={screenAreaRef} style={{ width: isLandscape ? displayH : displayW, height: isLandscape ? displayW : displayH, position: 'relative', flexShrink: 0 }}>
          <div
            ref={containerRef}
            className={`relative ${hoveredButton ? 'cursor-pointer' : 'cursor-default'}`}
            style={{
              width: displayW, height: displayH,
              ...(isLandscape ? { position: 'absolute', top: (displayW - displayH) / 2, left: (displayH - displayW) / 2, transform: 'rotate(-90deg)', transformOrigin: 'center center' } : {}),
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
          >
            <img
              src={`data:image/png;base64,${chrome.framePng}`}
              style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
              draggable={false} alt=""
            />
            <canvas
              ref={canvasRef}
              style={{
                position: 'absolute', zIndex: 3,
                left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                width: `${screenPctW}%`, height: `${screenPctH}%`,
                borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
                backgroundColor: '#010101', cursor: 'none',
                visibility: canvasReady ? 'visible' : 'hidden',
              }}
            />
            {!canvasReady && (
              <div className="absolute animate-pulse bg-zinc-700" style={{
                zIndex: 3, left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                width: `${screenPctW}%`, height: `${screenPctH}%`,
                borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
              }} />
            )}
            {pinchHint && (() => {
              const screenLeft = screenPctLeft / 100; const screenTop = screenPctTop / 100
              const screenW = screenPctW / 100; const screenH = screenPctH / 100
              const toCSS = (nx: number, ny: number) => ({
                left: `${(screenLeft + nx * screenW) * 100}%`,
                top: `${(screenTop + ny * screenH) * 100}%`,
              })
              return (
                <>
                  {([pinchHint.f0, pinchHint.f1] as const).map((f, i) => (
                    <div key={i} style={{
                      position: 'absolute', zIndex: 10, borderRadius: '50%',
                      transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                      transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease',
                      ...(pinchActive
                        ? { width: CURSOR_DOT_R * 2, height: CURSOR_DOT_R * 2, background: 'rgba(255,255,255,0.92)', border: '1.5px solid rgba(0,0,0,0.2)', boxShadow: '0 0 0 1px rgba(0,0,0,0.15), 0 0 8px rgba(255,255,255,0.25)' }
                        : { width: CURSOR_RING_R * 2, height: CURSOR_RING_R * 2, background: 'transparent', border: '1.5px solid rgba(255,255,255,0.6)', boxShadow: '0 0 0 1px rgba(0,0,0,0.3)' }),
                      ...toCSS(f.x, f.y),
                    }} />
                  ))}
                </>
              )
            })()}
            {joined && fps === 0 && (
              <div style={{
                position: 'absolute', zIndex: 8, left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                width: `${screenPctW}%`, height: `${screenPctH}%`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
              }}>
                <span style={{ color: 'white', fontSize: '0.875rem' }}>Waiting for first frame...</span>
              </div>
            )}
            {chrome.buttons.map((btn) => {
              const isFlashed = flashedButton === btn.name; const isHovered = hoveredButton === btn.name
              const isBottomAnchor = btn.anchor === 'bottom'; const isTopAnchor = btn.anchor === 'top'
              const imgTopPct = isBottomAnchor ? ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
                : isTopAnchor ? (btn.rolloverOffset.y / chrome.compositeHeight) * 100
                : ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
              const imgHPct = (btn.buttonH / chrome.compositeHeight) * 100
              const imgWPct = (btn.buttonW / chrome.compositeWidth) * 100
              const halfW = btn.buttonW / 2
              const rolloverLeftPct = ((btn.rolloverOffset.x - halfW) / chrome.compositeWidth) * 100
              const hoverLeftPct = ((2 * btn.rolloverOffset.x - btn.normalOffset.x - halfW) / chrome.compositeWidth) * 100
              const tooltipLeftPct = (btn.rolloverOffset.x / chrome.compositeWidth) * 100
              const tooltipTopPct = isBottomAnchor ? ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
                : isTopAnchor ? (btn.rolloverOffset.y / chrome.compositeHeight) * 100
                : ((btn.normalOffset.y - btn.buttonH / 2) / chrome.compositeHeight) * 100
              const hoverTopPct = isTopAnchor ? ((2 * btn.rolloverOffset.y - btn.normalOffset.y) / chrome.compositeHeight) * 100 : 0
              const btnZ = btn.onTop ? 4 : 1
              return (
                <Fragment key={btn.name}>
                  {btn.buttonPng && (
                    <img src={`data:image/png;base64,${btn.buttonPng}`} style={{
                      position: 'absolute', zIndex: btnZ,
                      top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : imgTopPct}%`,
                      left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                      width: `${imgWPct}%`, height: `${imgHPct}%`,
                      transition: isTopAnchor ? 'top 0.15s ease' : 'left 0.15s ease',
                      pointerEvents: 'none', userSelect: 'none',
                    }} draggable={false} alt="" />
                  )}
                  {isFlashed && btn.pressedPng && btn.pressedRect && (
                    <img src={`data:image/png;base64,${btn.pressedPng}`} style={{
                      position: 'absolute', zIndex: btn.onTop ? 3 : 1,
                      left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                      top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : imgTopPct}%`,
                      width: `${(btn.pressedRect.width / chrome.compositeWidth) * 100}%`,
                      height: `${(btn.pressedRect.height / chrome.compositeHeight) * 100}%`,
                      pointerEvents: 'none', userSelect: 'none',
                    }} draggable={false} alt="" />
                  )}
                  {isHovered && (
                    <div
                      className="bg-foreground/85 text-background text-[11px] px-[7px] py-1.5 rounded-lg whitespace-nowrap pointer-events-none"
                      style={{
                        position: 'absolute', zIndex: 5, left: `${tooltipLeftPct}%`, top: `${tooltipTopPct}%`,
                        transform: 'translate(-50%, calc(-100% - 8px))',
                      }}
                    >
                      {btn.accessibilityTitle}
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
          <div
            ref={liveCursorRef}
            style={{
              display: 'none', position: 'absolute', zIndex: 20, borderRadius: '50%',
              transform: 'translate(-50%, -50%)', pointerEvents: 'none',
              transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease, box-shadow 0.1s ease',
            }}
          />
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
