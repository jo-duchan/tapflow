/** Normalized screen coordinate, each axis in [0, 1]. */
export type NormPoint = { x: number; y: number }

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
  point: NormPoint,
  rect: { left: number; top: number; width: number; height: number },
  compositeW: number,
  compositeH: number,
  screenRect: { x: number; y: number; width: number; height: number },
  isLandscape: boolean,
): NormPoint | null {
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
  point: NormPoint,
  rect: { left: number; top: number; width: number; height: number },
  needsCSSRotation: boolean,
): NormPoint | null {
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
export function toPinchFingers(f1: NormPoint): { f0: NormPoint; f1: NormPoint } {
  return { f0: { x: 1 - f1.x, y: 1 - f1.y }, f1 }
}

/**
 * Compute the display scale factor for an iOS chrome composite.
 * Caps the rendered height at `maxDisplayH` CSS pixels.
 */
export function iosDisplayScale(compositeLogicalH: number, maxDisplayH: number): number {
  return compositeLogicalH > 0 ? Math.min(1, maxDisplayH / compositeLogicalH) : 1
}
