'use client';

import { useCallback, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import { IOSViewer } from './simulator/IOSViewer';
import { AndroidViewer } from './simulator/AndroidViewer';
import type { AndroidButton, ChromeData, RelayMessage } from '@/lib/types';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  onRecordingUploaded?: () => void;
}

type AndroidChrome = { buttons: AndroidButton[]; streamType: 'h264' };

export function SimulatorViewer({ sessionId, deviceId, buildId, onRecordingUploaded }: Props) {
  const sendRef = useRef<(msg: object) => void>(() => {});

  const [joined, setJoined] = useState(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const [chrome, setChrome] = useState<ChromeData | AndroidChrome | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  // Active viewer registers its binary frame decoder here.
  // SimulatorViewer routes incoming binary frames to whichever viewer is mounted.
  const binaryFrameHandlerRef = useRef<((data: ArrayBuffer) => void) | undefined>(undefined);

  const handleMessage = useCallback((msg: RelayMessage) => {
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
      setChrome(null); // causes active viewer to unmount → cleanup
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
  }, [sessionId, deviceId, buildId]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    binaryFrameHandlerRef.current?.(data);
  }, []);

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame);
  sendRef.current = send;

  // Derive platform from chrome payload shape
  const iosChrome = chrome !== null && 'framePng' in chrome ? chrome as ChromeData : null;
  const androidChrome = chrome !== null && !('framePng' in chrome) ? chrome as AndroidChrome : null;

  const commonProps = {
    sessionId, buildId, send, connected, joined,
    deviceReady, installing, installed, installError, bootError,
    launching, setLaunching,
    binaryFrameHandlerRef,
    onRecordingUploaded,
  };

  return (
    <>
      {iosChrome && <IOSViewer {...commonProps} chrome={iosChrome} />}
      {androidChrome && <AndroidViewer {...commonProps} androidButtons={androidChrome.buttons} />}
    </>
  );
}
