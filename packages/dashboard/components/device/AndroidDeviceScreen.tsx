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
  /** Drawn over the screen — the touch marks (`TouchMarksLayer`). */
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
    containerW, containerH, screenRadius, frameMatchesScreen, pictureVisible, canvasStyle, spinDeg, spinAnimates,
  } = screen;
  // **The device turns inside an area that turns its shape with it**, as `IOSDeviceScreen` does: the area grows and
  // shrinks while the device spins, so the toolbar beside it moves with the device instead of being run over.
  const bodyW = containerW + 24; const bodyH = containerH + 24;
  const quarter = spinDeg % 180 === 90;
  const motion = spinAnimates ? 'motion-safe:duration-300 motion-safe:ease-in-out' : '';
  return (
    <div
      className={spinAnimates ? `motion-safe:transition-[width,height] ${motion}` : undefined}
      style={{ width: quarter ? bodyH : bodyW, height: quarter ? bodyW : bodyH, position: 'relative', flexShrink: 0 }}
    >
    {/* phone body bezel — outer radius stays concentric with the screen (screenRadius + 12px padding) */}
    <div
      className={spinAnimates ? `motion-safe:transition-transform ${motion}` : undefined}
      style={{
        background: '#1c1c1e', borderRadius: `${screenRadius + 12}px`, padding: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
        position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) rotate(${spinDeg}deg)`, transformOrigin: 'center center',
      }}
    >
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
    </div>
  );
}
