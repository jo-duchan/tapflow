import { iosDisplayScale } from '@/lib/coordinate-transform'
import { roundedClipMask } from '@/lib/roundedClipMask'
import type { ChromeData } from '@/lib/types'

const MAX_DISPLAY_H = 750;

/** Where the device and its screen sit, in CSS — the screen component draws with it, and the controls
 *  place their overlays (pinch hints) with the same numbers. */
export function iosScreenLayout(chrome: ChromeData) {
  const compositeLogicalW = chrome.compositeWidth / 2;
  const compositeLogicalH = chrome.compositeHeight / 2;
  const displayScale = iosDisplayScale(compositeLogicalH, MAX_DISPLAY_H);
  const displayW = Math.round(compositeLogicalW * displayScale);
  const displayH = Math.round(compositeLogicalH * displayScale);
  const screenPctLeft = (chrome.screenRect.x / chrome.compositeWidth) * 100;
  const screenPctTop = (chrome.screenRect.y / chrome.compositeHeight) * 100;
  const screenPctW = (chrome.screenRect.width / chrome.compositeWidth) * 100;
  const screenPctH = (chrome.screenRect.height / chrome.compositeHeight) * 100;
  const cssCornerRadius = Math.round((chrome.screenCornerRadius / 2) * displayScale);
  const clipMask = cssCornerRadius > 0 ? roundedClipMask(navigator.userAgent) : undefined;
  // **Where the screen is, said once.** The canvas takes these, and so does the box below that holds
  // what is drawn over the screen, which clips to the same corners — so nothing inside it is placed or
  // rounded on its own.
  const screenBox = {
    left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
    width: `${screenPctW}%`, height: `${screenPctH}%`,
    borderRadius: cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined,
    maskImage: clipMask,
  };
  return { displayW, displayH, screenPctLeft, screenPctTop, screenPctW, screenPctH, screenBox };
}
