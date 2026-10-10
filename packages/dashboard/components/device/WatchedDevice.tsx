'use client';

import { useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FormFactor } from '@tapflowio/protocol'
import { useFps } from '@/hooks/useFps';
import { useIOSScreen } from '@/hooks/useIOSScreen';
import { useAndroidScreen } from '@/hooks/useAndroidScreen';
import { IOSDeviceScreen } from './IOSDeviceScreen';
import { AndroidDeviceScreen } from './AndroidDeviceScreen';
import { framelessChrome } from '@/lib/framelessChrome';
import { skeletonSize } from '@/lib/deviceSkeleton';
import type { BinaryFrameHandler } from '@/lib/envelope';
import type { AndroidChrome, ChromeData, ChromePayload } from '@/lib/types';

interface WatchedDeviceProps {
  chrome: ChromePayload | null;
  deviceReady: boolean;
  /** From the device list, for the two decisions the chrome cannot make: which device to draw before
   *  any chrome, and whether an iOS device that sent none by `device:ready` gets the frameless one. */
  platform: string;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
}

/**
 * **The device a watcher sees: the screen and nothing that sends.** The same drawing the QA session uses
 * (`IOSDeviceScreen` / `AndroidDeviceScreen`), with none of the controls — no toolbar, no input, no
 * recording. Rotation is the holder's own state and not on the wire, so the device is drawn upright; no
 * AI client rotates today.
 */
export function WatchedDevice({ chrome, deviceReady, platform, formFactor, binaryFrameHandlerRef }: WatchedDeviceProps) {
  const [streamSize, setStreamSize] = useState<{ width: number; height: number } | null>(null);
  // Choosing which screen to mount is routing, not drawing — the same split `DeviceViewer` makes, and for
  // the same reason: an iOS agent that could not build a frame sends none, and the stream must still show.
  const sentIos = chrome !== null && 'framePng' in chrome ? (chrome as ChromeData) : null;
  const android = chrome !== null && !('framePng' in chrome) ? (chrome as AndroidChrome) : null;
  const ios = sentIos ?? (deviceReady && platform === 'ios' && !android
    ? framelessChrome(streamSize ?? skeletonSize(formFactor, platform))
    : null);

  if (ios) {
    return <WatchedIOS chrome={ios} formFactor={formFactor} binaryFrameHandlerRef={binaryFrameHandlerRef} onStreamSize={setStreamSize} />;
  }
  if (android) {
    return <WatchedAndroid chrome={android} deviceReady={deviceReady} binaryFrameHandlerRef={binaryFrameHandlerRef} />;
  }
  return (
    <div aria-hidden="true" style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px' }}>
      <div data-testid="watch-skeleton" className="animate-pulse bg-zinc-700" style={{ ...skeletonSize(formFactor, platform), borderRadius: '22px' }} />
    </div>
  );
}

function WatchedIOS({ chrome, formFactor, binaryFrameHandlerRef, onStreamSize }: {
  chrome: ChromeData;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  onStreamSize: (size: { width: number; height: number }) => void;
}) {
  const { fps, frameCount } = useFps();
  const screen = useIOSScreen({ chrome, binaryFrameHandlerRef, fps, frameCount, onCanvasResize: onStreamSize });
  return (
    <>
      <IOSDeviceScreen screen={screen} chrome={chrome} formFactor={formFactor} isLandscape={false} joined fps={fps} />
      {screen.decoderUnsupported && <UnsupportedDecoder />}
    </>
  );
}

function WatchedAndroid({ chrome, deviceReady, binaryFrameHandlerRef }: {
  chrome: AndroidChrome;
  deviceReady: boolean;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
}) {
  const { frameCount } = useFps();
  const screen = useAndroidScreen({
    binaryFrameHandlerRef, frameCount,
    screenWidth: chrome.screenWidth, screenHeight: chrome.screenHeight,
    streamRotation: chrome.streamRotation ?? 0, cornerRadius: chrome.cornerRadius,
    userWantsLandscape: false, rotatePending: false,
  });
  return (
    <>
      <AndroidDeviceScreen screen={screen} deviceReady={deviceReady} posturePending={false} />
      {screen.decoderUnsupported && <UnsupportedDecoder />}
    </>
  );
}

/** The QA session says this in its status card; a watch page has no card, so it says it here. */
function UnsupportedDecoder() {
  return (
    <p role="status" className="max-w-xs text-sm text-muted-foreground">
      Streaming is not supported in this environment.
    </p>
  );
}
