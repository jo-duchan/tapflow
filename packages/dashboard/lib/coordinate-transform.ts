// The normalized 0-1 screen coordinate is the wire's own `Point` — the payload of
// `input:touch:*`. Re-exported under this package's name, which says the units out loud.
import type { Point } from '@tapflowio/protocol'
export type { Point as NormPoint }

/**
 * Convert a raw pointer position to a normalized screen coordinate for iOS.
 *
 * Turned, the device's container is CSS-rotated and the caller passes the unrotated box around it,
 * so `rect` is always unrotated. With u, v the pointer's fractions of that box, the frame point is:
 *   0: (u, v)   90: (v, 1 − u)   180: (1 − u, 1 − v)   270: (1 − v, u)
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
  turn: Turn,
): Point | null {
  const { x: sx, y: sy, width: sw, height: sh } = screenRect
  const u = (point.x - rect.left) / rect.width
  const v = (point.y - rect.top) / rect.height
  const [fx, fy] = turn === 90 ? [v, 1 - u] : turn === 180 ? [1 - u, 1 - v] : turn === 270 ? [1 - v, u] : [u, v]
  const cx = fx * compositeW
  const cy = fy * compositeH
  if (cx < sx || cx > sx + sw || cy < sy || cy > sy + sh) return null
  return { x: (cx - sx) / sw, y: (cy - sy) / sh }
}

/**
 * How far the iOS viewer turns the device, clockwise.
 *
 * **The agent's word wins when it gives one.** A multi-panel device (iPhone Duo) reports the turn its
 * lit panel needs, because SpringBoard turns that panel by itself and the tester's Rotate is carried
 * out on the device; adding the viewer's own quarter on top would turn it twice. Every other iPhone
 * reports nothing, and its framebuffer stays portrait while the UI turns inside it, so the viewer's
 * own landscape is the one quarter it has always applied (`rotate(-90deg)`).
 */
