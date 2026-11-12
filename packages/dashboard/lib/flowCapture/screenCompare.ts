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
