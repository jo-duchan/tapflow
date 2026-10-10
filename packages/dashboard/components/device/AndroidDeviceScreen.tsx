'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import type { AndroidScreen } from '@/hooks/useAndroidScreen';

type SurfaceHandlers = Pick<HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave'>;

interface AndroidDeviceScreenProps {
  screen: AndroidScreen;
  /** The device has booted: the waiting label speaks only then. */
  deviceReady: boolean;
  /** A fold is in flight — the waiting label says so. A viewer that cannot fold passes `false`. */
  posturePending: boolean;
  surfaceHandlers?: SurfaceHandlers;
  /** Drawn over the screen — the live cursor and the pinch hints. */
  overlay?: ReactNode;
}

/**
 * **The Android device as it is drawn, with nothing that sends.** Bezel, the decoder's surface host,
 * the skeleton and the waiting label. `AndroidViewer` wraps it with the controls; a watch-only page
 * renders it as it is, so a change to how the device looks lands in one place.
 */
export function AndroidDeviceScreen({ screen, deviceReady, posturePending, surfaceHandlers, overlay }: AndroidDeviceScreenProps) {
  const {
    surfaceHostRef, containerRef, decoderUnsupported,
    containerW, containerH, screenRadius, frameMatchesScreen, pictureVisible, canvasStyle,
  } = screen;
  return (
    // phone body bezel — outer radius stays concentric with the screen (screenRadius + 12px padding)
    <div style={{ background: '#1c1c1e', borderRadius: `${screenRadius + 12}px`, padding: '12px', flexShrink: 0, boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}>
      <div
        ref={containerRef}
        className="relative"
        style={{ width: containerW, height: containerH, backgroundColor: '#010101', borderRadius: `${screenRadius}px`, overflow: 'hidden' }}
      >
        {!decoderUnsupported && (
          <>
            <div
              ref={surfaceHostRef}
              style={canvasStyle}
              {...surfaceHandlers}
            />
            {!pictureVisible && (
              <div className="absolute inset-0 animate-pulse bg-zinc-700" />
            )}
            {!pictureVisible && deviceReady && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.875rem' }}>
                  {posturePending || !frameMatchesScreen ? 'Changing posture…' : 'Waiting for stream…'}
                </span>
              </div>
            )}
            {overlay}
          </>
        )}
      </div>
    </div>
  );
}
