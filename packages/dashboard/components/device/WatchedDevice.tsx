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
import { iosScreenLayout } from '@/lib/iosScreenLayout';
import { iosTurn, turnPoint, type Turn } from '@/lib/coordinate-transform';
import { TouchMarksLayer } from '@/components/touch/TouchMarksLayer';
import { placeOnIosFrame } from '@/lib/watchActions';
import type { MachineTouch } from '@/lib/touchMarks';

interface WatchedDeviceProps {
  chrome: ChromePayload | null;
  deviceReady: boolean;
  /** From the device list, for the two decisions the chrome cannot make: which device to draw before
   *  any chrome, and whether an iOS device that sent none by `device:ready` gets the frameless one. */
  platform: string;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  /** A recorded video rather than a live stream: no "waiting for frame" — a paused replay has no frames coming. */
  replay?: boolean;
  /** Remounts the screen (a new decoder) when it changes, keeping what this component learned — the stream's size
   *  for a frameless device — so a replay's seek does not redraw the frame at a guessed size first. */
  screenKey?: string | number;
  /** The holder's latest touch to draw on the device (A2), in the machine's colour. The live watch page passes it
   *  (null before the first); a replay does not. */
  touch?: MachineTouch | null;
}

/**
 * **The device a watcher sees: the screen and nothing that sends.** The same drawing the QA session uses
 * (`IOSDeviceScreen` / `AndroidDeviceScreen`), with none of the controls — no toolbar, no input, no
 * recording. A device that reports its own turn (iOS `streamRotation`, Android `bodyRotation`) is drawn as
 * reported; one that does not is drawn upright, since the holder's toggle is its own state and not on the wire.
 */
export function WatchedDevice({ chrome, deviceReady, platform, formFactor, binaryFrameHandlerRef, replay = false, screenKey, touch }: WatchedDeviceProps) {
  const [streamSize, setStreamSize] = useState<{ width: number; height: number } | null>(null);
  // Choosing which screen to mount is routing, not drawing — the same split `DeviceViewer` makes, and for
  // the same reason: an iOS agent that could not build a frame sends none, and the stream must still show.
  const sentIos = chrome !== null && 'framePng' in chrome ? (chrome as ChromeData) : null;
  const android = chrome !== null && !('framePng' in chrome) ? (chrome as AndroidChrome) : null;
  const ios = sentIos ?? (deviceReady && platform === 'ios' && !android
    // A replay with no recorded chrome draws the picture square-cornered: the rounding is a guess, not the device's.
    ? framelessChrome(streamSize ?? skeletonSize(formFactor, platform), replay ? 0 : undefined)
    : null);

  if (ios) {
    return <WatchedIOS key={screenKey} chrome={ios} formFactor={formFactor} binaryFrameHandlerRef={binaryFrameHandlerRef} onStreamSize={setStreamSize} replay={replay} touch={touch} />;
  }
  if (android) {
    return <WatchedAndroid key={screenKey} chrome={android} deviceReady={deviceReady} binaryFrameHandlerRef={binaryFrameHandlerRef} touch={touch} />;
  }
  return (
    <div aria-hidden="true" style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px' }}>
      <div data-testid="watch-skeleton" className="animate-pulse bg-zinc-700" style={{ ...skeletonSize(formFactor, platform), borderRadius: '22px' }} />
    </div>
  );
}

function WatchedIOS({ chrome, formFactor, binaryFrameHandlerRef, onStreamSize, replay, touch }: {
  chrome: ChromeData;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  onStreamSize: (size: { width: number; height: number }) => void;
  replay: boolean;
  touch?: MachineTouch | null;
}) {
  const { fps, frameCount } = useFps();
  const screen = useIOSScreen({ chrome, binaryFrameHandlerRef, fps, frameCount, onCanvasResize: onStreamSize });
  // The overlay spans the whole frame on iOS, so a point goes through where the screen sits in it.
  const place = placeOnIosFrame(iosScreenLayout(chrome));
  return (
    <>
      {/* `joined` is what lets the screen say a live stream stalled; a replay is never waiting on one. */}
      <IOSDeviceScreen
        screen={screen} chrome={chrome} formFactor={formFactor} turn={iosTurn(chrome.streamRotation, false)} joined={!replay} fps={fps}
        overlay={touch !== undefined ? <TouchMarksLayer tone="machine" touch={touch} place={place} /> : undefined}
      />
      {screen.decoderUnsupported && <UnsupportedDecoder />}
    </>
  );
}

function WatchedAndroid({ chrome, deviceReady, binaryFrameHandlerRef, touch }: {
  chrome: AndroidChrome;
  deviceReady: boolean;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  touch?: MachineTouch | null;
}) {
  const { frameCount } = useFps();
  const screen = useAndroidScreen({
    binaryFrameHandlerRef, frameCount,
    screenWidth: chrome.screenWidth, screenHeight: chrome.screenHeight,
    streamRotation: chrome.streamRotation ?? 0, cornerRadius: chrome.cornerRadius,
    userWantsLandscape: false, rotatePending: false, bodyRotation: chrome.bodyRotation,
  });
  return (
    <>
      {/* The overlay is the frame on Android, and a watcher's device is upright: a screen point is turned onto it, a frame point sits as it is. */}
      <AndroidDeviceScreen
        screen={screen} deviceReady={deviceReady} posturePending={false}
        overlay={touch !== undefined ? <TouchMarksLayer tone="machine" touch={touch} place={(x, y) => {
          // A body-mode holder sends the frame's own points (`space: 'frame'`): the shell is that frame, so they sit as
          // they are. Placed through the screen's turn they landed a quarter off (design review of #1204's follow-up).
          if (touch?.space === 'frame') return { left: x, top: y }
          // Marks are in the screen Android draws (the input's space); body mode's shell is the frame.
          const p = turnPoint({ x, y }, ((360 - screen.screenTurn) % 360) as Turn)
          return { left: p.x, top: p.y }
        }} /> : undefined}
      />
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
