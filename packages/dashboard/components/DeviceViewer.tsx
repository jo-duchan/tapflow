'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import { IOSViewer } from './device/IOSViewer';
import { AndroidViewer } from './device/AndroidViewer';
import { SimulatorInfoCard } from './device/shared/SimulatorInfoCard';
import type { AndroidChrome, ChromeData, RelayMessage } from '@/lib/types';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  resetMode?: 'app-only' | 'full-erase';
  onRecordingUploaded?: () => void;
}

export function DeviceViewer({ sessionId, deviceId, buildId, resetMode, onRecordingUploaded }: Props) {
  const sendRef = useRef<(msg: object) => void>(() => {});

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
  const binaryFrameHandlerRef = useRef<((data: ArrayBuffer) => void) | undefined>(undefined);

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
  }, [sessionId, deviceId, buildId]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    binaryFrameHandlerRef.current?.(data);
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

  return (
    <>
      {iosChrome && <IOSViewer {...commonProps} chrome={iosChrome} />}
      {androidChrome && <AndroidViewer
        {...commonProps}
        androidButtons={androidChrome.buttons}
        screenWidth={androidChrome.screenWidth}
        screenHeight={androidChrome.screenHeight}
        deviceRotation={deviceRotation}
        skinBackPng={androidChrome.skinBackPng}
        skinScreenRect={androidChrome.skinScreenRect}
        skinCompositeSize={androidChrome.skinCompositeSize}
        skinCornerRadius={androidChrome.skinCornerRadius}
      />}
    </>
  );
}
