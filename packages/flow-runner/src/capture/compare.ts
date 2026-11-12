import type { KeyboardState } from '@tapflowio/protocol'
import { toFramePoint, type InterfaceTurn } from '@tapflowio/protocol/screen'

/**
 * Whether the screen a replayed step is about to act on looks like the one the person recorded it on (1b-3b): Match
 * stops there and shows both, rather than replaying on into a screen the flow was not made for. Pure — the dashboard
 * draws the two pictures and passes their pixels in.
 *
 * Measured on both platforms through the real Match path, with the frame drawn as the recording was (`screenDiff`):
 * the same screen read 0 at every step (iOS 10 of 10, an Android step with the keyboard up), a small text change on one
 * screen (a status label) at most 0.004, and the nearest two different screens 0.017 (iOS, a nearly blank page against
 * a form; Android's were 0.04 and up). Between the two, nearer the text change than the blank page, which the replay
 * must not go past. A difference in the app's own state (a button showing − where it showed +) stops it too: stopping
 * costs a press of Continue anyway, going on past a different screen costs a flow made for another one.
 */
export const SCREEN_DIFF_THRESHOLD = 0.01

/** The grid compared: 48 cells across, gray, a cell differing by more than 24 of 255. Of the metrics measured (a lower
 *  cut, a content-normalised share, 8×16 cells, a 16-bit dHash) this one kept same and different screens furthest
 *  apart, 36× against 1.7–4.7×. */
const GRID_WIDTH = 48
const CELL_DIFF = 24

/** A part of the picture, as fractions of it: the keyboard's own rect is one. */
export type Rect = NonNullable<KeyboardState['frameRect']>

/** RGBA, row by row, as `ImageData` holds it. */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

/** The status bar's height as a share of the screen, measured on the sample apps: its clock and icons change between any
 *  two pictures. Nothing on the wire says it (no chrome carries an inset), so it is a constant per platform. */
const STATUS_BAR: Record<string, number> = { android: 0.035, ios: 0.055 }

/**
 * The status bar in the picture's space. It sits along the top of the screen the app draws, and the picture is the
 * device's frame: on a device held sideways that band is down one side of it. `turn` is how far the screen is turned
 * from the frame — iOS's `interfaceTurn`, Android's chrome `streamRotation`; both carry a point the same way.
 */
export function statusBarRect(platform: string, turn: InterfaceTurn | undefined): Rect | undefined {
  const height = STATUS_BAR[platform]
  return height === undefined ? undefined : turnRect({ x: 0, y: 0, width: 1, height }, turn)
}

/** A rect in the screen the app draws, carried into the frame by `turn` (`toFramePoint`'s rule, applied to two corners). */
export function turnRect(r: Rect, turn: InterfaceTurn | undefined): Rect {
  const [ax, ay] = toFramePoint(turn, [r.x, r.y])
  const [bx, by] = toFramePoint(turn, [r.x + r.width, r.y + r.height])
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(ax - bx), height: Math.abs(ay - by) }
}

/** Whether two pictures are of a screen the same shape. A fold's other panel, or a capture not held to one shape, is a
 *  picture that cannot be laid over the other: not compared, rather than called different. */
export function sameShape(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  const ra = a.width / a.height
  const rb = b.width / b.height
  return Math.abs(ra - rb) / ra <= 0.01
}

/**
 * The share of the compared cells that differ, or `'incomparable'` when the pictures are not the same size or the masks
 * leave nothing to compare. `masks` are left out of both: the status bar, and the on-screen keyboard as the recording
 * read it (its suggestions change between any two runs).
 *
 * The two must be the same size, and made the same way: the device's frame drawn at the recorded picture's size as the
 * recorded one was drawn. Measured on an emulator, one screen against itself read 0.031 with both scaled to a third
 * size and 0 with the frame first drawn like the recording; and two pictures each cut by its own height had picked
 * different rows, which read 0.06–0.10.
 */
export function screenDiff(recorded: Pixels, now: Pixels, masks: readonly Rect[]): number | 'incomparable' {
  if (recorded.width !== now.width || recorded.height !== now.height) return 'incomparable'
  const gridHeight = Math.max(1, Math.round(GRID_WIDTH * recorded.height / recorded.width))
  const a = shrink(gray(recorded), recorded.width, recorded.height, GRID_WIDTH, gridHeight)
  const b = shrink(gray(now), now.width, now.height, GRID_WIDTH, gridHeight)
  let compared = 0
  let differing = 0
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const cell = { x: x / GRID_WIDTH, y: y / gridHeight, width: 1 / GRID_WIDTH, height: 1 / gridHeight }
      if (masks.some((m) => overlaps(cell, m))) continue
      compared++
      const i = y * GRID_WIDTH + x
      if (Math.abs(a[i]! - b[i]!) > CELL_DIFF) differing++
    }
  }
  return compared === 0 ? 'incomparable' : differing / compared
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Luma by ITU-R 601, as the measurement's image library made its gray. */
function gray({ width, height, data }: Pixels): Float64Array {
  const out = new Float64Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000
  return out
}

/** Each target cell the average of the source area under it, partial pixels weighted by how much of them it covers. */
function shrink(src: Float64Array, w: number, h: number, tw: number, th: number): Float64Array {
  const rows = new Float64Array(tw * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < tw; x++) rows[y * tw + x] = span(w / tw, x, (i) => src[y * w + i]!)
  }
  const out = new Float64Array(tw * th)
  for (let x = 0; x < tw; x++) {
    for (let y = 0; y < th; y++) out[y * tw + x] = span(h / th, y, (i) => rows[i * tw + x]!)
  }
  return out
}

/** The average of `at` over source positions [n·scale, (n+1)·scale). */
function span(scale: number, n: number, at: (i: number) => number): number {
  const from = n * scale
  const to = from + scale
  let sum = 0
  for (let i = Math.floor(from); i < Math.ceil(to); i++) {
    const weight = Math.min(to, i + 1) - Math.max(from, i)
    if (weight > 0) sum += at(i) * weight
  }
  return sum / scale
}
