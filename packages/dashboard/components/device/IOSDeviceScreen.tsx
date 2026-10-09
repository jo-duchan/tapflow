'use client';

import { Fragment } from 'react';
import type { Dispatch, HTMLAttributes, PointerEvent, ReactNode, SetStateAction } from 'react';
import type { FormFactor } from '@tapflowio/protocol'
import { buttonHitRect, buttonTargets, buttonTitles } from '@/lib/buttonHit';
import { iosScreenLayout } from '@/lib/iosScreenLayout';
import type { ChromeData } from '@/lib/types'
import type { IOSScreen } from '@/hooks/useIOSScreen';

/** The frame buttons' interactive half. Without it the buttons are drawn at rest and cannot be pressed. */
export interface IOSFrameButtonControls {
  hovered: string | null;
  flashed: string | null;
  onHoverChange: Dispatch<SetStateAction<string | null>>;
  onPress: (name: string, e: PointerEvent) => void;
}

type ContainerHandlers = Pick<HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave'>;

interface IOSDeviceScreenProps {
  screen: IOSScreen;
  chrome: ChromeData;
  /** What the agent reported the device to be. Decides whether a volume button's tooltip follows
   *  the orientation (an iPad's does); absent reads as a phone. */
  formFactor?: FormFactor;
  /** Turns the device on screen. iOS orientation is the viewer's own state; no message carries it. */
  isLandscape: boolean;
  /** Joined to a session: the waiting overlay speaks only then. */
  joined: boolean;
  fps: number;
  containerHandlers?: ContainerHandlers;
  buttons?: IOSFrameButtonControls;
  /** Drawn inside the device, in its (possibly rotated) space — the pinch hints. */
  overlay?: ReactNode;
  /** Drawn beside the device in the unrotated screen area — the live cursor. */
  areaOverlay?: ReactNode;
}

/**
 * **The iOS device as it is drawn, with nothing that sends.** Frame, mirror canvas, skeleton, the
 * waiting overlay and the frame buttons' images. `IOSViewer` wraps it with the controls; a watch-only
 * page renders it as it is, so a change to how the device looks lands in one place.
 */
