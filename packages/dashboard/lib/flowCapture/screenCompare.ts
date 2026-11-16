import { diffAreas, sameShape, SCREEN_DIFF_THRESHOLD, screenCells, type Pixels, type ScreenRect } from '@tapflowio/flow-runner/browser'
import type { ScreenDivergence } from './runner'

/** Over this share of the compared cells, a stop says the screen is mostly different (R5) rather than boxing each place:
 *  the screens measured that were the same screen with something on it moving differed by 30–45 %, and a list the app
 *  fills with new data by nearly all of it. */
export const MOSTLY_DIFFERENT = 0.5

/** The replay's picture beside the recording's: twice the 230 px it is shown at. */
const SHOWN_WIDTH = 460

/**
 * The step's recorded picture (1b-3b) against the frame the viewer draws now: a `ScreenDivergence` when they differ,
 * `null` when they look alike. Throws when either picture cannot be had or laid over the other: the first look takes
 * that as no reason to stop a replay, and a look again (`LOOK_AGAIN`) as no match, so it keeps looking. The frame is drawn at the recorded picture's size the way `ThumbnailRecorder` drew that one
 * (high-quality smoothing), so the two differ by what is on the screen and not by how each was scaled (`screenDiff`).
 */
export async function compareWithRecording(
  recordedUrl: string, surface: CanvasImageSource | null, masks: ScreenRect[], signal: AbortSignal,
): Promise<ScreenDivergence | null> {
  if (!surface || typeof createImageBitmap !== 'function') throw new Error('The screen cannot be read here.')
  const response = await fetch(recordedUrl, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`The recorded picture could not be had (${response.status}).`)
  const recorded = await createImageBitmap(await response.blob())
  // The frame now, held: the viewer draws the next one into the same surface.
  const now = await createImageBitmap(surface as ImageBitmapSource).catch((e: unknown) => { recorded.close(); throw e })
  try {
    if (!sameShape(recorded, now)) throw new Error('The two pictures are of different shapes.')
    const a = pixelsOf(recorded, recorded.width, recorded.height)
    const b = pixelsOf(now, recorded.width, recorded.height)
    if (!a || !b) throw new Error('The pictures could not be drawn.')
    const cells = screenCells(a, b, masks)
    if (cells === 'incomparable') throw new Error('The two pictures cannot be laid over each other.')
    if (cells.share <= SCREEN_DIFF_THRESHOLD) return null
    const nowUrl = await jpegUrl(now)
    if (!nowUrl) throw new Error('The replay\'s picture could not be kept.')
    return { diff: cells.share, nowUrl, masks, areas: diffAreas(cells), mostly: cells.share > MOSTLY_DIFFERENT, cells }
  } finally {
    recorded.close()
    now.close()
  }
}

/**
 * Whether two recorded pictures (1b-3b) show the same screen, outside `masks` (the status bar's clock): for a tap made
 * again on the same element (P2c), the screen unchanged between them says the first did nothing. `false` whenever it
 * cannot tell — a picture missing, unreadable or of another shape — since what it decides is leaving a step out.
 */
export async function recordedAlike(a: string, b: string, masks: ScreenRect[], signal?: AbortSignal): Promise<boolean> {
  const load = async (url: string) => { const r = await fetch(url, { credentials: 'include', ...(signal ? { signal } : {}) }); return r.ok ? r.blob() : null }
  const [first, second] = await Promise.all([load(a).catch(() => null), load(b).catch(() => null)])
  if (!first || !second) return false
  const diff = await picturesDiff(first, second, masks)
  return diff !== null && unchanged(diff)
}

/**
 * Pixels of `b` that differ from `a` by more than `tolerance` in any channel, outside `masks` (fractions of the
 * picture). Not `screenDiff`'s grid: that averages a 48-wide grid and passes a cell under 24/255, so a counter's digit
 * changing read as nothing (an outside review of #1171 reproduced it). Measured on the user's recordings: two pictures
 * of one screen differ by at most 44 (JPEG noise); a changed screen by 255 in thousands of pixels.
 */
export function pixelsChanged(a: Pixels, b: Pixels, masks: readonly ScreenRect[], tolerance = PIXEL_TOLERANCE): number {
  if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY
  let changed = 0
  for (let y = 0; y < a.height; y++) {
    const fy = (y + 0.5) / a.height
    for (let x = 0; x < a.width; x++) {
      const fx = (x + 0.5) / a.width
      if (masks.some((m) => fx >= m.x && fx < m.x + m.width && fy >= m.y && fy < m.y + m.height)) continue
      const i = (y * a.width + x) * 4
      const d = Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!))
      if (d > tolerance) changed++
    }
  }
  return changed
}

/** More than JPEG noise between two pictures of one screen (44 measured), less than any drawn change. */
export const PIXEL_TOLERANCE = 64

/** Pixels changed between two pictures outside `masks` (`pixelsChanged`), or `null` when either cannot be read or laid
 *  on the other. */
export async function picturesDiff(a: Blob, b: Blob, masks: ScreenRect[]): Promise<number | null> {
  if (typeof createImageBitmap !== 'function') return null
  const [first, second] = await Promise.all([createImageBitmap(a).catch(() => null), createImageBitmap(b).catch(() => null)])
  try {
    if (!first || !second || !sameShape(first, second)) return null
    const pa = pixelsOf(first, first.width, first.height)
    const pb = pixelsOf(second, first.width, first.height)
    if (!pa || !pb) return null
    return pixelsChanged(pa, pb, masks)
  } finally {
    first?.close()
    second?.close()
  }
}

/**
 * Whether a replayed tap did nothing where the recorded one did something (P2c): the replay's screen before the tap and
 * now not a cell different, and the recording's pictures before the tap and before the next step different. `false`
 * whenever a picture is missing or cannot be read, since what it decides is pressing again.
 */
export async function tapDidNothing(
  recordedBefore: string | null, recordedNext: string | null, shotBefore: Uint8Array, shotNow: Uint8Array, masks: ScreenRect[],
  signal?: AbortSignal, diff: (a: Blob, b: Blob, masks: ScreenRect[]) => Promise<number | null> = picturesDiff,
): Promise<boolean> {
  if (!recordedBefore || !recordedNext) return false
  const jpeg = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'image/jpeg' })
  const replayed = await diff(jpeg(shotBefore), jpeg(shotNow), masks)
  if (replayed === null || !unchanged(replayed)) return false
  // With the run's signal: Stop does not wait for the pictures (CodeRabbit, #1171).
  const load = async (url: string) => { const r = await fetch(url, { credentials: 'include', ...(signal ? { signal } : {}) }); return r.ok ? r.blob() : null }
  const [a, b] = await Promise.all([load(recordedBefore).catch(() => null), load(recordedNext).catch(() => null)])
  if (!a || !b) return false
  const recorded = await diff(a, b, masks)
  return recorded !== null && !unchanged(recorded)
}

/** The verdict on `picturesDiff`: not one pixel changed. */
export const unchanged = (changed: number | 'incomparable'): boolean => changed === 0

function pixelsOf(image: ImageBitmap, width: number, height: number): Pixels | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  return { width, height, data: ctx.getImageData(0, 0, width, height).data }
}

async function jpegUrl(image: ImageBitmap): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = SHOWN_WIDTH
  canvas.height = Math.max(1, Math.round(SHOWN_WIDTH * image.height / image.width))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  return blob ? URL.createObjectURL(blob) : null
}
