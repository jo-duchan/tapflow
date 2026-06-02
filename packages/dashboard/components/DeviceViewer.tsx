'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import { usePerfMode } from '@/hooks/usePerfMode';
import { IOSViewer } from './device/IOSViewer';
import { AndroidViewer } from './device/AndroidViewer';
import { SimulatorInfoCard } from './device/shared/SimulatorInfoCard';
import type { AndroidButton, ChromeData, RelayMessage } from '@/lib/types';
import type { FrameTiming, PerfHook } from './perf/types';
import { parseEnvelopeHeader, HEADER_SIZE, CODEC_H264, type BinaryFrameHandler } from '@/lib/envelope';
import { StatsOverlay } from './perf/StatsOverlay';
import { MetricsPanel } from './perf/MetricsPanel';
import { toast } from 'sonner';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  resetMode?: 'app-only' | 'full-erase';
  onRecordingUploaded?: () => void;
}

type AndroidChrome = { buttons: AndroidButton[]; streamType: 'h264'; screenWidth?: number; screenHeight?: number };

export function DeviceViewer({ sessionId, deviceId, buildId, resetMode, onRecordingUploaded }: Props) {
  const sendRef = useRef<(msg: object) => void>(() => {});
  const { perfMode, visible: perfVisible } = usePerfMode();

  // statsRef is set by StatsOverlay; perfMetricsPushRef is set by MetricsPanel
  const statsRef = useRef<PerfHook | null>(null);
  const perfMetricsPushRef = useRef<((t: FrameTiming) => void) | null>(null);
  // FIFO queue: one entry pushed per incoming frame, shifted on paint completion.
  // Prevents mis-attribution when multiple frames are in-flight through async decoders.
  const envelopeQueueRef = useRef<Array<{ capturedAt: number; relayedAt: number } | null>>([]);

  // Viewers call these; both are no-ops when overlays are not mounted
  const perfHookRef = useRef<PerfHook>({
    onFrameBegin: () => statsRef.current?.onFrameBegin(),
    onFrameEnd: (t) => {
      const env = envelopeQueueRef.current.shift() ?? null;
      const timing: FrameTiming = env ? { ...t, capturedAt: env.capturedAt, relayedAt: env.relayedAt } : t;
      statsRef.current?.onFrameEnd(timing);
      perfMetricsPushRef.current?.(timing);
    },
  });

  const [joined, setJoined] = useState(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const [chrome, setChrome] = useState<ChromeData | AndroidChrome | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [deviceRotation, setDeviceRotation] = useState(0);
  const [swKeyboardVisible, setSwKeyboardVisible] = useState(false);
  const [swKeyboardPending, setSwKeyboardPending] = useState(false);

  // Active viewer registers its binary frame decoder here.
  // SimulatorViewer routes incoming binary frames to whichever viewer is mounted.
  const binaryFrameHandlerRef = useRef<BinaryFrameHandler | undefined>(undefined);

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'session:joined') {
      setJoined(true);
      sendRef.current({ type: 'device:boot', sessionId, payload: { deviceId, resetMode } });
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
      setChrome(null); // causes active viewer to unmount → cleanup
      setDeviceRotation(0);
    }
    if (msg.type === 'device:rotate') {
      setDeviceRotation(msg.payload.rotation);
    }
    if (msg.type === 'device:ready') {
      setDeviceReady(true);
      if (buildId) { setInstalling(true); sendRef.current({ type: 'app:install', sessionId, buildId }); }
    }
    if (msg.type === 'app:install-done') { setInstalling(false); setInstalled(true); }
    if (msg.type === 'app:install-error') { setInstalling(false); setInstallError(msg.message); }
    if (msg.type === 'app:launch-done') { setLaunching(false); }
    if (msg.type === 'app:launch-error') { setLaunching(false); }
    if (msg.type === 'session:chrome') { setChrome(msg.payload); }
    if (msg.type === 'keyboard:toggled') {
      const { visible } = msg.payload as { visible: boolean };
      setSwKeyboardVisible(visible);
      setSwKeyboardPending(false);
    }
    if (msg.type === 'open-url:done') { toast.success('Deeplink opened'); }
    if (msg.type === 'open-url:error') { toast.error(msg.message); }
    if (msg.type === 'error' && msg.message === 'Agent resources exhausted') {
      toast.error('Could not start session — this Mac is currently overloaded.', {
        description: 'Go back and select a different Mac.',
      })
    }
  }, [sessionId, deviceId, buildId]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const envelope = parseEnvelopeHeader(data);
    // iOS H.264 presents asynchronously through a decoder surface; its viewer's
    // FrameLatencyTracker owns capturedAt/relayedAt correlation (via meta), so it
    // must not also go through this FIFO — a dropped frame would desync it forever.
    // JPEG (iOS) and Android stay synchronous/FIFO-matched here.
    if (!(envelope && envelope.codec === CODEC_H264)) {
      envelopeQueueRef.current.push(envelope);
    }
    const payload = envelope ? data.slice(HEADER_SIZE) : data;
    const meta = envelope
      ? { codec: envelope.codec, keyframe: envelope.keyframe, capturedAt: envelope.capturedAt, relayedAt: envelope.relayedAt }
      : undefined;
    binaryFrameHandlerRef.current?.(payload, meta);
  }, []);

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame);
  useLayoutEffect(() => { sendRef.current = send; });

  useEffect(() => {
    if (connected) send({ type: 'session:start', sessionId });
  }, [connected, send, sessionId]);

  // Derive platform from chrome payload shape
  const iosChrome = chrome !== null && 'framePng' in chrome ? chrome as ChromeData : null;
  const androidChrome = chrome !== null && !('framePng' in chrome) ? chrome as AndroidChrome : null;

  const onKbdToggle = () => {
    setSwKeyboardPending(true);
    send({ type: 'input:keyboard:toggle', sessionId });
  };

  const commonProps = {
    sessionId, buildId, send, connected, joined,
    deviceReady, installing, installed, installError, bootError,
    launching, setLaunching,
    binaryFrameHandlerRef,
    onRecordingUploaded,
    swKeyboardVisible, swKeyboardPending, onKbdToggle,
  };

  // Before chrome arrives, show a phone skeleton + status card so the layout isn't empty
  if (!iosChrome && !androidChrome) {
    return (
      <div className="flex items-start justify-center gap-16">
        {/* toolbar placeholder */}
        <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 px-1.5 py-2.5 shrink-0 mt-3 opacity-40">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 w-8 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
        <div className="flex items-start gap-8">
          {/* phone body skeleton */}
          <div style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px', flexShrink: 0 }}>
            <div className="animate-pulse bg-zinc-700" style={{ width: 324, height: 720, borderRadius: '22px' }} />
          </div>
          <SimulatorInfoCard
            joined={joined} fps={0} connected={connected}
            deviceReady={deviceReady} bootError={bootError}
            installing={installing} installError={installError}
            keyboardActive={false}
          />
        </div>
      </div>
    );
  }

  const devPerfHookRef = import.meta.env.DEV ? perfHookRef : undefined;

  return (
    <>
      {iosChrome && <IOSViewer {...commonProps} chrome={iosChrome} perfHookRef={devPerfHookRef} />}
      {androidChrome && <AndroidViewer {...commonProps} androidButtons={androidChrome.buttons} screenWidth={androidChrome.screenWidth} screenHeight={androidChrome.screenHeight} deviceRotation={deviceRotation} perfHookRef={devPerfHookRef} />}
      {import.meta.env.DEV && perfMode && perfVisible && (
        <>
          <StatsOverlay perfHookRef={statsRef} />
          <MetricsPanel pushRef={perfMetricsPushRef} />
        </>
      )}
    </>
  );
}
