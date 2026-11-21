import { iosDisplayScale } from '@/lib/coordinate-transform'
import { roundedClipMask } from '@/lib/roundedClipMask'
import type { ChromeData } from '@/lib/types'

const MAX_DISPLAY_H = 750;

/** Where the device and its screen sit, in CSS — the screen component draws with it, and the controls
 *  place their overlays (the touch marks) with the same numbers. */
export function iosScreenLayout(chrome: ChromeData) {
  const compositeLogicalW = chrome.compositeWidth / 2;
  const compositeLogicalH = chrome.compositeHeight / 2;
  // A multi-panel device is sized by its largest panel, so every panel is drawn at one scale and the cover
  // stays half the unfolded device (`ChromeData.scaleBasis`). Anything else is sized by its own frame.
  const displayScale = iosDisplayScale((chrome.scaleBasis ?? chrome.compositeHeight) / 2, MAX_DISPLAY_H);
  const displayW = Math.round(compositeLogicalW * displayScale);
  const displayH = Math.round(compositeLogicalH * displayScale);
  const screenPctLeft = (chrome.screenRect.x / chrome.compositeWidth) * 100;
  const screenPctTop = (chrome.screenRect.y / chrome.compositeHeight) * 100;
  const screenPctW = (chrome.screenRect.width / chrome.compositeWidth) * 100;
  const screenPctH = (chrome.screenRect.height / chrome.compositeHeight) * 100;
  const css = (r: number) => Math.round((r / 2) * displayScale);
  const cssCornerRadius = css(chrome.screenCornerRadius);
  // A panel rounded unevenly (the iPhone Duo's cover: square at the hinge) spells its corners out.
  const radii = chrome.screenCornerRadii;
  const borderRadius = radii
    ? `${css(radii.topLeft)}px ${css(radii.topRight)}px ${css(radii.bottomRight)}px ${css(radii.bottomLeft)}px`
    : cssCornerRadius > 0 ? `${cssCornerRadius}px` : undefined;
  const clipMask = cssCornerRadius > 0 ? roundedClipMask(navigator.userAgent) : undefined;
  // **Where the screen is, said once.** The canvas takes these, and so does the box `IOSDeviceScreen`
  // puts over the screen for the skeleton and the waiting overlay, which clips to the same corners — so nothing inside it is placed or
  // rounded on its own.
  const screenBox = {
    left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
    width: `${screenPctW}%`, height: `${screenPctH}%`,
    borderRadius,
    maskImage: clipMask,
  };
  return { displayW, displayH, screenPctLeft, screenPctTop, screenPctW, screenPctH, screenBox };
}