export function iosTurn(streamRotation: Turn | undefined, isLandscape: boolean): Turn {
  if (streamRotation !== undefined) return streamRotation
  return isLandscape ? 270 : 0
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
 * A normalised point in a picture, carried to the same point in that picture turned `turn` clockwise.
 *
 * **Android's body mode needs it in both directions.** The viewer draws the frame as the body is held, while the
 * pointer's touch marks, the recording's included, are drawn in the screen Android draws. The frame turned by
 * `streamRotation` is that screen (measured on a Pixel 9: body a quarter clockwise over a portrait-locked app,
 * frame (0,0) is screen (0,1) — 270 here). A touch is not turned here: it goes out as the frame's own point.
 */
export function turnPoint(p: Point, turn: Turn): Point {
  switch (turn) {
    case 0: return p
    case 90: return { x: 1 - p.y, y: p.x }
    case 180: return { x: 1 - p.x, y: 1 - p.y }
    case 270: return { x: p.y, y: 1 - p.x }
  }
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

/** Quarter turns the viewer applies between the frame and the picture it shows. */
export type Turn = 0 | 90 | 180 | 270

/**
 * The whole turn from the frame to the picture: the stream's own correction plus the user's.
 *
 * **They add, and a device can need both at once.** One turns the video because the capture is
 * not the orientation Android is drawing; the other turns it again because the tester asked for
 * landscape and the app refused. Measured on a folded foldable at the lock screen: Android keeps
 * `rotation 0`, so the stream still needs its 270, and the rotate button wants a further 90 on
 * top. Two earlier versions each applied one and dropped the other, which is a half turn either
 * way — and in that same case the two cancel to 0, which is the cell that had no owner when the
 * layout was decided by one of them and the transform by the other.
 */
export function composeTurn(streamRotation: Turn, needsCSSRotation: boolean): Turn {
  return (((streamRotation + (needsCSSRotation ? 90 : 0)) % 360) as Turn)
}

/**
 * The size of the picture a turned frame produces — the frame's axes swapped by a quarter turn.
 *
 * **The frame is not the picture.** On the emulator's gRPC backend the capture is the panel as the body is
 * held; a viewer that draws Android's screen turns it by `streamRotation`, and on the toggle path a tester
 * asking for landscape on a portrait-locked app adds another quarter. Body mode draws the frame as it comes. Anything producing a file — a
 * screenshot, a recording — has to size itself to the picture, or it saves the frame behind it.
 * An unfolded foldable is portrait on screen and landscape in the frame, and recorded sideways.
 */
export function turnedSize(frameW: number, frameH: number, turn: Turn): { width: number; height: number } {
  const quarter = turn === 90 || turn === 270
  return { width: quarter ? frameH : frameW, height: quarter ? frameW : frameH }
}

/** The longest side a recording is encoded at. The browser encodes it while it also decodes the stream, so a
 *  full-resolution iPad (2732) or Pro Max with its frame (~3000) is held to a 1080p-class size. */
export const RECORDING_MAX_SIDE = 1920

/** `size` shrunk to fit `RECORDING_MAX_SIDE`, aspect kept, and made even on both sides — what video encoders take. */
export function recordingSize(size: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(1, RECORDING_MAX_SIDE / Math.max(size.width, size.height))
  const even = (n: number) => Math.max(2, 2 * Math.round((n * k) / 2))
  return { width: even(size.width), height: even(size.height) }
}

/**
 * Where a turned frame lands inside a capture canvas: centred, scaled to fit, never stretched.
 *
 * The fit matters because `MediaRecorder` fixes the canvas size when recording starts. A device
 * folded *during* a take changes the frame's shape under it, and letterboxing is the honest
 * answer — the alternative is a picture stretched for the rest of the recording.
 */
export function placeTurnedFrame(
  canvasW: number, canvasH: number, frameW: number, frameH: number, turn: Turn,
): { picW: number; picH: number; scale: number; left: number; top: number } {
  const { width: picW, height: picH } = turnedSize(frameW, frameH, turn)
  const scale = Math.min(canvasW / picW, canvasH / picH)
  return { picW, picH, scale, left: (canvasW - picW * scale) / 2, top: (canvasH - picH * scale) / 2 }
}

/**
 * The box the video surface occupies inside the device shell, for a composed turn.
 *
 * **One expression owns the whole box, deliberately.** It used to be two: a Tailwind
 * `block w-full h-full` chosen by whether the *user's* quarter turn applied, and an inline style
 * chosen by the *total* turn. Those were interchangeable until the stream gained a correction of
 * its own, and then one cell had neither — a folded foldable at the lock screen, where the
 * stream's 270 and the user's 90 cancel to 0 while the CSS condition is still true. It happened to
 * lay out correctly, because in that cell the frame's aspect always equals the shell's, so the
 * surface's `height: 100%` resolved through the intrinsic ratio to the right number. Correct by
 * coincidence is the thing worth removing: the coincidence holds only while the frame and the
 * reported screen agree, which during a fold they briefly do not — and `getBoundingClientRect()`
 * of this element is what every tap is normalised against.
 *
 * A quarter turn takes the shell's dimensions swapped and centred, so that rotating it lands
 * exactly on the shell — which is what keeps the bezel still and the pointer maths honest.
 */
export function surfaceBox(turn: Turn, containerW: number, containerH: number):
  { width: number; height: number; left: number; top: number } {
  const quarter = turn === 90 || turn === 270
  const width = quarter ? containerH : containerW
  const height = quarter ? containerW : containerH
  return { width, height, left: (containerW - width) / 2, top: (containerH - height) / 2 }
}

/**
 * The space a recording's pointer overlay lives in, and how far to turn the canvas to reach it.
 *
 * **Not the frame, and not the picture.** `androidToNorm` undoes the user's quarter, so a stored
 * pointer is a fraction of the screen Android is drawing. Two bases have been wrong here: against
 * the frame it missed by the stream's correction, which is only nonzero on a foldable; against
 * the picture it missed by the user's quarter, on every backend including scrcpy, where it had
 * been correct for as long as the feature existed. The shown screen is the frame turned by the
 * stream's correction alone, and the remainder of the total is the turn to reach the picture.
 */
export function overlaySpace(
  frameW: number, frameH: number, totalTurn: Turn, streamRotation: Turn,
): { width: number; height: number; turn: Turn } {
  const { width, height } = turnedSize(frameW, frameH, streamRotation)
  return { width, height, turn: (((totalTurn - streamRotation + 360) % 360) as Turn) }
}

/**
 * Whether to show the picture, or hold it back while the frame and the description disagree.
 *
 * **The disagreement has two directions and only one of them resolves itself.**
 *
 * The frame changes the moment the device does; `session:chrome` arrives once the agent has read
 * the settled display. In between, a new frame is drawn into the old frame's box — stretched and
 * a quarter turn out — which is the flash this gate exists to suppress. That case ends on its own,
 * because the description is already on its way.
 *
 * The other direction does not. The agent also learns of a panel change from its own poll, so the
 * description can arrive with **no frame behind it** — and the emulator's capture is frame-driven,
 * so a screen that is static after a fold sends nothing at all. Hiding until the frame catches up
 * then hides forever: measured, a foldable left on "Changing posture…" until the tester touched
 * the device. A gate with no exit is the defect, whatever kept the frame away.
 *
 * So the aspect check only holds the picture back when the **frame** is the newer of the two. When
 * the description is newer, the last frame is shown in the new box — stale, and visibly the
 * previous screen, which is a better answer than a placeholder that never clears.
 */
export function showsPicture(opts: {
  ready: boolean
  aspectAgrees: boolean
  frameIsAhead: boolean
  rotating: boolean
}): boolean {
  if (!opts.ready || opts.rotating) return false
  return opts.aspectAgrees || !opts.frameIsAhead
}

/**
 * Does the frame, once the stream's correction is applied, describe the same screen the agent does?
 *
 * The two arrive on different paths: the stream changes shape the moment the emulator does, and
 * `session:chrome` only once the agent has read the settled display. In the window between them a
 * new frame is drawn into the old frame's box — stretched and a quarter turn out — which is the
 * flash. Compared rather than timed: the question is not "how long does a fold take" but "do
 * these two describe the same screen", and both values are already to hand.
 *
 * **The stream's correction, not the composed turn.** The user's quarter does not change the
 * frame's shape, so folding it in would invert the test.
 *
 * Aspect rather than size, because the stream may be downscaled by the server-side resize and a
 * downscale preserves the ratio. The tolerance covers the encoder's 16-pixel alignment — a
 * 2076-wide panel is encoded 2080 wide. Unknown sizes agree: before the first frame there is
 * nothing to disagree with, and the first-frame hold is a separate gate.
 */
export function framesAgree(
  video: { width: number; height: number } | null,
  shown: { width: number; height: number } | null,
  streamRotation: Turn,
): boolean {
  if (!video || !shown) return true
  const { width, height } = turnedSize(video.width, video.height, streamRotation)
  return Math.abs(width / height - shown.width / shown.height) < 0.05
}

/**
 * How long a hold with a fixed deadline has left.
 *
 * **A stop must not be movable by the thing it is stopping.** Both holds in the Android viewer
 * were written as a timer re-armed by their own effect's dependencies, so an answer arriving
 * inside the window cleared the running timer and started a fresh full one — a fast agent
 * produced a *longer* wait than a slow one. The posture hold had it worse: the agent sends a
 * report on the failure path precisely so a change that did not happen ends, and that report
 * pushed the end further out.
 *
 * Never negative, so a deadline already passed fires on the next tick rather than never.
 */
export function remaining(deadline: number, now: number): number {
  return Math.max(0, deadline - now)
}
