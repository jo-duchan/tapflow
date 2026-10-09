'use client';

import type { BrowserToRelay, FormFactor } from '@tapflowio/protocol'
import { newRequestId } from '@/lib/requestId';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { Home, Keyboard, Loader2, Play } from 'lucide-react';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { useNetworkControl } from '@/hooks/useNetworkControl';
import type { NetworkMessageHandler } from '@/hooks/useNetworkControl';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { DeepLinkDialog } from './DeepLinkDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import type { ChromeData } from '@/lib/types'
import { iosToNormScreen, toPinchFingers as makePinchFingers } from '@/lib/coordinate-transform';
import { useIOSScreen } from '@/hooks/useIOSScreen';
import { IOSDeviceScreen } from './IOSDeviceScreen';
import { iosScreenLayout } from '@/lib/iosScreenLayout';
import type { BinaryFrameHandler } from '@/lib/envelope';
import type { MutableRefObject } from 'react';
import type { PerfHook } from '@/components/perf/types';
import { useClipboardBridge, isBridgedChord, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge';
import { toast } from 'sonner';
import { isFramelessChrome } from '@/lib/framelessChrome';

const CURSOR_RING_R = 13;
const CURSOR_DOT_R = 8;
const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;

interface IOSViewerProps {
  sessionId: string;
  buildId?: number;
  send: (msg: BrowserToRelay) => void;
  /** Mints the correlation id and records it, so the viewer only toasts its own reply. */
  openUrl: (url: string) => void;
  /** Mints and records the correlation id, then sends — the viewer above consumes the reply. */
  launchApp: () => void;
  connected: boolean;
  joined: boolean;
  deviceReady: boolean;
  installing: boolean;
  installed: boolean;
  installError: string | null;
  bootError: string | null;
  launching: boolean;
  chrome: ChromeData;
  /** What the agent reported the device to be. Decides whether a volume button's tooltip follows
   *  the orientation (an iPad's does); absent reads as a phone. */
  formFactor?: FormFactor;
  binaryFrameHandlerRef: React.MutableRefObject<BinaryFrameHandler | undefined>;
  clipboardHandlerRef: React.MutableRefObject<ClipboardMessageHandler | undefined>;
  clipboardSupported: boolean;
  networkHandlerRef: MutableRefObject<NetworkMessageHandler | undefined>;
  networkSupported: boolean;
  onRecordingUploaded?: () => void;
  swKeyboardVisible: boolean;
  swKeyboardPending: boolean;
  onKbdToggle: () => void;
  /** Restart control (#628). Owned by `DeviceViewer`, which sequences the shutdown and the boot. */
  rebootPending: boolean;
  onReboot: () => void;
  /** The toolbar's restart button, so `DeviceViewer` can put focus back on it after a restart. */
  restartButtonRef: MutableRefObject<HTMLButtonElement | null>;
  perfHookRef?: MutableRefObject<PerfHook>;
  /** Told the size the stream arrives at, so a viewer with no chrome from the agent can take the
   *  device's real aspect (see `framelessChrome`). */
  onStreamSize?: (size: { width: number; height: number }) => void;
}

export function IOSViewer({
  sessionId, buildId, send, openUrl, launchApp, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, chrome, formFactor,
  binaryFrameHandlerRef, clipboardHandlerRef, clipboardSupported, networkHandlerRef, networkSupported, onRecordingUploaded,
  swKeyboardVisible, swKeyboardPending, onKbdToggle,
  rebootPending, onReboot, restartButtonRef,
  perfHookRef, onStreamSize,
}: IOSViewerProps) {
  const { fps, frameCount } = useFps();

  const { recordState, recordCanvasRef, setComposeFrame, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });

  const [deepLinkOpen, setDeepLinkOpen] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [flashedButton, setFlashedButton] = useState<string | null>(null);
  const [hoveredButton, setHoveredButton] = useState<string | null>(null);
  const [pinchActive, setPinchActive] = useState(false);
  const [pinchHint, setPinchHint] = useState<{ f0: { x: number; y: number }; f1: { x: number; y: number } } | null>(null);
  const pinchHintRef = useRef(pinchHint);
  useEffect(() => { pinchHintRef.current = pinchHint; }, [pinchHint]);

  // The frame button held down, and the pointer holding it. One at a time: a second pointer pressing
  // another button used to overwrite this slot, so the first button never got its `up` and stayed
  // held on the device — reachable with two fingers on a touchscreen dashboard, power + volume being
  // the screenshot chord. A press refused that way is remembered so its release does nothing either.
  const pressedButton = useRef<{ name: string; pointerId: number } | null>(null);
  const refusedButtonPointers = useRef(new Set<number>());
  // A release keeps the pressed image up for 100 ms. The timer is held so a press that starts inside
  // that window keeps its own image, and so it does not outlive the viewer.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
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

  // ── The picture (decoding, canvas, waiting state) — shared with the watch-only page ──
  const screen = useIOSScreen({
    chrome, binaryFrameHandlerRef, perfHookRef, fps, frameCount,
    onCanvasResize: (size) => {
      onStreamSize?.(size)
      if (!chromeRef.current) {
        const rc = recordCanvasRef.current
        if (rc) { rc.width = size.width; rc.height = size.height }
      }
    },
  })
  const { canvasRef, containerRef, screenAreaRef, decoderUnsupported } = screen

  // Sync record canvas size when chrome arrives
  useEffect(() => {
    const rc = recordCanvasRef.current; const container = containerRef.current
    if (rc && container) { rc.width = container.clientWidth; rc.height = container.clientHeight }
  }, [chrome, recordCanvasRef, containerRef])

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
  }, [recordCanvasRef, canvasRef])

  // **Registered once, and the difference from Android is worth stating.** `composeFrame` here
  // depends only on `recordCanvasRef` and `canvasRef`, ref objects whose identity never changes, so this fires on
  // mount and never again — there is no newest composer on this platform. A rotation still reaches
  // the frames, because the composer reads `chromeRef`, `canvasRef.current` and the canvas's own
  // layout live on every draw, exactly as it did before the setter existed.
  //
  // So the layout effect is not load-bearing here the way it is in `AndroidViewer`, where the
  // composer is rebuilt on every turn and `requestAnimationFrame` would otherwise see the old one
  // for a tick. It matches that file on purpose: the two viewers should register the same way, and
  // this is the shape that is already correct if iOS ever composes by a turn of its own.
  useLayoutEffect(() => { setComposeFrame(composeFrame) }, [composeFrame, setComposeFrame])

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
  }, [canvasRef])

  const handleRecordToggle = useCallback(() => {
    if (recordState === 'idle') {
      const rc = recordCanvasRef.current; if (!rc) return
      const container = containerRef.current
      if (container && container.clientWidth > 0) { rc.width = container.clientWidth; rc.height = container.clientHeight }
      else { const fc = canvasRef.current; if (fc && fc.width > 0) { rc.width = fc.width; rc.height = fc.height } else return }
      startClientRecording()
    } else if (recordState === 'recording') {
      stopClientRecording()
    }
  }, [recordState, startClientRecording, stopClientRecording, recordCanvasRef, containerRef, canvasRef])

  // **The orientation last sent, kept beside the state rather than read from it** (#910). The agent is
  // sent a target, not "turn", and two presses before a re-render must still send landscape then
  // portrait — the state is a render behind. Updated here and not in a `setState` updater, which
  // StrictMode calls twice: that would flip it twice and send twice.
  const landscapeRef = useRef(false)
  const handleRotate = useCallback(() => {
    const next = !landscapeRef.current
    landscapeRef.current = next
    setIsLandscape(next)
    send({ type: 'input:rotate', sessionId, payload: { orientation: next ? 'landscape' : 'portrait' } })
  }, [send, sessionId])

  // Reset device orientation to portrait on unmount if we left it in landscape.
  //
  // **The whole cleanup goes in the ref, `send` and `sessionId` with it.** It must fire on unmount
  // and on nothing else, so the dependency list is empty — and an empty list closing over props is
  // exactly what `react-hooks/exhaustive-deps` was suppressed for here. A suppression is not local
  // any more: the React Compiler skips the entire file that carries one, whichever rule it names.
  //
  // **Only when landscape**, read from the same ref the button's target comes from. An agent older
  // than the target toggles, so a portrait sent to an upright device would turn it.
  const undoRotateRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    undoRotateRef.current = () => {
      if (landscapeRef.current) send({ type: 'input:rotate', sessionId, payload: { orientation: 'portrait' } })
    }
  }, [send, sessionId])
  useEffect(() => () => { undoRotateRef.current?.() }, [])

  const sendChord = useCallback((code: 'KeyC' | 'KeyV' | 'KeyX', modifiers: number) => {
    send({ type: 'input:key', sessionId, requestId: newRequestId(), payload: { code, modifiers } })
  }, [send, sessionId])
  useClipboardBridge({
    sessionId, send, active: keyboardActive, supported: clipboardSupported,
    handlerRef: clipboardHandlerRef, sendChord, onError: (m) => toast.error(m),
  })

  const network = useNetworkControl({
    sessionId, send, supported: networkSupported, deviceReady, handlerRef: networkHandlerRef,
    onError: (m) => toast.error(m),
  })

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
          // A held chord repeats, and each repeat would be another turn.
          if (e.shiftKey && e.code === 'KeyO') { e.preventDefault(); if (!e.repeat) handleRotate(); return }
          if (e.shiftKey && e.code === 'KeyU') { e.preventDefault(); send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name: 'home' } }); return }
          if (e.shiftKey && e.code === 'KeyK') { e.preventDefault(); if (!swKeyboardPending) onKbdToggle(); return }
        }
      }
      if (!keyboardActive) return
      if (MODIFIER_CODES.has(e.code)) return
      // The clipboard bridge owns the copy/cut/paste chords when the agent implements them —
      // the agent presses them on the device itself, so forwarding here too would double-send.
      // Against an agent without the capability the bridge is inert and these fall through.
      if (clipboardSupported && isBridgedChord(e)) return
      e.preventDefault()
      const modifiers = (e.shiftKey ? 0x02 : 0) | (e.ctrlKey ? 0x01 : 0) | (e.metaKey ? 0x08 : 0)
      send({ type: 'input:key', sessionId, requestId: newRequestId(), payload: { code: e.code, modifiers } })
    }
    const endPinch = () => {
      if (isPinchMode.current) { isPinchMode.current = false; setPinchActive(false); send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }) }
      isOptionHeld.current = false; setPinchHint(null)
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'AltLeft' || e.code === 'AltRight') endPinch() }
    const onBlur = () => { if (isOptionHeld.current) endPinch() }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [keyboardActive, clipboardSupported, send, sessionId, handleScreenshot, handleRecordToggle, handleRotate, onKbdToggle, swKeyboardPending])

  useEffect(() => {
    if (!keyboardActive) return
    const onDown = (e: PointerEvent) => {
      const area = containerRef.current ?? canvasRef.current
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [keyboardActive, containerRef, canvasRef])

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
  }, [chrome, isLandscape, containerRef, screenAreaRef])

  const toPinchFingers = useCallback((e: { clientX: number; clientY: number }) => {
    const f1 = toNormScreen(e); if (!f1) return null
    return makePinchFingers(f1)
  }, [toNormScreen])

  const normToRecordCanvas = useCallback((norm: { x: number; y: number }) => {
    const fc = canvasRef.current; const rc = recordCanvasRef.current
    if (fc && fc.clientWidth > 0) return { x: fc.offsetLeft + norm.x * fc.clientWidth, y: fc.offsetTop + norm.y * fc.clientHeight }
    return { x: norm.x * (rc?.width ?? 1), y: norm.y * (rc?.height ?? 1) }
  }, [recordCanvasRef, canvasRef])

  // ── Pointer interaction ───────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setKeyboardActive(true)
    if (isOptionHeld.current) {
      const fingers = toPinchFingers(e); if (!fingers) return
      isPinchMode.current = true; setPinchActive(true)
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setPinchHint(fingers); send({ type: 'input:pinch:start', sessionId, payload: fingers }); return
    }
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
  }, [toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId])

  // A frame button is its own element, so the browser decides which one a press lands on — through
  // the landscape rotation too, which is the container's transform rather than arithmetic here.
  // Only the press is handled on the element: the release and a cancel bubble to the container,
  // whose handlers already send `up` for `pressedButton`. Option held means a pinch, which starts
  // wherever the drag does, so the event goes on to the container untouched.
  //
  // `useCallback` is not for identity here: as a plain function this writes `pressedButton` from
  // render scope, and the compiler then cannot keep the three pointer callbacks below that read it,
  // so it skips the whole component (`noSuppressedCompilation.test.ts` fails, measured).
  const pressFrameButton = useCallback((name: string, e: React.PointerEvent) => {
    if (isOptionHeld.current) return
    e.stopPropagation()
    if (pressedButton.current) { refusedButtonPointers.current.add(e.pointerId); return }
    setKeyboardActive(true)
    if (flashTimer.current) { clearTimeout(flashTimer.current); flashTimer.current = null }
    pressedButton.current = { name, pointerId: e.pointerId }; setFlashedButton(name)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name, phase: 'down' } })
  }, [send, sessionId])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // A refused button press is nobody's: its finger must not drive a screen drag or a pinch that
    // another finger started.
    if (refusedButtonPointers.current.has(e.pointerId)) return
    if (e.buttons === 0) {
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
    if (pressedButton.current?.pointerId === e.pointerId) return
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
  }, [toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (refusedButtonPointers.current.delete(e.pointerId)) return
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null); send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    if (pressedButton.current?.pointerId === e.pointerId) {
      send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name: pressedButton.current.name, phase: 'up' } })
      pressedButton.current = null
      flashTimer.current = setTimeout(() => { flashTimer.current = null; setFlashedButton(null) }, 100); return
    }
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    const _lc = liveCursorRef.current
    if (_lc) {
      _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`
      _lc.style.background = 'transparent'; _lc.style.border = '1.5px solid rgba(255,255,255,0.6)'
      _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)'
    }
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId])

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (refusedButtonPointers.current.delete(e.pointerId)) return
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null); send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    if (pressedButton.current?.pointerId === e.pointerId) {
      // Release the held button, else the HID button stays down on the device.
      send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name: pressedButton.current.name, phase: 'up' } })
      pressedButton.current = null; setFlashedButton(null); return
    }
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId])

  const handlePointerLeave = useCallback(() => {
    setHoveredButton(null); setPinchHint(null); cursorPosRef.current = null
    const _lc = liveCursorRef.current; if (_lc) _lc.style.display = 'none'
  }, [])

  // ── Layout ────────────────────────────────────────────────────────────────
  const { screenPctLeft, screenPctTop, screenPctW, screenPctH } = iosScreenLayout(chrome);

  // Home moves around the OS; the software keyboard leaves the device in a condition that stays up
  // until somebody puts it away. Two groups, per `packages/dashboard/AGENTS.md` → "Where a new device
  // button goes".
  const navigationSlot = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"
            aria-label="Home"
            onClick={() => send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name: 'home' } })}
          >
            <Home className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left"><span className="flex items-center gap-3">Home <KbdGroup><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>U</Kbd></KbdGroup></span></TooltipContent>
      </Tooltip>
    </>
  );

  const kbdStatusId = useId();

  const deviceSlot = (
    <>
      {/* **A live region, because a name change on a focused button is not re-announced.** Clicking
          this leaves focus on it, and NVDA, JAWS and VoiceOver do not reliably re-read the accessible
          name of the element already focused — so the branched name below tells a screen-reader user
          nothing at the moment it changes, and nothing again when it finishes. The network control in
          this same toolbar carries its state exactly this way and records the same reason.
          **Mounted unconditionally with only the text toggled**: a live region inserted in the same
          commit as its first sentence is routinely dropped, which would silence the one transition it
          exists for. */}
      <span id={kbdStatusId} role="status" className="sr-only">
        {swKeyboardPending
          ? 'Changing the software keyboard.'
          : swKeyboardVisible ? 'The software keyboard is up.' : 'The software keyboard is down.'}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"
            aria-label={swKeyboardPending ? 'Software keyboard — changing it' : 'Software keyboard'}
            // `data-active` below is a CSS hook and nothing reads it out. The toolbar's other two
            // toggles carry their state in `aria-pressed`; this was the one left outside ARIA.
            aria-pressed={swKeyboardVisible}
            aria-busy={swKeyboardPending}
            // **`aria-disabled`, not `disabled`, and the name says why.** A `disabled` button leaves
            // the focus order and stops receiving pointer events, so it announces "unavailable" with
            // no reason *and* its tooltip — the only thing that could give one — can never open. The
            // record button branches its name for this (#447, #624) and the network control chooses
            // `aria-disabled` for it. Keeping the button reachable is only half of it: the first
            // version of this kept an unconditional name and tooltip, so a screen-reader user heard
            // an unavailable control and still no reason. Both branch now.
            aria-disabled={swKeyboardPending}
            aria-describedby={kbdStatusId}
            onClick={() => { if (!swKeyboardPending) onKbdToggle() }}
            data-active={swKeyboardVisible}
          >
            {swKeyboardPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Keyboard className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {swKeyboardPending
            ? <span>Software keyboard — changing it</span>
            : <span className="flex items-center gap-3">Software keyboard <KbdGroup><Kbd>⌘</Kbd><Kbd>⇧</Kbd><Kbd>K</Kbd></KbdGroup></span>}
        </TooltipContent>
      </Tooltip>
    </>
  );

  const launchSlot = installed && buildId ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={launching}
          aria-label="Launch app"
          onClick={launchApp}
        >
          {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{launching ? 'Launching…' : 'Launch app'}</TooltipContent>
    </Tooltip>
  ) : null;

  return (
    // **This region is not focusable, and that is the fix rather than an omission.** It carried
    // `tabIndex={-1}` for a while, which put it out of the tab order and still let a *mouse* focus it —
    // a click on anything unfocusable inside lands on the container — so a ring drew itself around the
    // whole viewer on every tap, and then around it again on every keystroke once `:focus-visible` was
    // tried, because this viewer forwards keys to the device from a `window` listener.
    //
    // The question underneath was whether the region should hold focus at all, and it should not:
    // keystrokes reach the device through `keyboardActive`, which only `handlePointerDown` sets. Focus
    // here granted nothing, so the indicator drawn for it advertised nothing. Whether the device screen
    // should be operable from the keyboard is a real question and a separate one — #747.
    <div
      role="region"
      aria-label="Device screen"
      className="flex items-start justify-center gap-16"
    >
      <canvas ref={recordCanvasRef} style={{ display: 'none' }} />

      <DeepLinkDialog open={deepLinkOpen} onOpenChange={setDeepLinkOpen} openUrl={openUrl} />

      <SimulatorToolbar
        joined={joined}
        onDeepLink={() => setDeepLinkOpen(true)}
        onScreenshot={handleScreenshot}
        onRecordToggle={handleRecordToggle}
        recordState={recordState}
        onRotate={handleRotate}
        navigationSlot={navigationSlot}
        deviceSlot={deviceSlot}
        launchSlot={launchSlot}
        network={networkSupported ? { position: network.position, steerable: network.steerable, reason: network.reason, pending: network.pending, onToggle: network.toggle } : undefined}
        reboot={{ pending: rebootPending, onReboot, buttonRef: restartButtonRef }}
      />

      <div className="flex items-start gap-8">
        <IOSDeviceScreen
          screen={screen}
          chrome={chrome}
          formFactor={formFactor}
          isLandscape={isLandscape}
          joined={joined}
          fps={fps}
          containerHandlers={{
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerCancel,
            onPointerLeave: handlePointerLeave,
          }}
          buttons={{ hovered: hoveredButton, flashed: flashedButton, onHoverChange: setHoveredButton, onPress: pressFrameButton }}
          overlay={
            pinchHint && (() => {
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
            })()
          }
          areaOverlay={
            <div
              ref={liveCursorRef}
              style={{
                display: 'none', position: 'absolute', zIndex: 20, borderRadius: '50%',
                transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease, box-shadow 0.1s ease',
              }}
            />
          }
        />

        <SimulatorInfoCard
          joined={joined} fps={fps} connected={connected}
          deviceReady={deviceReady} bootError={bootError}
          installing={installing} installError={installError}
          decoderUnsupported={decoderUnsupported}
          keyboardActive={keyboardActive}
          note={isFramelessChrome(chrome)
            ? "The device frame couldn't be loaded, so its side buttons (lock, volume) are unavailable this session."
            : undefined}
        />
      </div>
    </div>
  );
}
