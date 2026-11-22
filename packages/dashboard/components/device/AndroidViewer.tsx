'use client';

import type { BootRefusalReason, BrowserToRelay } from '@tapflowio/protocol'
import { newRequestId } from '@/lib/requestId';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClientRecording } from '@/hooks/useClientRecording';
import { ArrowLeft, Home, LayoutGrid, Loader2, Play, Power, Volume1, Volume2 } from 'lucide-react';
import { MAX_ANDROID_LONG, SPIN_MS, useAndroidScreen } from '@/hooks/useAndroidScreen';
import { AndroidDeviceScreen } from './AndroidDeviceScreen';
import { useFps } from '@/hooks/useFps';
import { usePostureControl } from '@/hooks/usePostureControl';
import { SimulatorToolbar } from './shared/SimulatorToolbar';
import { useNetworkControl } from '@/hooks/useNetworkControl';
import type { NetworkMessageHandler } from '@/hooks/useNetworkControl';
import { SimulatorInfoCard } from './shared/SimulatorInfoCard';
import type { AppLogHandler } from './shared/AppLogViewer';
import { DeepLinkDialog } from './DeepLinkDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AndroidButton, PosturesPayload } from '@/lib/types'
import type { BinaryFrameHandler } from '@/lib/envelope'
import { androidToNorm as toNormPure, toPinchFingers as makePinchFingers, placeTurnedFrame, turnedSize, overlaySpace, turnPoint, type Turn } from '@/lib/coordinate-transform';
import type { MutableRefObject } from 'react';
import type { PerfHook } from '@/components/perf/types';
import { useClipboardBridge, isBridgedChord, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge';
import { toast } from 'sonner';
import { PointerTouchMarks, drawTouchState, prefersReducedMotion } from '@/lib/touchMarks';
import { TouchMarksLayer } from '@/components/touch/TouchMarksLayer';

const MOVE_THROTTLE_MS = 16;
const DRAG_THRESHOLD = 0.02;

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
  appLogHandlerRef: MutableRefObject<AppLogHandler | null>;
  appLogsSupported: boolean;
  deviceReady: boolean;
  installing: boolean;
  installed: boolean;
  installError: string | null;
  bootError: string | null;
  /** The relay holds this viewer's boot behind another on the same Mac (a restart reaches it with chrome still up). */
  bootWaiting: BootRefusalReason | null;
  /** See `SimulatorInfoCard.servicesOff`. */
  servicesOff: boolean;
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
  /** Flow Capture (#1125): whether the relay is keeping this person's steps — their own setting. Absent shows no
   *  chip (a relay that predates the setting). */
  capturingSteps?: boolean;
  /** Flow Capture's dialog is open (#1125): nothing typed or pressed here reaches the device while it replays the
   *  person's steps — a modal dialog stops pointer input, but these shortcuts listen on the window. */
  captureOpen?: boolean;
  /** Opens Flow Capture's dialog; absent hides the button (capturing off, or no build to capture against). */
  onCaptureFlow?: () => void;
  captureButtonRef?: MutableRefObject<HTMLButtonElement | null>;
  /** Where Flow Capture's dialog reads the picture it shows the replay on. */
  captureSurfaceRef?: MutableRefObject<(() => CanvasImageSource | null) | null>;
  screenWidth?: number;
  screenHeight?: number;
  /** Foldable postures from `device:postures`, already in most-closed→most-open order. */
  postures?: PosturesPayload;
  /** Quarter turns clockwise to apply to the video so it matches `screenWidth/Height`. The agent
   *  computes it; see `AndroidChrome.streamRotation`. */
  streamRotation?: 0 | 90 | 180 | 270;
  /** How far the emulator's body is turned — `AndroidChrome.bodyRotation`. Present means body mode: the frame is
   *  drawn as the body is held and Rotate turns the body; absent means the portrait/landscape toggle. */
  bodyRotation?: 0 | 90 | 180 | 270;
  /** Rounded-corner radius as a fraction of width — the emulator bakes the device's corners into
   *  the framebuffer as black; we clip them so they don't show inside the screen bezel. 0 = square. */
  cornerRadius?: number;
  perfHookRef?: MutableRefObject<PerfHook>;
}

