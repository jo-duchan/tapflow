// The normalized 0-1 screen coordinate is the wire's own `Point` — the payload of
// `input:touch:*`. Re-exported under this package's name, which says the units out loud.
import type { Point } from '@tapflowio/protocol'
export type { Point as NormPoint }

/**
 * Convert a raw pointer position to a normalized screen coordinate for iOS.
 *
 * In landscape mode the container div is not CSS-rotated (the inner element is),
 * so `rect` is always the unrotated bounding rect. The rotation mapping is:
 *   portrait_x = 1 - v,  portrait_y = u
 * where u = horizontal fraction, v = vertical fraction of the unrotated rect.
 *
 * `compositeW` / `compositeH` and `screenRect` fields should already be halved
 * (chrome JSON stores 2× values; the caller divides by 2 before passing here).
 */
export function iosToNormScreen(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  compositeW: number,
  compositeH: number,
  screenRect: { x: number; y: number; width: number; height: number },
  isLandscape: boolean,
): Point | null {
  const { x: sx, y: sy, width: sw, height: sh } = screenRect
  let cx: number, cy: number
  if (isLandscape) {
    const u = (point.x - rect.left) / rect.width
    const v = (point.y - rect.top) / rect.height
    cx = (1 - v) * compositeW
    cy = u * compositeH
  } else {
    cx = (point.x - rect.left) * (compositeW / rect.width)
    cy = (point.y - rect.top) * (compositeH / rect.height)
  }
  if (cx < sx || cx > sx + sw || cy < sy || cy > sy + sh) return null
  return { x: (cx - sx) / sw, y: (cy - sy) / sh }
}

/**
 * Convert a raw pointer position to a normalized screen coordinate for Android.
 *
 * When the canvas is CSS-rotated 90° CW (portrait content in landscape shell):
 *   portrait_x = yv,  portrait_y = 1 - xv
 */
export function androidToNorm(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  needsCSSRotation: boolean,
): Point | null {
  const xv = (point.x - rect.left) / rect.width
  const yv = (point.y - rect.top) / rect.height
  if (xv < 0 || xv > 1 || yv < 0 || yv > 1) return null
  if (needsCSSRotation) return { x: yv, y: 1 - xv }
  return { x: xv, y: yv }
}

/**
 * Given the second finger's normalized position, return both finger positions
 * for a pinch gesture. The first finger is the point-symmetric counterpart.
 */
export function toPinchFingers(f1: Point): { f0: Point; f1: Point } {
  return { f0: { x: 1 - f1.x, y: 1 - f1.y }, f1 }
}

/**
 * Compute the display scale factor for an iOS chrome composite.
 * Caps the rendered height at `maxDisplayH` CSS pixels.
 */
export function iosDisplayScale(compositeLogicalH: number, maxDisplayH: number): number {
  return compositeLogicalH > 0 ? Math.min(1, maxDisplayH / compositeLogicalH) : 1
}

/**
 * Additional shrink factor (<=1) needed so a `boxWidth`-wide element fits within `maxWidth`.
 * `maxWidth <= 0` means the container hasn't been measured yet (or there is no width limit,
 * e.g. a test rendering the viewer standalone) — no constraint is applied.
 */
export function widthFitScale(boxWidth: number, maxWidth: number): number {
  return maxWidth > 0 ? Math.min(1, maxWidth / boxWidth) : 1
}

// Real layout widths (CSS px) the width-budget math below has to account for — read off the
// exact classes/styles the components render, not estimated:
//  - toolbar column (SimulatorToolbar.tsx): `h-8 w-8` buttons (32) + `px-1.5` padding (2×6) + border (~2)
//  - `gap-16` / `gap-8` (Tailwind spacing scale: 4rem / 2rem at the default 16px root)
//  - info card (SimulatorInfoCard.tsx): its own fixed width when not stacked
//  - bezel padding (AndroidViewer.tsx's device bezel, and DeviceViewer.tsx's pre-chrome
//    skeleton phone — both use `padding: '12px'` on all four sides around the device box)
export const TOOLBAR_COLUMN_W = 48
export const ROW_GAP_16_PX = 64
export const ROW_GAP_8_PX = 32
export const INFO_CARD_W = 300
export const BEZEL_PADDING_W = 24

/**
 * Whether the toolbar, device box and info card fit beside each other (in one row, as the
 * desktop layout does) within `widthBudget`. `extraReservedW` covers a platform-specific extra
 * that always sits around the device box (e.g. Android's bezel padding).
 *
 * `widthBudget` falsy (unmeasured) defaults to true — same "unconstrained" fallback as
 * `widthFitScale`.
 */
export function fitsSideBySide(widthBudget: number | undefined, naiveBoxW: number, extraReservedW = 0): boolean {
  if (!widthBudget) return true
  return widthBudget >= TOOLBAR_COLUMN_W + ROW_GAP_16_PX + naiveBoxW + ROW_GAP_8_PX + INFO_CARD_W + extraReservedW
}
