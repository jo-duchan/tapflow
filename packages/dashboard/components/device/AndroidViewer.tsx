'use client';

import type { BrowserToRelay } from '@tapflowio/protocol'
import { newRequestId } from '@/lib/requestId';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { ArrowLeft, Home, LayoutGrid, Loader2, Play, Power, Volume1, Volume2 } from 'lucide-react';
import { useAndroidScreen } from '@/hooks/useAndroidScreen';
import { AndroidDeviceScreen } from './AndroidDeviceScreen';
import { useFps } from '@/hooks/useFps';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { useNetworkControl } from '@/hooks/useNetworkControl';
import type { NetworkMessageHandler } from '@/hooks/useNetworkControl';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import { DeepLinkDialog } from './DeepLinkDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AndroidButton, PosturesPayload } from '@/lib/types'
import type { BinaryFrameHandler } from '@/lib/envelope'
import { androidToNorm as toNormPure, toPinchFingers as makePinchFingers, placeTurnedFrame, turnedSize, overlaySpace, remaining } from '@/lib/coordinate-transform';
import type { MutableRefObject } from 'react';
import type { PerfHook } from '@/components/perf/types';
import { useClipboardBridge, isBridgedChord, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge';
import { toast } from 'sonner';

const CURSOR_RING_R = 13;
const CURSOR_DOT_R = 8;
const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;
const MAX_ANDROID_LONG = 720;

interface AndroidViewerProps {
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
  androidButtons: AndroidButton[] | null;
  binaryFrameHandlerRef: React.RefObject<BinaryFrameHandler | undefined>;
  clipboardHandlerRef: React.MutableRefObject<ClipboardMessageHandler | undefined>;
  clipboardSupported: boolean;
  networkHandlerRef: MutableRefObject<NetworkMessageHandler | undefined>;
  networkSupported: boolean;
  onRecordingUploaded?: () => void;
  /** Restart control (#628). Owned by `DeviceViewer`, which sequences the shutdown and the boot. */
  rebootPending: boolean;
  onReboot: () => void;
  /** The toolbar's restart button, so `DeviceViewer` can put focus back on it after a restart. */
  restartButtonRef: MutableRefObject<HTMLButtonElement | null>;
  screenWidth?: number;
  screenHeight?: number;
  /** Foldable postures from `device:postures`, already in most-closed→most-open order. */
  postures?: PosturesPayload;
  /** Quarter turns clockwise to apply to the video so it matches `screenWidth/Height`. The agent
   *  computes it; see `AndroidChrome.streamRotation`. */
  streamRotation?: 0 | 90 | 180 | 270;
  /** Rounded-corner radius as a fraction of width — the emulator bakes the device's corners into
   *  the framebuffer as black; we clip them so they don't show inside the screen bezel. 0 = square. */
  cornerRadius?: number;
  perfHookRef?: MutableRefObject<PerfHook>;
}

export function AndroidViewer({
  sessionId, buildId, send, openUrl, launchApp, connected, joined,
  deviceReady, installing, installed, installError, bootError,
  launching, androidButtons,
  binaryFrameHandlerRef, clipboardHandlerRef, clipboardSupported, networkHandlerRef, networkSupported, onRecordingUploaded,
  rebootPending, onReboot, restartButtonRef,
  screenWidth, screenHeight, cornerRadius, postures, streamRotation = 0,
  perfHookRef,
}: AndroidViewerProps) {
  const { fps, frameCount } = useFps();

  const { recordState, recordCanvasRef, setComposeFrame, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });

  const [deepLinkOpen, setDeepLinkOpen] = useState(false);
  // Rotation intent is owned locally (iOS IOSViewer pattern). It only drives CSS shell
  // rotation for portrait-locked apps; rotation-capable apps follow the actual stream.
  const [userWantsLandscape, setUserWantsLandscape] = useState(false);

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

  // **Before the picture, because the picture is held back while one is in flight.** The effects that
  // release it stay with the rotate control below.
  const [rotatePending, setRotatePending] = useState(false)

  // ── The picture (decoding, geometry, visibility) — shared with the watch-only page ──
  const screen = useAndroidScreen({
    binaryFrameHandlerRef, perfHookRef, frameCount,
    screenWidth, screenHeight, streamRotation, cornerRadius, userWantsLandscape, rotatePending,
  })
  const { surfaceHostRef, containerRef, decoderRef, videoSizeRef, needsCSSRotationRef, decoderUnsupported, totalTurn } = screen

  // ── Recording (composeFrame only — state/refs/lifecycle in useClientRecording) ──
  const composeFrame = useCallback(() => {
    const rc = recordCanvasRef.current; const fc = decoderRef.current?.surface
    const size = videoSizeRef.current
    if (!rc || !fc || !size) return
    const ctx = rc.getContext('2d')
    if (!ctx) return

    // rc was sized to the picture at record start (handleRecordToggle; MediaRecorder fixed the
    // dimensions then). The turn is read per frame rather than inferred from rc's aspect: an
    // aspect comparison cannot tell 90 from 270 and cannot see 180 at all.
    const fw = size.width; const fh = size.height
    const turn = totalTurn
    const { picW, picH, scale, left, top } = placeTurnedFrame(rc.width, rc.height, fw, fh, turn)

    ctx.clearRect(0, 0, rc.width, rc.height)
    ctx.save()
    // Into the picture's box, then turn about its centre so the frame lands square inside it.
    ctx.translate(left + (picW * scale) / 2, top + (picH * scale) / 2)
    ctx.scale(scale, scale)
    ctx.rotate((turn * Math.PI) / 180)
    ctx.drawImage(fc, -fw / 2, -fh / 2, fw, fh)
    ctx.restore()

    // **Overlays in the device's space, which is where the pointer was measured.**
    // `androidToNorm` undoes the user's CSS quarter, so a stored point is a fraction of the screen
    // Android is drawing — not of the picture in the shell, and not of the frame. Two bases have
    // been wrong here: against the frame it missed by the stream's correction on a foldable, and
    // against the picture it missed by the user's quarter on every backend, scrcpy included.
    // So: turn the canvas by that quarter alone, and draw in the shown screen's dimensions.
    const shown = overlaySpace(fw, fh, turn, streamRotation)
    ctx.save()
    ctx.translate(left + (picW * scale) / 2, top + (picH * scale) / 2)
    ctx.scale(scale, scale)
    ctx.rotate((shown.turn * Math.PI) / 180)
    ctx.translate(-shown.width / 2, -shown.height / 2)
    const longSide = Math.max(shown.width, shown.height)
    const s = longSide > MAX_ANDROID_LONG ? longSide / MAX_ANDROID_LONG : 1
    const ringR = CURSOR_RING_R * s; const dotR = CURSOR_DOT_R * s

    const ph = pinchHintRef.current
    if (ph) {
      for (const f of [ph.f0, ph.f1]) {
        const cx = f.x * shown.width; const cy = f.y * shown.height
        if (isPinchMode.current) {
          ctx.beginPath(); ctx.arc(cx, cy, dotR, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill()
          ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = s; ctx.stroke()
        } else {
          ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3 * s; ctx.stroke()
          ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.5 * s; ctx.stroke()
        }
      }
    }

    const cp = cursorPosRef.current
    if (cp) {
      const cx = cp.x * shown.width; const cy = cp.y * shown.height
      const state = cursorStateRef.current; const ra = releaseAnimRef.current
      if (state === 'down') {
        ctx.beginPath(); ctx.arc(cx, cy, dotR, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = s; ctx.stroke()
      } else if (state === 'release' && ra) {
        const t = Math.min((performance.now() - ra.startTime) / 350, 1)
        ctx.beginPath(); ctx.arc(cx, cy, dotR + 26 * s * t, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.55})`; ctx.lineWidth = 1.5 * s; ctx.stroke()
        if (t >= 1) { cursorStateRef.current = 'idle'; releaseAnimRef.current = null }
      } else {
        ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3 * s; ctx.stroke()
        ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.5 * s; ctx.stroke()
      }
    }
    ctx.restore()
  }, [recordCanvasRef, totalTurn, streamRotation, decoderRef, videoSizeRef])

  // The recorder calls whichever composer was registered last, so a rotation reaches the frames
  // that follow it rather than being frozen at the moment recording started.
  //
  // **A layout effect, because the frame loop runs before paint.** `requestAnimationFrame` fires
  // between the layout effects and the paint, so a passive effect would register the new composer
  // one tick late and the first frame after a rotation would be drawn with the old turn. The refs
  // this replaced were mirrored in a layout effect for the same reason; keeping the timing is what
  // makes the swap invisible in the recording.
  useLayoutEffect(() => { setComposeFrame(composeFrame) }, [composeFrame, setComposeFrame])

  const handleScreenshot = useCallback(() => {
    const src = decoderRef.current?.surface; const size = videoSizeRef.current
    if (!src || !size) return
    const c = document.createElement('canvas'); const ctx = c.getContext('2d'); if (!ctx) return
    // The picture, not the frame — same reason as `placeFrame`. Sized to the turned frame, so the
    // fit is exact and the scale is 1.
    const turn = totalTurn
    const shot = turnedSize(size.width, size.height, turn)
    c.width = shot.width; c.height = shot.height
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate((turn * Math.PI) / 180)
    ctx.drawImage(src, -size.width / 2, -size.height / 2, size.width, size.height)
    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `tapflow-${Date.now()}.png`; a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [totalTurn, decoderRef, videoSizeRef])

  const handleRecordToggle = useCallback(() => {
    if (recordState === 'idle') {
      const rc = recordCanvasRef.current; if (!rc) return
      // Size the record canvas to the picture (frame-native, swapped by a quarter turn) so the
      // recording keeps aspect AND matches what's on screen (#179).
      const size = videoSizeRef.current; if (!size) return
      const shot = turnedSize(size.width, size.height, totalTurn)
      rc.width = shot.width; rc.height = shot.height
      startClientRecording()
    } else if (recordState === 'recording') {
      stopClientRecording()
    }
  }, [recordState, startClientRecording, stopClientRecording, totalTurn, recordCanvasRef, videoSizeRef])

  // A fold takes a moment — the emulator changes panel and the stream renegotiates — and without a
  // sign of it the button reads as not having registered the press.
  // The posture we asked for, or null when nothing is in flight. Holding the *target* rather than
  // a boolean is what lets the release wait for the device to actually arrive there — a plain flag
  // could only be released on a timer, and a timer that starts at the request expires long before
  // the fold finishes.
  const [pendingPosture, setPendingPosture] = useState<string | null>(null)
  const posturePending = pendingPosture !== null
  // The stop's deadline, fixed when the press happens. **A report that does not match cannot be
  // allowed to move it**: `postures` is a fresh object per message, so re-running this effect
  // re-armed a whole new 8s from whenever the report arrived — and the agent sends one on the
  // failure path precisely so a change that did not happen ends. That made it end later. Same
  // shape as the rotate hold two blocks down, which had the same deps and the same comment.
  const postureDeadline = useRef(0)
  const handlePosture = useCallback((postureId: string) => {
    postureDeadline.current = Date.now() + 8_000
    setPendingPosture(postureId)
    send({ type: 'input:posture', sessionId, payload: { postureId } })
  }, [send, sessionId])
  // **Released a beat after the device answers, not the instant it does.** `device:postures` and
  // `session:chrome` are separate messages on separate paths, and the posture one usually wins —
  // so releasing on it alone brings the picture back while the viewer still holds the previous
  // screen's dimensions, which is the flash again. The beat lets the chrome land.
  //
  // The timer also runs when no answer arrives, so a posture change that fails silently ends with
  // a visible screen rather than a permanent placeholder.
  useEffect(() => {
    if (pendingPosture === null) return
    // Only the toolbar's spinner depends on this now — the picture is gated on the frame and the
    // screen agreeing, which is a fact rather than a duration. Released as soon as the device
    // reports the posture that was asked for, with a long stop for a change that never lands.
    const arrived = postures?.currentId === pendingPosture
    const t = setTimeout(
      () => setPendingPosture(null),
      arrived ? 0 : remaining(postureDeadline.current, Date.now()),
    )
    return () => clearTimeout(t)
  }, [pendingPosture, postures])

  // **A rotation is held the same way a fold is, and for a reason the fold does not have.** Folding
  // changes the frame's dimensions, so the frame/screen comparison below notices it on its own. A
  // rotation does not — the capture follows the skin, which does not move — so the only thing that
  // changes is the correction angle, and applying a new angle to the frame that was drawn under the
  // old one turns the picture. On an idle screen no further frame arrives to correct it, so it
  // stays turned.
  // **Two ways out, and they have to be separate effects.** The description landing is the real
  // release; the timer is only the stop for a device that ignored the request, where a
  // portrait-locked app rotates in CSS alone and no new chrome ever follows.
  //
  // They were one effect, with the chrome in its dependency list. That did the opposite of what
  // its comment claimed: an arriving description re-ran the effect, cleared the pending timer and
  // armed a fresh one, so a fast agent produced a *longer* blank than a slow one — and on the
  // gRPC path, where the chrome waits on `stableDisplayMetrics` (3 samples, 300ms apart), the
  // release the comment described could not happen at all.
  useEffect(() => {
    if (!rotatePending) return
    const t = setTimeout(() => setRotatePending(false), 400)
    return () => clearTimeout(t)
  }, [rotatePending])
  // Skips the first run, so a description that was already on screen does not count as an answer.
  const rotateAnswered = useRef(false)
  useEffect(() => {
    if (!rotateAnswered.current) { rotateAnswered.current = true; return }
    setRotatePending(false)
  }, [streamRotation, screenWidth, screenHeight])

  // The orientation last sent, beside the state — see `IOSViewer` (#910).
  const landscapeRef = useRef(false)
  const handleRotate = useCallback(() => {
    const next = !landscapeRef.current
    landscapeRef.current = next
    setRotatePending(true)
    send({ type: 'input:rotate', sessionId, payload: { orientation: next ? 'landscape' : 'portrait' } })
    setUserWantsLandscape(next)
  }, [send, sessionId])

  // Reset device orientation to portrait on unmount if we left it in landscape (iOS pattern).
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
      if (isPinchMode.current) {
        isPinchMode.current = false; setPinchActive(false); send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() })
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
  }, [keyboardActive, clipboardSupported, send, sessionId, handleScreenshot, handleRecordToggle, handleRotate])

  useEffect(() => {
    if (!keyboardActive) return
    const onDown = (e: PointerEvent) => {
      const area = containerRef.current ?? surfaceHostRef.current
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [keyboardActive, containerRef, surfaceHostRef])

  // ── Pointer interaction ───────────────────────────────────────────────────
  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const host = surfaceHostRef.current
    if (!host) return null
    const rect = host.getBoundingClientRect()
    return toNormPure({ x: e.clientX, y: e.clientY }, rect, needsCSSRotationRef.current)
  }, [surfaceHostRef, needsCSSRotationRef])

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
    cursorPosRef.current = pos // normalized — composeFrame maps to record-canvas (native) space
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
        cursorPosRef.current = norm // normalized — see composeFrame
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
    cursorPosRef.current = pos // normalized — see composeFrame
    const _lc = liveCursorRef.current
    if (_lc && _lc.style.display !== 'none') {
      _lc.style.left = `${e.clientX - _r.left}px`; _lc.style.top = `${e.clientY - _r.top}px`
    }
    send({ type: 'input:touch:move', sessionId, payload: pos })
  }, [toNorm, toPinchFingers, send, sessionId])

  const handlePointerUp = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null)
      send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    const _lc = liveCursorRef.current
    if (_lc) {
      _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`
      _lc.style.background = 'transparent'; _lc.style.border = '1.5px solid rgba(255,255,255,0.6)'
      _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)'
    }
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId])

  const handlePointerCancel = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; setPinchActive(false); setPinchHint(null)
      send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    cursorStateRef.current = 'release'; releaseAnimRef.current = { startTime: performance.now() }
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId])

  const handlePointerLeave = useCallback(() => {
    setPinchHint(null)
    cursorPosRef.current = null
    const _lc = liveCursorRef.current
    if (_lc) _lc.style.display = 'none'
  }, [])

  /**
   * **The agent says which buttons exist; this file says where they go (#634).**
   *
   * `androidButtons` arrives from the agent's `ANDROID_BUTTONS`, and it is a *capability* list — the
   * key codes are the reason it lives there. Rendering it in array order let that list's ordering
   * leak out as a layout decision: reordering it in `android-agent` moved buttons in the browser,
   * and nothing on either side would have said so. The two platforms had not actually drifted — the
   * buttons they share sat in the same relative places — so this closes the way they could.
   *
   * So membership still comes from the agent, and the order below is this file's. Anything the agent
   * reports that is not named here simply does not render, which is the safe direction: a new key
   * code shows up in the toolbar only once somebody has decided which group it belongs to.
   */
  const NAVIGATION_BUTTONS = ['home', 'back', 'recent_apps'] as const;
  const DEVICE_BUTTONS = ['volume_up', 'volume_down', 'power'] as const;

  const buttonIcon = (name: string) =>
    name === 'back' ? <ArrowLeft className="h-4 w-4" />
      : name === 'recent_apps' ? <LayoutGrid className="h-4 w-4" />
      : name === 'volume_up' ? <Volume2 className="h-4 w-4" />
      : name === 'volume_down' ? <Volume1 className="h-4 w-4" />
      : name === 'power' ? <Power className="h-4 w-4" />
      : <Home className="h-4 w-4" />;

  const buttonsIn = (order: readonly string[]) => (
    <>
      {order
        .map((name) => androidButtons?.find((b) => b.name === name))
        .filter((b): b is AndroidButton => b !== undefined)
        .map((btn) => (
          <Tooltip key={btn.name}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8"
                aria-label={btn.accessibilityTitle}
                onClick={() => send({ type: 'input:button', sessionId, requestId: newRequestId(), payload: { name: btn.name } })}
              >
                {buttonIcon(btn.name)}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{btn.accessibilityTitle}</TooltipContent>
          </Tooltip>
        ))}
    </>
  );

  const navigationSlot = buttonsIn(NAVIGATION_BUTTONS);
  const deviceSlot = buttonsIn(DEVICE_BUTTONS);

  const launchSlot = installed && buildId ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={launching || installing}
          aria-label="Launch app"
          onClick={launchApp}
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
        posture={postures && postures.postures.length > 1 ? { postures: postures.postures, currentId: postures.currentId, pending: posturePending, onSelect: handlePosture } : undefined}
        navigationSlot={navigationSlot}
        deviceSlot={deviceSlot}
        launchSlot={launchSlot}
        network={networkSupported ? { position: network.position, steerable: network.steerable, reason: network.reason, pending: network.pending, onToggle: network.toggle } : undefined}
        reboot={{ pending: rebootPending, onReboot, buttonRef: restartButtonRef }}
      />

      <div className="flex items-start gap-8">
        <AndroidDeviceScreen
          screen={screen}
          deviceReady={deviceReady}
          posturePending={posturePending}
          surfaceHandlers={{
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerCancel,
            onPointerLeave: handlePointerLeave,
          }}
          overlay={
            <>
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
          }
        />

        <SimulatorInfoCard
          joined={joined} fps={fps} connected={connected}
          deviceReady={deviceReady} bootError={bootError}
          installing={installing} installError={installError}
          decoderUnsupported={decoderUnsupported}
          keyboardActive={keyboardActive}
        />
      </div>
    </div>
  );
}