export function IOSDeviceScreen({
  screen, chrome, formFactor, isLandscape, joined, fps,
  containerHandlers, buttons, overlay, areaOverlay,
}: IOSDeviceScreenProps) {
  const { canvasRef, containerRef, screenAreaRef, canvasReady, stalled } = screen;
  const { displayW, displayH, screenBox } = iosScreenLayout(chrome);
  const box = { width: chrome.compositeWidth, height: chrome.compositeHeight };
  const targets = buttonTargets(chrome.buttons, box);
  const titles = buttonTitles(chrome.buttons, box, isLandscape, formFactor);

  return (
    <div ref={screenAreaRef} style={{ width: isLandscape ? displayH : displayW, height: isLandscape ? displayW : displayH, position: 'relative', flexShrink: 0 }}>
      <div
        ref={containerRef}
        className="relative cursor-default"
        style={{
          width: displayW, height: displayH,
          ...(isLandscape ? { position: 'absolute', top: (displayW - displayH) / 2, left: (displayH - displayW) / 2, transform: 'rotate(-90deg)', transformOrigin: 'center center' } : {}),
        }}
        {...containerHandlers}
      >
        <img
          src={`data:image/png;base64,${chrome.framePng}`}
          style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
          draggable={false} alt=""
        />
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute', zIndex: 3,
            ...screenBox,
            backgroundColor: '#010101', cursor: 'none',
            visibility: canvasReady ? 'visible' : 'hidden',
          }}
        />
        {!canvasReady && (
          <div className="absolute overflow-hidden" style={{ zIndex: 3, ...screenBox }}>
            <div className="absolute inset-0 animate-pulse bg-zinc-700" />
          </div>
        )}
        {overlay}
        {joined && fps === 0 && (!canvasReady || stalled) && (
          <div data-testid="screen-waiting" className="absolute overflow-hidden pointer-events-none flex items-center justify-center" style={{ zIndex: 8, ...screenBox }}>
            {/* Over a picture already on screen — a restart, a stalled stream — white text alone was
                unreadable, so the screen is dimmed behind it. Before the first frame the skeleton
                under it is dark enough already. */}
            {canvasReady && <div aria-hidden="true" className="absolute inset-0 bg-black/60 bg-screen-shimmer bg-[length:200%_100%] animate-screen-shimmer motion-reduce:animate-none" />}
            <span className="relative text-sm text-white">{canvasReady ? 'Waiting for next frame...' : 'Waiting for first frame...'}</span>
          </div>
        )}
        {chrome.buttons.map((btn, i) => {
          const isFlashed = buttons?.flashed === btn.name; const isHovered = buttons?.hovered === btn.name
          const isTopAnchor = btn.anchor === 'top'
          // **One formula for where a button sits at rest**, shared with the hit test. It used
          // to be written out three times here — `imgTopPct`, `tooltipTopPct` and the hit test —
          // and the first two even kept a `bottom` branch whose body was byte-identical to the
          // default, which is exactly where a future bottom-anchor tweak would land and leave
          // the target behind the pixels.
          const rect = buttonHitRect(btn)
          const imgTopPct = (rect.top / chrome.compositeHeight) * 100
          const imgHPct = (btn.buttonH / chrome.compositeHeight) * 100
          const imgWPct = (btn.buttonW / chrome.compositeWidth) * 100
          const halfW = btn.buttonW / 2
          const rolloverLeftPct = (rect.left / chrome.compositeWidth) * 100
          const hoverLeftPct = ((2 * btn.rolloverOffset.x - btn.normalOffset.x - halfW) / chrome.compositeWidth) * 100
          const tooltipLeftPct = (btn.rolloverOffset.x / chrome.compositeWidth) * 100
          const tooltipTopPct = imgTopPct
          const hoverTopPct = isTopAnchor ? ((2 * btn.rolloverOffset.y - btn.normalOffset.y) / chrome.compositeHeight) * 100 : 0
          const btnZ = btn.onTop ? 4 : 1
          const target = targets[i]
          return (
            <Fragment key={btn.name}>
              {/* The press target. Hidden from assistive tech and out of the tab order on
                  purpose: the frame is part of the streamed device, which this package leaves
                  out of scope — see "The streamed device is out of scope" in AGENTS.md. It sits
                  still while the image beside it slides on hover, or hovering would move the
                  target out from under the pointer. Absent when nobody can press. */}
              {buttons && (
                <div
                  data-frame-button={btn.name}
                  aria-hidden="true"
                  onPointerDown={(e) => buttons.onPress(btn.name, e)}
                  onPointerEnter={() => buttons.onHoverChange(btn.name)}
                  onPointerLeave={() => buttons.onHoverChange((h) => (h === btn.name ? null : h))}
                  style={{
                    position: 'absolute', zIndex: 6, cursor: 'pointer',
                    left: `${(target.left / chrome.compositeWidth) * 100}%`,
                    top: `${(target.top / chrome.compositeHeight) * 100}%`,
                    width: `${((target.right - target.left) / chrome.compositeWidth) * 100}%`,
                    height: `${((target.bottom - target.top) / chrome.compositeHeight) * 100}%`,
                  }}
                />
              )}
              {btn.buttonPng && (
                <img src={`data:image/png;base64,${btn.buttonPng}`} style={{
                  position: 'absolute', zIndex: btnZ,
                  top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : imgTopPct}%`,
                  left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                  width: `${imgWPct}%`, height: `${imgHPct}%`,
                  transition: isTopAnchor ? 'top 0.15s ease' : 'left 0.15s ease',
                  pointerEvents: 'none', userSelect: 'none',
                }} draggable={false} alt="" />
              )}
              {isFlashed && btn.pressedPng && btn.pressedRect && (
                <img src={`data:image/png;base64,${btn.pressedPng}`} style={{
                  position: 'absolute', zIndex: btn.onTop ? 3 : 1,
                  left: `${isTopAnchor ? rolloverLeftPct : isHovered ? hoverLeftPct : rolloverLeftPct}%`,
                  top: `${isTopAnchor ? (isHovered ? hoverTopPct : imgTopPct) : imgTopPct}%`,
                  width: `${(btn.pressedRect.width / chrome.compositeWidth) * 100}%`,
                  height: `${(btn.pressedRect.height / chrome.compositeHeight) * 100}%`,
                  pointerEvents: 'none', userSelect: 'none',
                }} draggable={false} alt="" />
              )}
              {isHovered && (
                <div
                  className="bg-foreground/85 text-background text-[11px] px-[7px] py-1.5 rounded-lg whitespace-nowrap pointer-events-none"
                  style={{
                    position: 'absolute', zIndex: 5, left: `${tooltipLeftPct}%`, top: `${tooltipTopPct}%`,
                    transform: 'translate(-50%, calc(-100% - 8px))',
                  }}
                >
                  {titles[i]}
                </div>
              )}
            </Fragment>
          )
        })}
      </div>
      {areaOverlay}
    </div>
  );
}
