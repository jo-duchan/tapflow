'use client';

import { useCallback, useEffect, useRef, useState, Fragment } from 'react';
import { Home, Camera, RotateCw, Play, Video, Square, Loader2, Keyboard, ScanLine, ArrowLeft, LayoutGrid, Volume2, Volume1, Power } from 'lucide-react';
import { useRelay } from '@/hooks/useRelay';
import type { AndroidButton, ChromeData, RelayMessage } from '@/lib/types';
import { H264Decoder } from '@/lib/H264Decoder';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  onRecordingUploaded?: () => void;
}

// Cursor & pinch hint dimensions — shared between DOM overlay and recording canvas.
// DOM px = R * 2; canvas uses radius directly.
const CURSOR_RING_R = 13;  // idle / pinch-hover ring
const CURSOR_DOT_R = 8;    // down / pinch-active dot

export function SimulatorViewer({ sessionId, deviceId, buildId, onRecordingUploaded }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // off-screen canvas: source for MediaRecorder (composite of framebuffer + chrome + overlays)
  const recordCanvasRef = useRef<HTMLCanvasElement>(null);
  const h264DecoderRef = useRef<H264Decoder | null>(null);
  const streamTypeRef = useRef<'mjpeg' | 'h264'>('mjpeg');

  const [joined, setJoined] = useState(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const [fps, setFps] = useState(0);
  const [chrome, setChrome] = useState<ChromeData | { buttons: AndroidButton[] } | null>(null);
  const frameCount = useRef(0);
  const sendRef = useRef<(msg: object) => void>(() => {});
  const deviceSeq = useRef(0);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const [canvasReady, setCanvasReady] = useState(false);
  const [pinchActive, setPinchActive] = useState(false);
  const videoSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);

  // ── recording state ───────────────────────────────────────────────────────
  const [recordState, setRecordState] = useState<'idle' | 'recording' | 'uploading' | 'done'>('idle');
  const recordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordMimeRef = useRef('');
  const rafIdRef = useRef(0);

  const iosChrome = chrome !== null && 'framePng' in chrome ? chrome as ChromeData : null;
  const androidButtons = chrome !== null && !('framePng' in chrome) && 'buttons' in chrome
    ? (chrome as { buttons: AndroidButton[] }).buttons : null;

  // chrome image cache for drawImage in rAF loop (avoid re-decoding base64 every frame)
  const chromeImgRef = useRef<HTMLImageElement | null>(null);
  const chromeRef = useRef<ChromeData | null>(null);
  useEffect(() => { chromeRef.current = iosChrome; }, [iosChrome]);

  useEffect(() => {
    if (!iosChrome) { chromeImgRef.current = null; return; }
    const img = new Image();
    img.onload = () => { chromeImgRef.current = img; };
    img.src = `data:image/png;base64,${iosChrome.framePng}`;
  }, [iosChrome]);

  // cursor overlay state (refs to avoid stale closures in rAF)
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const cursorStateRef = useRef<'idle' | 'down' | 'release'>('idle');
  const releaseAnimRef = useRef<{ startTime: number } | null>(null);

  // pinch hint mirror for rAF (state → ref)
  const pinchHintRef = useRef<{ f0: { x: number; y: number }; f1: { x: number; y: number } } | null>(null);

  // live view cursor overlay (imperative — avoids re-renders on every mousemove)
  const liveCursorRef = useRef<HTMLDivElement>(null);

  const drawToCanvas = useCallback((data: ArrayBuffer) => {
    const seq = deviceSeq.current;
    createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
      .then((bitmap) => {
        if (deviceSeq.current !== seq) { bitmap.close(); return; }
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            // sync record canvas size when no chrome
            if (!chromeRef.current) {
              const rc = recordCanvasRef.current;
              if (rc) { rc.width = bitmap.width; rc.height = bitmap.height; }
            }
          }
          ctx.drawImage(bitmap, 0, 0);
          setCanvasReady(true);
          frameCount.current += 1;
        }
        bitmap.close();
      })
      .catch(() => {});
  }, []);

  const drawVideoFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) { frame.close(); return; }
    const fw = frame.displayWidth ?? canvas.width;
    const fh = frame.displayHeight ?? canvas.height;
    if (canvas.width !== fw || canvas.height !== fh) {
      canvas.width = fw;
      canvas.height = fh;
      const prev = videoSizeRef.current;
      if (!prev || prev.width !== fw || prev.height !== fh) {
        videoSizeRef.current = { width: fw, height: fh };
        setVideoSize({ width: fw, height: fh });
      }
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    setCanvasReady(true);
    frameCount.current += 1;
  }, []);

  const handleMessage = useCallback(
    (msg: RelayMessage) => {
      if (msg.type === 'session:joined') {
        setJoined(true);
        sendRef.current({ type: 'device:boot', sessionId, payload: { deviceId } });
      }
      if (msg.type === 'device:boot-error') {
        setBootError((msg as unknown as { message: string }).message);
      }
      if (msg.type === 'device:booting') {
        setDeviceReady(false);
        setInstalling(false);
        setInstalled(false);
        setInstallError(null);
        setBootError(null);
        setCanvasReady(false);
        videoSizeRef.current = null;
        setVideoSize(null);
        deviceSeq.current += 1;
        h264DecoderRef.current?.close();
        h264DecoderRef.current = null;
        streamTypeRef.current = 'mjpeg';
        const canvas = canvasRef.current;
        if (canvas) { const ctx = canvas.getContext('2d'); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
      }
      if (msg.type === 'device:ready') {
        setDeviceReady(true);
        if (buildId) { setInstalling(true); sendRef.current({ type: 'app:install', sessionId, buildId }); }
      }
      if (msg.type === 'app:install-done') { setInstalling(false); setInstalled(true); }
      if (msg.type === 'app:install-error') { setInstalling(false); setInstallError(msg.message); }
      if (msg.type === 'app:launch-done') { setLaunching(false); }
      if (msg.type === 'app:launch-error') { setLaunching(false); }
      if (msg.type === 'session:chrome') {
        setChrome(msg.payload);
        const p = msg.payload;
        if (!('framePng' in p) && p.streamType === 'h264') {
          streamTypeRef.current = 'h264';
          h264DecoderRef.current?.close();
          h264DecoderRef.current = new H264Decoder(drawVideoFrame);
        } else {
          streamTypeRef.current = 'mjpeg';
        }
      }
    },
    [drawToCanvas, drawVideoFrame, sessionId, deviceId, buildId],
  );

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    if (streamTypeRef.current === 'h264') {
      h264DecoderRef.current?.decode(data);
    } else {
      drawToCanvas(data);
    }
  }, [drawToCanvas]);

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame);
  sendRef.current = send;

  useEffect(() => {
    if (connected) send({ type: 'session:start', sessionId });
  }, [connected, send, sessionId]);

  useEffect(() => {
    const timer = setInterval(() => { setFps(frameCount.current); frameCount.current = 0; }, 1000);
    return () => clearInterval(timer);
  }, []);

  // sync record canvas size to container (display) dimensions when chrome arrives
  useEffect(() => {
    if (!iosChrome) return;
    const rc = recordCanvasRef.current;
    const container = containerRef.current;
    if (rc && container) { rc.width = container.clientWidth; rc.height = container.clientHeight; }
  }, [iosChrome]);

  // ── rAF compose loop ──────────────────────────────────────────────────────
  const composeFrame = useCallback(() => {
    if (!recordingRef.current) return;

    const rc = recordCanvasRef.current;
    const fc = canvasRef.current;
    if (!rc || !fc) { rafIdRef.current = requestAnimationFrame(composeFrame); return; }

    const ctx = rc.getContext('2d');
    if (!ctx) { rafIdRef.current = requestAnimationFrame(composeFrame); return; }

    const ch = chromeRef.current;
    ctx.clearRect(0, 0, rc.width, rc.height);

    // Use CSS layout coordinates: fc.offsetLeft/Top/clientWidth/Height are relative
    // to containerRef (position:relative), matching the live view exactly.
    if (ch) {
      const fLeft = fc.offsetLeft;
      const fTop  = fc.offsetTop;
      const fW    = fc.clientWidth;
      const fH    = fc.clientHeight;
      // Mirror live view z-order: chrome (z-index 2) below screen canvas (z-index 3).
      // framePng has no transparent screen hole — screen canvas renders on top in the live view,
      // so recording must follow the same order: chrome first, then framebuffer clipped on top.
      // 1. chrome frame (includes opaque screen area as placeholder)
      if (chromeImgRef.current) ctx.drawImage(chromeImgRef.current, 0, 0, rc.width, rc.height);
      // 2. framebuffer clipped to screen area with corner radius (matches canvas borderRadius in live view)
      const r = Math.round((ch.screenCornerRadius / 2) * (rc.height / (ch.compositeHeight / 2)));
      ctx.save();
      ctx.beginPath();
      if (r > 0) {
        (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(fLeft, fTop, fW, fH, r);
      } else {
        ctx.rect(fLeft, fTop, fW, fH);
      }
      ctx.clip();
      ctx.drawImage(fc, fLeft, fTop, fW, fH);
      ctx.restore();
    } else {
      ctx.drawImage(fc, 0, 0, rc.width, rc.height);
    }

    // 3. pinch hint
    const ph = pinchHintRef.current;
    if (ph) {
      for (const f of [ph.f0, ph.f1]) {
        let cx: number, cy: number;
        if (ch) {
          cx = fc.offsetLeft + f.x * fc.clientWidth;
          cy = fc.offsetTop  + f.y * fc.clientHeight;
        } else {
          cx = f.x * rc.width;
          cy = f.y * rc.height;
        }
        if (isPinchMode.current) {
          ctx.beginPath();
          ctx.arc(cx, cy, CURSOR_DOT_R, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.2)';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, CURSOR_RING_R, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(cx, cy, CURSOR_RING_R, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.65)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // 4. cursor
    const cp = cursorPosRef.current;
    if (cp) {
      const state = cursorStateRef.current;
      const ra = releaseAnimRef.current;
      ctx.save();
      if (state === 'down') {
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, CURSOR_DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (state === 'release' && ra) {
        const t = Math.min((performance.now() - ra.startTime) / 350, 1);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, CURSOR_DOT_R + 26 * t, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.55})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (t >= 1) { cursorStateRef.current = 'idle'; releaseAnimRef.current = null; }
      } else {
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, CURSOR_RING_R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, CURSOR_RING_R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    rafIdRef.current = requestAnimationFrame(composeFrame);
  }, []);

  // ── client recording ──────────────────────────────────────────────────────
  const startClientRecording = useCallback(() => {
    const rc = recordCanvasRef.current;
    if (!rc) return;

    // Always force canvas to display dimensions before captureStream.
    // Canvas default is 300×150 (not 0), so the old guard `=== 0` never fired,
    // causing captureStream to lock the video track at 300×150.
    const container = containerRef.current;
    if (container && container.clientWidth > 0) {
      rc.width = container.clientWidth;
      rc.height = container.clientHeight;
    } else {
      const fc = canvasRef.current;
      if (fc && fc.width > 0) { rc.width = fc.width; rc.height = fc.height; }
      else return;
    }

    // Draw one black frame so the encoder (SPS/PPS) initializes at the correct resolution.
    const ctx0 = rc.getContext('2d');
    if (ctx0) { ctx0.fillStyle = '#000'; ctx0.fillRect(0, 0, rc.width, rc.height); }

    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    if (!mime) { console.error('[record] no supported codec'); return; }

    recordMimeRef.current = mime;
    recordChunksRef.current = [];

    const mr = new MediaRecorder(rc.captureStream(30), { mimeType: mime });
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
    mediaRecorderRef.current = mr;
    mr.start(1000);

    recordingRef.current = true;
    rafIdRef.current = requestAnimationFrame(composeFrame);
    setRecordState('recording');
  }, [composeFrame]);

  const stopClientRecording = useCallback(async () => {
    setRecordState('uploading');
    recordingRef.current = false;
    cancelAnimationFrame(rafIdRef.current);

    const mr = mediaRecorderRef.current;
    if (!mr) return;
    await new Promise<void>((resolve) => { mr.onstop = () => resolve(); mr.stop(); });
    mediaRecorderRef.current = null;

    const mime = recordMimeRef.current;
    const ext = mime.includes('mp4') ? '.mp4' : '.webm';
    const blob = new Blob(recordChunksRef.current, { type: mime });
    recordChunksRef.current = [];

    const formData = new FormData();
    formData.append('file', blob, `tapflow-${Date.now()}${ext}`);

    try {
      const params = new URLSearchParams({ sessionId })
      if (buildId) params.set('buildId', String(buildId))
      const res = await fetch(`/api/v1/recordings/upload?${params}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json() as { url?: string };
      if (res.ok && json.url) {
        const a = document.createElement('a');
        a.href = json.url;
        a.download = '';
        a.click();
        onRecordingUploaded?.();
        setRecordState('done');
        setTimeout(() => setRecordState('idle'), 2000);
      } else {
        console.error('[record] upload failed', res.status);
        setRecordState('idle');
      }
    } catch (e) {
      console.error('[record] upload error', e);
      setRecordState('idle');
    }
  }, [sessionId, onRecordingUploaded]);

  // stop recording when tab becomes hidden
  useEffect(() => {
    if (recordState !== 'recording') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopClientRecording();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [recordState, stopClientRecording]);

  // ── interaction ───────────────────────────────────────────────────────────
  const [isLandscape, setIsLandscape] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [flashedButton, setFlashedButton] = useState<string | null>(null);
  const [hoveredButton, setHoveredButton] = useState<string | null>(null);
  const [pinchHint, setPinchHint] = useState<{
    f0: { x: number; y: number };
    f1: { x: number; y: number };
  } | null>(null);
  const pressedButton = useRef<string | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const isPinchMode = useRef(false);
  const isOptionHeld = useRef(false);
  const lastMoveSentAt = useRef(0);
  const MOVE_THROTTLE_MS = 16;
  const DRAG_THRESHOLD = 0.02;

  useEffect(() => { pinchHintRef.current = pinchHint; }, [pinchHint]);

  // Keyboard forwarding: send physical key code via HID.
  // Alt/Option reserved for pinch mode. Modifiers encoded as bitmap.
  useEffect(() => {
    const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight']);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') { isOptionHeld.current = true; return; }
      if (!keyboardActive) return;
      if (MODIFIER_CODES.has(e.code)) return;
      e.preventDefault();
      const modifiers = (e.shiftKey ? 0x02 : 0) | (e.ctrlKey ? 0x01 : 0) | (e.metaKey ? 0x08 : 0);
      send({ type: 'input:key', sessionId, payload: { code: e.code, modifiers } });
    };
    const endPinchIfActive = () => {
      if (isPinchMode.current) {
        isPinchMode.current = false;
        setPinchActive(false);
        send({ type: 'input:pinch:end', sessionId });
      }
      isOptionHeld.current = false;
      setPinchHint(null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') endPinchIfActive();
    };
    // keyup가 누락되는 경우(포커스 이탈 등) 핀치 상태 초기화
    const onBlur = () => { if (isOptionHeld.current) endPinchIfActive(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [keyboardActive, send, sessionId]);

  useEffect(() => {
    if (!keyboardActive) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const area = containerRef.current ?? canvasRef.current;
      if (area && !area.contains(e.target as Node)) setKeyboardActive(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [keyboardActive]);

  const toNormScreen = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (iosChrome && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cw = iosChrome.compositeWidth / 2;
        const ch = iosChrome.compositeHeight / 2;
        const sx = iosChrome.screenRect.x / 2;
        const sy = iosChrome.screenRect.y / 2;
        const sw = iosChrome.screenRect.width / 2;
        const sh = iosChrome.screenRect.height / 2;
        let cx: number, cy: number;
        if (isLandscape) {
          const u = (e.clientX - rect.left) / rect.width;
          const v = (e.clientY - rect.top) / rect.height;
          cx = v * cw; cy = (1 - u) * ch;
        } else {
          cx = (e.clientX - rect.left) * (cw / rect.width);
          cy = (e.clientY - rect.top) * (ch / rect.height);
        }
        if (cx < sx || cx > sx + sw || cy < sy || cy > sy + sh) return null;
        return { x: (cx - sx) / sw, y: (cy - sy) / sh };
      }
      if (!iosChrome && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x, y };
      }
      return null;
    },
    [iosChrome, isLandscape],
  );

  const toPinchFingers = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const f1 = toNormScreen(e);
      if (!f1) return null;
      return { f0: { x: 1 - f1.x, y: 1 - f1.y }, f1 };
    },
    [toNormScreen],
  );

  const BUTTON_HIT_RADIUS = 100;

  const toButton = useCallback(
    (e: { clientX: number; clientY: number }): string | null => {
      if (!containerRef.current || !iosChrome || isLandscape) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (iosChrome.compositeWidth / rect.width);
      const cy = (e.clientY - rect.top) * (iosChrome.compositeHeight / rect.height);
      for (const btn of iosChrome.buttons) {
        const dx = cx - btn.normalOffset.x;
        const dy = cy - btn.normalOffset.y;
        if (dx * dx + dy * dy < BUTTON_HIT_RADIUS ** 2) return btn.name;
      }
      return null;
    },
    [iosChrome],
  );

  // convert normalized screen coord → record canvas coord (CSS display coordinates)
  const normToRecordCanvas = useCallback(
    (norm: { x: number; y: number }): { x: number; y: number } => {
      const fc = canvasRef.current;
      const rc = recordCanvasRef.current;
      if (fc && fc.clientWidth > 0) {
        return {
          x: fc.offsetLeft + norm.x * fc.clientWidth,
          y: fc.offsetTop  + norm.y * fc.clientHeight,
        };
      }
      return { x: norm.x * (rc?.width ?? 1), y: norm.y * (rc?.height ?? 1) };
    },
    [],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setKeyboardActive(true);
      if (isOptionHeld.current) {
        const fingers = toPinchFingers(e);
        if (!fingers) return;
        isPinchMode.current = true;
        setPinchActive(true);
        (e.target as Element).setPointerCapture(e.pointerId);
        setPinchHint(fingers);
        send({ type: 'input:pinch:start', sessionId, payload: fingers });
        return;
      }
      const btn = toButton(e);
      if (btn) { pressedButton.current = btn; setFlashedButton(btn); return; }
      const pos = toNormScreen(e);
      if (!pos) return;
      touchStartPos.current = pos;
      (e.target as Element).setPointerCapture(e.pointerId);
      cursorPosRef.current = normToRecordCanvas(pos);
      cursorStateRef.current = 'down';
      releaseAnimRef.current = null;
      const _rect = (e.currentTarget as Element).getBoundingClientRect();
      const _lc = liveCursorRef.current;
      if (_lc) {
        _lc.style.display = 'block';
        _lc.style.left = `${e.clientX - _rect.left}px`;
        _lc.style.top = `${e.clientY - _rect.top}px`;
        _lc.style.width = `${CURSOR_DOT_R * 2}px`; _lc.style.height = `${CURSOR_DOT_R * 2}px`;
        _lc.style.background = 'rgba(255,255,255,0.92)';
        _lc.style.border = '1.5px solid rgba(0,0,0,0.2)';
        _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.15), 0 0 8px rgba(255,255,255,0.25)';
      }
      send({ type: 'input:touch:start', sessionId, payload: pos });
    },
    [toButton, toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons === 0) {
        setHoveredButton(toButton(e));
        if (isOptionHeld.current) {
          setPinchHint(toPinchFingers(e));
          cursorPosRef.current = null;
          const _lc2 = liveCursorRef.current;
          if (_lc2) _lc2.style.display = 'none';
        } else {
          setPinchHint(null);
          const norm = toNormScreen(e);
          cursorPosRef.current = norm ? normToRecordCanvas(norm) : null;
          if (cursorStateRef.current !== 'down') cursorStateRef.current = 'idle';
          const _lc2 = liveCursorRef.current;
          if (_lc2) {
            if (norm) {
              const _r2 = (e.currentTarget as Element).getBoundingClientRect();
              _lc2.style.display = 'block';
              _lc2.style.left = `${e.clientX - _r2.left}px`;
              _lc2.style.top = `${e.clientY - _r2.top}px`;
              _lc2.style.width = `${CURSOR_RING_R * 2}px`; _lc2.style.height = `${CURSOR_RING_R * 2}px`;
              _lc2.style.background = 'transparent';
              _lc2.style.border = '1.5px solid rgba(255,255,255,0.6)';
              _lc2.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)';
            } else {
              _lc2.style.display = 'none';
            }
          }
        }
        return;
      }
      if (isPinchMode.current) {
        const fingers = toPinchFingers(e);
        if (!fingers) return;
        const now = performance.now();
        if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return;
        lastMoveSentAt.current = now;
        setPinchHint(fingers);
        send({ type: 'input:pinch:move', sessionId, payload: fingers });
        return;
      }
      if (pressedButton.current) return;
      if (!touchStartPos.current) return;
      const pos = toNormScreen(e);
      if (!pos) return;
      const dx = pos.x - touchStartPos.current.x;
      const dy = pos.y - touchStartPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      const now = performance.now();
      if (now - lastMoveSentAt.current < MOVE_THROTTLE_MS) return;
      lastMoveSentAt.current = now;
      cursorPosRef.current = normToRecordCanvas(pos);
      const _lc3 = liveCursorRef.current;
      if (_lc3 && _lc3.style.display !== 'none') {
        const _r3 = (e.currentTarget as Element).getBoundingClientRect();
        _lc3.style.left = `${e.clientX - _r3.left}px`;
        _lc3.style.top = `${e.clientY - _r3.top}px`;
      }
      send({ type: 'input:touch:move', sessionId, payload: pos });
    },
    [toButton, toNormScreen, toPinchFingers, normToRecordCanvas, send, sessionId],
  );

  const handlePointerLeave = useCallback(() => {
    setHoveredButton(null);
    setPinchHint(null);
    cursorPosRef.current = null;
    const _lc = liveCursorRef.current;
    if (_lc) _lc.style.display = 'none';
  }, []);

  const handlePointerUp = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false;
      setPinchActive(false);
      setPinchHint(null);
      send({ type: 'input:pinch:end', sessionId });
      return;
    }
    touchStartPos.current = null;
    if (pressedButton.current) {
      send({ type: 'input:button', sessionId, payload: { name: pressedButton.current } });
      pressedButton.current = null;
      setTimeout(() => setFlashedButton(null), 100);
      return;
    }
    cursorStateRef.current = 'release';
    releaseAnimRef.current = { startTime: performance.now() };
    const _lc = liveCursorRef.current;
    if (_lc) {
      _lc.style.width = `${CURSOR_RING_R * 2}px`; _lc.style.height = `${CURSOR_RING_R * 2}px`;
      _lc.style.background = 'transparent';
      _lc.style.border = '1.5px solid rgba(255,255,255,0.6)';
      _lc.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.3)';
    }
    send({ type: 'input:touch:end', sessionId });
  }, [send, sessionId]);

  const handlePointerCancel = useCallback(() => {
    if (isPinchMode.current) {
      isPinchMode.current = false;
      setPinchActive(false);
      setPinchHint(null);
      send({ type: 'input:pinch:end', sessionId });
      return;
    }
    touchStartPos.current = null;
    if (pressedButton.current) { pressedButton.current = null; setFlashedButton(null); return; }
    cursorStateRef.current = 'release';
    releaseAnimRef.current = { startTime: performance.now() };
    send({ type: 'input:touch:end', sessionId });
  }, [send, sessionId]);

  const handleRecordToggle = useCallback(() => {
    if (recordState === 'idle') startClientRecording();
    else if (recordState === 'recording') stopClientRecording();
  }, [recordState, startClientRecording, stopClientRecording]);

  const handleScreenshot = useCallback(() => {
    const src = canvasRef.current;
    if (!src) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = src.width; canvas.height = src.height;
    ctx.drawImage(src, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `tapflow-${Date.now()}.png`; a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, []);

  const handleRotate = useCallback(() => {
    send({ type: 'input:rotate', sessionId });
    setIsLandscape((prev) => !prev);
  }, [send, sessionId]);

  const handleKeyboardToggle = useCallback(() => {
    send({ type: 'input:keyboard:toggle', sessionId });
  }, [send, sessionId]);

  const handleSoftHome = useCallback(() => {
    send({ type: 'input:button', sessionId, payload: { name: 'home' } });
  }, [send, sessionId]);

  // ── layout ────────────────────────────────────────────────────────────────
  const compositeLogicalW = iosChrome ? iosChrome.compositeWidth / 2 : 0;
  const compositeLogicalH = iosChrome ? iosChrome.compositeHeight / 2 : 0;
  const MAX_DISPLAY_H = 750;
  const displayScale = compositeLogicalH > 0 ? Math.min(1, MAX_DISPLAY_H / compositeLogicalH) : 1;
  const displayW = Math.round(compositeLogicalW * displayScale);
  const displayH = Math.round(compositeLogicalH * displayScale);

  const screenPctLeft = iosChrome ? (iosChrome.screenRect.x / iosChrome.compositeWidth) * 100 : 0;
  const screenPctTop = iosChrome ? (iosChrome.screenRect.y / iosChrome.compositeHeight) * 100 : 0;
  const screenPctW = iosChrome ? (iosChrome.screenRect.width / iosChrome.compositeWidth) * 100 : 100;
  const screenPctH = iosChrome ? (iosChrome.screenRect.height / iosChrome.compositeHeight) * 100 : 100;

  const cssCornerRadius = iosChrome ? Math.round((iosChrome.screenCornerRadius / 2) * displayScale) : 0;

  const MAX_ANDROID_H = 700;
  const androidScale = videoSize ? Math.min(1, MAX_ANDROID_H / videoSize.height) : 1;
  const androidDisplayW = videoSize ? Math.round(videoSize.width * androidScale) : 300;
  const androidDisplayH = videoSize ? Math.round(videoSize.height * androidScale) : 560;

  const fpsColor = fps >= 30 ? '#10b981' : fps >= 15 ? '#f59e0b' : fps > 0 ? '#ef4444' : '#6b7280';

  function getStatusText(): string | null {
    if (!connected) return 'Connecting…';
    if (!joined) return 'Joining session…';
    if (bootError) return `Boot failed: ${bootError.length > 40 ? bootError.slice(0, 40) + '…' : bootError}`;
    if (!deviceReady) return 'Starting device…';
    if (installing) return 'Installing app…';
    if (installError) return `Install failed: ${installError.length > 22 ? installError.slice(0, 22) + '…' : installError}`;
    return null;
  }
  const statusText = getStatusText();

  return (
    <div className="flex items-start justify-center gap-16">
      {/* hidden off-screen record canvas — source for MediaRecorder */}
      <canvas ref={recordCanvasRef} style={{ display: 'none' }} />

      {joined && (
        <TooltipProvider delayDuration={400}>
          <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 backdrop-blur-sm px-1.5 py-2.5 shrink-0 mt-3">
            {installed && buildId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost" size="icon" className="h-8 w-8"
                    disabled={launching}
                    onClick={() => { setLaunching(true); sendRef.current({ type: 'app:launch', sessionId, buildId }); }}
                  >
                    {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{launching ? 'Launching…' : 'Launch app'}</TooltipContent>
              </Tooltip>
            )}

            {androidButtons ? (
              <>
                {androidButtons.map((btn) => (
                  <Tooltip key={btn.name}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
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
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleKeyboardToggle}>
                      <Keyboard className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Keyboard</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSoftHome}>
                      <Home className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Home</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleKeyboardToggle}>
                      <Keyboard className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Software keyboard</TooltipContent>
                </Tooltip>
              </>
            )}

            <div className="w-4 h-px bg-border my-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleScreenshot}>
                  <Camera className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Screenshot</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className={cn('h-8 w-8', recordState === 'recording' && 'text-red-500 hover:text-red-500')}
                  disabled={recordState === 'uploading' || recordState === 'done'}
                  onClick={handleRecordToggle}
                >
                  {recordState === 'uploading' ? <Loader2 className="h-4 w-4 animate-spin" />
                    : recordState === 'recording' ? <Square className="h-4 w-4 fill-current" />
                    : <Video className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {recordState === 'idle' ? 'Start recording' : recordState === 'recording' ? 'Stop recording' : 'Processing…'}
              </TooltipContent>
            </Tooltip>

            <div className="w-4 h-px bg-border my-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleRotate}>
                  <RotateCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Rotate</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}

      <div className="flex items-start gap-8">
      {iosChrome ? (
        <div style={{ width: isLandscape ? displayH : displayW, height: isLandscape ? displayW : displayH, position: 'relative', flexShrink: 0 }}>
          <div
            ref={containerRef}
            className={`relative ${hoveredButton ? 'cursor-pointer' : 'cursor-default'}`}
            style={{
              width: displayW,
              height: displayH,
              ...(isLandscape ? { position: 'absolute', top: (displayW - displayH) / 2, left: (displayH - displayW) / 2, transform: 'rotate(90deg)', transformOrigin: 'center center' } : {}),
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
          >
            <img
              src={`data:image/png;base64,${iosChrome!.framePng}`}
              style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
              draggable={false}
              alt=""
            />
            <canvas
              ref={canvasRef}
              style={{
                position: 'absolute', zIndex: 3,
                left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                width: `${screenPctW}%`, height: `${screenPctH}%`,
                borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
                backgroundColor: '#010101',
                cursor: 'none',
                visibility: canvasReady ? 'visible' : 'hidden',
              }}
            />
            {!canvasReady && (
              <div
                className="absolute animate-pulse bg-zinc-800"
                style={{
                  zIndex: 3,
                  left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                  width: `${screenPctW}%`, height: `${screenPctH}%`,
                  borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
                }}
              />
            )}
            {/* live cursor overlay — imperative position updates via liveCursorRef */}
            <div
              ref={liveCursorRef}
              style={{
                display: 'none',
                position: 'absolute',
                zIndex: 20,
                borderRadius: '50%',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                transition: 'width 0.1s ease, height 0.1s ease, background 0.1s ease, box-shadow 0.1s ease',
              }}
            />
            {pinchHint && (() => {
              const screenLeft = screenPctLeft / 100;
              const screenTop = screenPctTop / 100;
              const screenW = screenPctW / 100;
              const screenH = screenPctH / 100;
              const toCSS = (nx: number, ny: number) => ({
                left: `${(screenLeft + nx * screenW) * 100}%`,
                top: `${(screenTop + ny * screenH) * 100}%`,
              });
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
              );
            })()}
            {joined && fps === 0 && (
              <div style={{
                position: 'absolute', zIndex: 8,
                left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
                width: `${screenPctW}%`, height: `${screenPctH}%`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <span style={{ color: 'white', fontSize: '0.875rem' }}>Waiting for first frame...</span>
              </div>
            )}
            {iosChrome!.buttons.map((btn) => {
              const isFlashed = flashedButton === btn.name;
              const isHovered = hoveredButton === btn.name;
              const isBottomAnchor = btn.anchor === 'bottom';
              const isTopAnchor = btn.anchor === 'top';
              const imgTopPct = isBottomAnchor
                ? ((btn.normalOffset.y - btn.buttonH / 2) / iosChrome!.compositeHeight) * 100
                : isTopAnchor ? (btn.rolloverOffset.y / iosChrome!.compositeHeight) * 100
                : (btn.normalOffset.y / iosChrome!.compositeHeight) * 100;
              const imgHPct = (btn.buttonH / iosChrome!.compositeHeight) * 100;
              const imgWPct = (btn.buttonW / iosChrome!.compositeWidth) * 100;
              const halfW = btn.buttonW / 2;
              const rolloverLeftPct = ((btn.rolloverOffset.x - halfW) / iosChrome!.compositeWidth) * 100;
              const hoverLeftPct = ((2 * btn.rolloverOffset.x - btn.normalOffset.x - halfW) / iosChrome!.compositeWidth) * 100;
              const tooltipLeftPct = (btn.rolloverOffset.x / iosChrome!.compositeWidth) * 100;
              const tooltipTopPct = isBottomAnchor
                ? ((btn.normalOffset.y - btn.buttonH / 2) / iosChrome!.compositeHeight) * 100
                : isTopAnchor ? (btn.rolloverOffset.y / iosChrome!.compositeHeight) * 100
                : (btn.normalOffset.y / iosChrome!.compositeHeight) * 100;
              const hoverTopPct = isTopAnchor ? ((2 * btn.rolloverOffset.y - btn.normalOffset.y) / iosChrome!.compositeHeight) * 100 : 0;
              const btnZ = btn.onTop ? 4 : 1;
              return (
                <Fragment key={btn.name}>
                  {btn.buttonPng && (
                    <img
                      src={`data:image/png;base64,${btn.buttonPng}`}
                      style={{
                        position: 'absolute', zIndex: btnZ,
                        top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : imgTopPct}%`,
                        left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                        width: `${imgWPct}%`, height: `${imgHPct}%`,
                        transition: isTopAnchor ? 'top 0.15s ease' : 'left 0.15s ease',
                        pointerEvents: 'none', userSelect: 'none',
                      }}
                      draggable={false} alt=""
                    />
                  )}
                  {isFlashed && btn.pressedPng && btn.pressedRect && (
                    <img
                      src={`data:image/png;base64,${btn.pressedPng}`}
                      style={{
                        position: 'absolute', zIndex: btn.onTop ? 3 : 1,
                        left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                        top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : (btn.pressedRect.y / iosChrome!.compositeHeight) * 100}%`,
                        width: `${(btn.pressedRect.width / iosChrome!.compositeWidth) * 100}%`,
                        height: `${(btn.pressedRect.height / iosChrome!.compositeHeight) * 100}%`,
                        pointerEvents: 'none', userSelect: 'none',
                      }}
                      draggable={false} alt=""
                    />
                  )}
                  {isHovered && (
                    <div style={{ position: 'absolute', zIndex: 5, left: `${tooltipLeftPct}%`, top: `${tooltipTopPct}%`, transform: 'translate(-50%, calc(-100% - 8px))', background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 11, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                      {btn.accessibilityTitle}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative"
          style={{ width: androidDisplayW, height: androidDisplayH, backgroundColor: '#010101', borderRadius: '28px', flexShrink: 0 }}
        >
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
              display: 'none',
              position: 'absolute',
              zIndex: 20,
              borderRadius: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
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
        </div>
      )}

      {/* Right info card */}
      <div className="w-[300px] shrink-0 mt-3 rounded-xl border bg-background px-4 py-4 flex flex-col gap-3">
        <div className={cn(
          'flex items-center',
          keyboardActive ? 'text-emerald-500' : 'text-muted-foreground',
        )} style={{ gap: 6 }}>
          <ScanLine className="h-3.5 w-3.5 shrink-0" />
          <span className="text-[12px] font-medium">Focus</span>
        </div>

        {joined && (
          <div className="flex items-center" style={{ gap: 6 }}>
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: fpsColor }} />
            <span className="text-[12px] font-mono text-foreground/75">{fps}</span>
            <span className="text-[12px] text-muted-foreground">fps</span>
          </div>
        )}

        {statusText && (
          <p className="text-[12px] text-muted-foreground leading-relaxed">{statusText}</p>
        )}
      </div>

      </div>
    </div>
  );
}
