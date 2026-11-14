import { sameShape, SCREEN_DIFF_THRESHOLD, screenDiff, type Pixels, type ScreenRect } from '@tapflowio/flow-runner/browser'
import type { ScreenDivergence } from './runner'

/** The replay's picture beside the recording's: twice the 230 px it is shown at. */
const SHOWN_WIDTH = 460

/**
 * The step's recorded picture (1b-3b) against the frame the viewer draws now: a `ScreenDivergence` when they differ,
 * `null` when they look alike, or when either picture cannot be had or laid over the other — a picture missing is no
 * reason to stop a replay. The frame is drawn at the recorded picture's size the way `ThumbnailRecorder` drew that one
 * (high-quality smoothing), so the two differ by what is on the screen and not by how each was scaled (`screenDiff`).
 */
export async function compareWithRecording(
  recordedUrl: string, surface: CanvasImageSource | null, masks: ScreenRect[], signal: AbortSignal,
): Promise<ScreenDivergence | null> {
  if (!surface || typeof createImageBitmap !== 'function') return null
  const response = await fetch(recordedUrl, { credentials: 'include', signal })
  if (!response.ok) return null
  const recorded = await createImageBitmap(await response.blob())
  // The frame now, held: the viewer draws the next one into the same surface.
  const now = await createImageBitmap(surface as ImageBitmapSource).catch((e: unknown) => { recorded.close(); throw e })
  try {
    if (!sameShape(recorded, now)) return null
    const a = pixelsOf(recorded, recorded.width, recorded.height)
    const b = pixelsOf(now, recorded.width, recorded.height)
    if (!a || !b) return null
    const diff = screenDiff(a, b, masks)
    if (diff === 'incomparable' || diff <= SCREEN_DIFF_THRESHOLD) return null
    const nowUrl = await jpegUrl(now)
    return nowUrl ? { diff, nowUrl, masks } : null
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
export async function recordedAlike(a: string, b: string, masks: ScreenRect[]): Promise<boolean> {
  const load = async (url: string) => { const r = await fetch(url, { credentials: 'include' }); return r.ok ? r.blob() : null }
  const [first, second] = await Promise.all([load(a).catch(() => null), load(b).catch(() => null)])
  if (!first || !second) return false
  const diff = await picturesDiff(first, second, masks)
  return diff !== null && unchanged(diff)
}

/** How far two pictures differ outside `masks` (`screenDiff`), or `null` when either cannot be read or laid on the other. */
export async function picturesDiff(a: Blob, b: Blob, masks: ScreenRect[]): Promise<number | null> {
  if (typeof createImageBitmap !== 'function') return null
  const [first, second] = await Promise.all([createImageBitmap(a).catch(() => null), createImageBitmap(b).catch(() => null)])
  try {
    if (!first || !second || !sameShape(first, second)) return null
    const pa = pixelsOf(first, first.width, first.height)
    const pb = pixelsOf(second, first.width, first.height)
    if (!pa || !pb) return null
    const diff = screenDiff(pa, pb, masks)
    return diff === 'incomparable' ? null : diff
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
  diff: (a: Blob, b: Blob, masks: ScreenRect[]) => Promise<number | null> = picturesDiff,
): Promise<boolean> {
  if (!recordedBefore || !recordedNext) return false
  const jpeg = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'image/jpeg' })
  const replayed = await diff(jpeg(shotBefore), jpeg(shotNow), masks)
  if (replayed === null || !unchanged(replayed)) return false
  const load = async (url: string) => { const r = await fetch(url, { credentials: 'include' }); return r.ok ? r.blob() : null }
  const [a, b] = await Promise.all([load(recordedBefore).catch(() => null), load(recordedNext).catch(() => null)])
  if (!a || !b) return false
  const recorded = await diff(a, b, masks)
  return recorded !== null && !unchanged(recorded)
}

/** `recordedAlike`'s verdict on a `screenDiff`: not one cell different. */
export const unchanged = (diff: number | 'incomparable'): boolean => diff === 0

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
