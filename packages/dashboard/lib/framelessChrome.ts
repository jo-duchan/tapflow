import type { ChromeData } from '@/lib/types'

/** A 1×1 transparent PNG. Not an empty string: `IOSDeviceScreen` loads `framePng` into an `<img>` and
 *  `IOSViewer` into an `Image` for recording, and an empty data URL is a broken image in both. */
const TRANSPARENT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

/** In the chrome's 2× units. */
const HEIGHT = 1500

const made = new Map<string, ChromeData>()
const frameless = new WeakSet<ChromeData>()

/**
 * The chrome the iOS viewer is given when the agent sent none: the screen alone, filling the canvas, with
 * no frame image and no side buttons.
 *
 * An iOS agent sends no chrome when it cannot build one — a model missing from Xcode's chrome map, a
 * failed render, or a cold build that ran past its time budget — and the viewer used to stay on the
 * skeleton for the whole session while the stream ran behind it.
 *
 * `shape` gives only the aspect. Its pixels depend on the transport tier — a plain-HTTP LAN stream is
 * scaled down to about 1000px — and taken as they are the viewer shrank to match, smaller than one with
 * its frame. So the chrome is always `HEIGHT` tall, the 750px the viewer is drawn at. Touch is mapped
 * relative to `screenRect`, so a wrong aspect stretches the picture and never misplaces a tap.
 *
 * **One object per shape, for good.** The viewer's effects and pointer handlers depend on the chrome's
 * identity, and a new object on every render would tear them down each time. The map holds a handful of
 * entries at most: one per shape a session has seen.
 */
export function framelessChrome(shape: { width: number; height: number }): ChromeData {
  const height = HEIGHT
  const width = Math.round(HEIGHT * shape.width / shape.height)
  const key = `${width}x${height}`
  const cached = made.get(key)
  if (cached) return cached
  const chrome: ChromeData = {
    framePng: TRANSPARENT_PNG,
    bezelWidth: width,
    bezelHeight: height,
    compositeWidth: width,
    compositeHeight: height,
    padding: { left: 0, right: 0, top: 0, bottom: 0 },
    screenRect: { x: 0, y: 0, width, height },
    // A modern iPhone's corners, roughly (an SE's square ones would look like a cropped picture), and an
    // iPad's much smaller ones: at the phone's ratio an iPad's content would be visibly cut at the corners.
    // Told apart by shape, since this is all there is to go on — every iPad is wider than 0.6.
    screenCornerRadius: Math.round(width * (width / height > 0.6 ? 0.03 : 0.12)),
    logicalWidth: Math.round(width / 2),
    logicalHeight: Math.round(height / 2),
    buttons: [],
  }
  made.set(key, chrome)
  frameless.add(chrome)
  return chrome
}

export function isFramelessChrome(chrome: ChromeData): boolean {
  return frameless.has(chrome)
}