export function AndroidViewer({
  sessionId, buildId, send, openUrl, launchApp, connected, joined,
  appLogHandlerRef, appLogsSupported,
  deviceReady, installing, installed, installError, bootError, bootWaiting, servicesOff,
  launching, androidButtons,
  binaryFrameHandlerRef, clipboardHandlerRef, clipboardSupported, networkHandlerRef, networkSupported, onRecordingUploaded,
  rebootPending, onReboot, restartButtonRef, capturingSteps, captureOpen = false, onCaptureFlow, captureButtonRef, captureSurfaceRef,
  screenWidth, screenHeight, cornerRadius, postures, streamRotation = 0, bodyRotation,
  perfHookRef,
}: AndroidViewerProps) {
  const { fps, frameCount } = useFps();

  const { recordState, recordCanvasRef, setComposeFrame, startClientRecording, stopClientRecording } = useClientRecording({ sessionId, buildId, onRecordingUploaded });

  const [deepLinkOpen, setDeepLinkOpen] = useState(false);
  // Rotation intent is owned locally (iOS IOSViewer pattern). It only drives CSS shell
  // rotation for portrait-locked apps; rotation-capable apps follow the actual stream.
  const [userWantsLandscape, setUserWantsLandscape] = useState(false);

  const [keyboardActive, setKeyboardActive] = useState(false);
  // The person's pointer, drawn over the screen and into the recording (`lib/touchMarks`), in the screen Android
  // draws: outside React, as a pointer moves at the display's rate.
  const [pointerMarks] = useState(() => new PointerTouchMarks());

  const isPinchMode = useRef(false);
  const isOptionHeld = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const lastMoveSentAt = useRef(0);

  // **Before the picture, because the picture is held back while one is in flight.** The effects that
  // release it stay with the rotate control below.
  const [rotatePending, setRotatePending] = useState(false)
  // Body mode: each press spins the device and is sent once the spin has finished (see `handleRotate`).
  const [turnsAsked, setTurnsAsked] = useState(0)
  // Turns waiting for the spin to finish. A viewer that goes away first sends them as it goes, as iOS does: the
  // tester pressed, and the device is shared.
  const rotateTimers = useRef(new Map<ReturnType<typeof setTimeout>, () => void>())
  useEffect(() => {
    const timers = rotateTimers.current
    return () => { for (const [t, sendNow] of timers) { clearTimeout(t); sendNow() } }
  }, [])

  // ── The picture (decoding, geometry, visibility) — shared with the watch-only page ──
  const screen = useAndroidScreen({
    binaryFrameHandlerRef, perfHookRef, frameCount,
    screenWidth, screenHeight, streamRotation, cornerRadius, userWantsLandscape, rotatePending, bodyRotation, turnsAsked,
  })
  const { surfaceHostRef, containerRef, decoderRef, videoSizeRef, needsCSSRotationRef, needsCSSRotation, screenTurnRef, screenTurn, decoderUnsupported, totalTurn, spinning } = screen
  useLayoutEffect(() => {
    if (!captureSurfaceRef) return
    captureSurfaceRef.current = () => decoderRef.current?.surface ?? null
    return () => { captureSurfaceRef.current = null }
  }, [captureSurfaceRef, decoderRef])
  // Read by the pointer handlers, which run between renders.
  const spinningRef = useRef(false)
  useLayoutEffect(() => { spinningRef.current = spinning }, [spinning])

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

    // The pointer, as the page draws it (`TouchMarksLayer`), at the page's size: `s` scales it to the stream's pixels.
    ctx.scale(s, s)
    const now = performance.now()
    drawTouchState(ctx, pointerMarks.store.stateAt(now), now, (p) => ({ x: (p.x * shown.width) / s, y: (p.y * shown.height) / s }),
      'person', { reduced: prefersReducedMotion() }, scale * s, { backdrop: true })
    ctx.restore()
  }, [recordCanvasRef, totalTurn, streamRotation, decoderRef, videoSizeRef, pointerMarks])

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

  // The fold control, shared with the iOS viewer. `posturePending` also holds the picture back.
  const { pending: posturePending, select: handlePosture } = usePostureControl(send, sessionId, postures)

  // **The toggle's rotation — a real device, or an emulator streaming without gRPC — is held the same way a fold
  // is**, and for a reason the fold does not have. Body mode holds nothing; its press spins instead (below). Folding
  // changes the frame's dimensions, so the frame/screen comparison in `useAndroidScreen` notices it on its own. A
  // rotation there does not — the capture does not turn with it — so the only thing that
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
    // **A device that reports its body turns it a quarter clockwise** — the iOS model. The device spins first and
    // the turn is sent when the spin has finished, DeviceHub's order: sent at once, the turned frame (53 ms,
    // measured) would land while the device was still spinning. That frame ends the spin; nothing waits on the
    // description. Each press is a turn; the agent turns from a fresh reading, so two quick presses are half a turn.
    if (bodyRotation !== undefined) {
      setTurnsAsked((n) => n + 1)
      const sendNow = () => send({ type: 'input:rotate', sessionId, payload: { direction: 'clockwise' } })
      const t = setTimeout(() => { rotateTimers.current.delete(t); sendNow() }, SPIN_MS)
      rotateTimers.current.set(t, sendNow)
      return
    }
    const next = !landscapeRef.current
    landscapeRef.current = next
    setRotatePending(true)
    send({ type: 'input:rotate', sessionId, payload: { orientation: next ? 'landscape' : 'portrait' } })
    setUserWantsLandscape(next)
  }, [send, sessionId, bodyRotation])

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
      // Not in body mode, where the toggle was never pressed: the body's turn is the device's, shared with
      // every other viewer, and this one leaving is no reason to turn it under them.
      if (landscapeRef.current) send({ type: 'input:rotate', sessionId, payload: { orientation: 'portrait' } })
    }
  }, [send, sessionId])
  useEffect(() => () => { undoRotateRef.current?.() }, [])

  const sendChord = useCallback((code: 'KeyC' | 'KeyV' | 'KeyX', modifiers: number) => {
    send({ type: 'input:key', sessionId, requestId: newRequestId(), payload: { code, modifiers } })
  }, [send, sessionId])
  useClipboardBridge({
    sessionId, send, active: keyboardActive && !captureOpen, supported: clipboardSupported,
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
      if (captureOpen) return
      if (e.code === 'AltLeft' || e.code === 'AltRight') { isOptionHeld.current = true; pointerMarks.option(true); return }
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
        isPinchMode.current = false; pointerMarks.lift(); send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() })
      }
      isOptionHeld.current = false; pointerMarks.option(false)
    }
    // Quiet while Flow Capture's dialog replays, as onKeyDown is: ending a pinch sends one.
    const onKeyUp = (e: KeyboardEvent) => { if (!captureOpen && (e.code === 'AltLeft' || e.code === 'AltRight')) endPinch() }
    const onBlur = () => { if (!captureOpen && isOptionHeld.current) endPinch() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [captureOpen, keyboardActive, clipboardSupported, send, sessionId, handleScreenshot, handleRecordToggle, handleRotate, pointerMarks])

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
  /** The pointer on the picture in the shell. Body mode's shell is the frame, so this is the frame's own point. */
  const toPictureNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const host = surfaceHostRef.current
    if (!host) return null
    return toNormPure({ x: e.clientX, y: e.clientY }, host.getBoundingClientRect(), needsCSSRotationRef.current)
  }, [surfaceHostRef, needsCSSRotationRef])
  /** Where the pointer is in the screen Android draws — for the pointer's touch marks, on the page and in the recording,
   *  which are drawn in that screen. Body mode turns the frame there by the description's correction. */
  const toShownNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const p = toPictureNorm(e)
    return p && turnPoint(p, screenTurnRef.current)
  }, [toPictureNorm, screenTurnRef])
  const bodyMode = bodyRotation !== undefined
  /** The point for the wire. **Body mode sends the frame's own point** (`space: 'frame'`) and the agent turns it by
   *  the frame it holds: turned here by the description's correction, which lags a turn by 0.6–3.6 s, it landed a
   *  quarter off until the description caught up, so every touch in that window had to be dropped. Everywhere
   *  else the picture is the screen, the space every other sender uses. */
  //  None is taken while the device spins for a press: the picture is caught mid-turn, so a point means nothing.
  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    if (spinningRef.current) return null
    return bodyMode ? toPictureNorm(e) : toShownNorm(e)
  }, [bodyMode, toPictureNorm, toShownNorm])

  /** Both fingers, for the wire and for the hint. The fingers are point-symmetric about the centre, which every
   *  quarter turn keeps, so the hint's pair is the wire's pair turned. */
  const toPinchFingers = useCallback((e: { clientX: number; clientY: number }) => {
    const sent = toNorm(e)
    const shown = toShownNorm(e)
    if (!sent || !shown) return null
    return { sent: makePinchFingers(sent), shown: makePinchFingers(shown) }
  }, [toNorm, toShownNorm])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (isOptionHeld.current) {
      const fingers = toPinchFingers(e)
      if (!fingers) return
      isPinchMode.current = true
      ;(e.target as Element).setPointerCapture(e.pointerId)
      pointerMarks.press(fingers.shown.f1, true)
      send({ type: 'input:pinch:start', sessionId, payload: bodyMode ? { ...fingers.sent, space: 'frame' } : fingers.sent })
      return
    }
    const pos = toNorm(e)
    if (!pos) return
    setKeyboardActive(true)
    touchStartPos.current = pos
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const shownAt = toShownNorm(e)
    if (shownAt) pointerMarks.press(shownAt, false)
    send({ type: 'input:touch:start', sessionId, payload: bodyMode ? { ...pos, space: 'frame' } : pos })
  }, [toNorm, toShownNorm, toPinchFingers, send, sessionId, bodyMode, pointerMarks])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.buttons === 0) {
      // Over the screen with nothing pressed: the hover disc, or a pinch's two while Option is held.
      pointerMarks.hover(toShownNorm(e))
      return
    }
    if (isPinchMode.current) {
      const fingers = toPinchFingers(e)
      if (!fingers) return
      // Drawn on every move; only what is sent is throttled.
      pointerMarks.drag(fingers.shown.f1)
      const now = performance.now()
      if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
      lastMoveSentAt.current = now
      send({ type: 'input:pinch:move', sessionId, payload: bodyMode ? { ...fingers.sent, space: 'frame' } : fingers.sent })
      return
    }
    if (!touchStartPos.current) return
    const pos = toNorm(e)
    if (!pos) return
    const dx = pos.x - touchStartPos.current.x; const dy = pos.y - touchStartPos.current.y
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
    // Drawn as a drag only once it is sent as one: under the threshold the device takes a tap (review). On every move
    // past it; only what is sent is throttled.
    const shownAt = toShownNorm(e)
    if (shownAt) pointerMarks.drag(shownAt)
    const now = performance.now()
    if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return
    lastMoveSentAt.current = now
    send({ type: 'input:touch:move', sessionId, payload: bodyMode ? { ...pos, space: 'frame' } : pos })
  }, [toNorm, toShownNorm, toPinchFingers, send, sessionId, bodyMode, pointerMarks])

  const handlePointerUp = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; pointerMarks.lift()
      send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    pointerMarks.lift()
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId, pointerMarks])

  const handlePointerCancel = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false; pointerMarks.lift()
      send({ type: 'input:pinch:end', sessionId, requestId: newRequestId() }); return
    }
    touchStartPos.current = null
    pointerMarks.lift()
    send({ type: 'input:touch:end', sessionId, requestId: newRequestId() })
  }, [send, sessionId, pointerMarks])

  const handlePointerLeave = useCallback(() => {
    pointerMarks.leave()
  }, [pointerMarks])

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
        onCaptureFlow={onCaptureFlow}
        captureButtonRef={captureButtonRef}
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
          // The pointer's marks are in the screen Android draws, and the overlay is the box the picture sits in. Body mode
          // turns the picture back by its correction; portrait content held landscape is turned a quarter by CSS inside
          // a landscape box, undone here as `androidToNorm` does it (portrait x = yv, y = 1 − xv). Missing that, a point
          // at the box's top right was drawn at its top left (review).
          overlay={<TouchMarksLayer tone="person" store={pointerMarks.store} place={(x, y) => {
            if (needsCSSRotation) return { left: 1 - y, top: x }
            const p = turnPoint({ x, y }, ((360 - screenTurn) % 360) as Turn)
            return { left: p.x, top: p.y }
          }} />}
        />

        <SimulatorInfoCard
          joined={joined} fps={fps}
          appLogHandlerRef={appLogHandlerRef}
          appLogsSupported={appLogsSupported}
          connected={connected}
          deviceReady={deviceReady} bootError={bootError} bootWaiting={bootWaiting} servicesOff={servicesOff}
          installing={installing} installError={installError}
          decoderUnsupported={decoderUnsupported}
          keyboardActive={keyboardActive}
          capturingSteps={capturingSteps}
        />
      </div>
    </div>
  );
}
