import type { BrowserToRelay } from '@tapflowio/protocol'

/**
 * The screen each recorded step began on (1b-3b), taken from the frame this viewer already draws and sent to the relay
 * beside the capture, so the Range strip can show it and Match can compare against it. **No flow-runner import**: the
 * viewer imports this, and it rides in every QA session's first load (`dashboardFirstLoadBudget`).
 *
 * The picture is keyed by the step's first `requestId` (flow-runner's `thumbnailKey`): a touch's or pinch's end, a
 * button's press, a typed run's first key, a command's own. It is grabbed as the input starts — the screen the person
 * acted on — and, for a gesture, held until its end names it. Nothing here waits: grabbing, scaling, encoding and the
 * upload happen after the input has gone, and a failure only leaves that step without a picture.
 */

/** 160 px wide: the Range tile is 80 px, drawn at 2×. JPEG q0.6 measured 4.6 KB a step (median), 5 KB at most. */
export const THUMBNAIL_WIDTH = 160
const QUALITY = 0.6
/** The relay answers 409 for an input it has not recorded yet: the input went on the socket, this on HTTP. */
const RETRY_AFTER_MS = 500
/** A pause this long between two character keys starts a new typed run, as flow-runner's `KEY_RUN_GAP_MS` does. */
const KEY_RUN_GAP_MS = 10_000

/** A key that types a character: only the first of a run of them starts a step (flow-runner's `keyChar`, roughly). */
const CHARACTER_KEY = /^(Key[A-Z]|Digit\d|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/
/** Ctrl, Alt and Meta: a key held with one types no character (flow-runner's `keyChar`). */
const NOT_TYPING = 0x01 | 0x04 | 0x08

/** The messages the relay records (protocol's `CapturedMessage`): only these end a typed run in flow-runner's
 *  `segment`, so only these may here — a copy or a join between two keys does not split the run there. */
function recorded(msg: BrowserToRelay): boolean {
  if (msg.type === 'clipboard:write') return msg.payload.pasteAfter === true
  if (msg.type === 'clipboard:read') return msg.payload?.press === 'cut'
  return msg.type.startsWith('input:') || msg.type.startsWith('app:') || msg.type === 'open-url' || msg.type === 'network:set'
}

export interface ThumbnailRecorderOptions {
  sessionId: string
  /** The frame the viewer draws now, or `null` before the first one. */
  surface: () => CanvasImageSource | null
  /** Whether steps are being recorded and the dialog is shut: read at each input, never captured. */
  recording: () => boolean
  now?: () => number
  upload?: (requestId: string, jpeg: Blob) => Promise<Response>
  /** Taking the picture and making the JPEG, replaceable for a test: jsdom has neither `createImageBitmap` nor JPEG. */
  grab?: (source: CanvasImageSource) => Promise<ImageBitmap | null>
  encode?: (bitmap: ImageBitmap) => Promise<Blob | null>
}

export class ThumbnailRecorder {
  private gesture: Promise<ImageBitmap | null> | null = null
  private lastCharacterKeyAt = -Infinity
  private readonly pending = new Set<Promise<void>>()
  private readonly opts: Required<Omit<ThumbnailRecorderOptions, 'now' | 'upload' | 'grab' | 'encode'>> & Pick<ThumbnailRecorderOptions, 'upload' | 'grab' | 'encode'> & { now: () => number }

  constructor(opts: ThumbnailRecorderOptions) {
    this.opts = { ...opts, now: opts.now ?? (() => Date.now()) }
  }

  /** Called with each message the viewer has just sent. */
  note(msg: BrowserToRelay): void {
    if (!this.opts.recording()) { this.drop(); return }
    // Any other recorded input ends a typed run, as flow-runner's `segment` ends it: the next character key starts a step.
    if (msg.type !== 'input:key' && recorded(msg)) this.lastCharacterKeyAt = -Infinity
    switch (msg.type) {
      case 'input:touch:start':
      case 'input:pinch:start':
        this.gesture = this.grab()
        return
      case 'input:touch:end':
      case 'input:pinch:end': {
        const held = this.gesture
        this.gesture = null
        if (held && msg.requestId) this.track(held.then((bitmap) => this.send(msg.requestId!, bitmap)))
        return
      }
      case 'input:touch:cancel':
        this.drop()
        return
      case 'input:key': {
        const { code, modifiers = 0 } = msg.payload
        // Caps Lock goes into the run too (`segment`): it switches the language and types nothing.
        const character = (CHARACTER_KEY.test(code) || code === 'CapsLock') && (modifiers & NOT_TYPING) === 0
        const now = this.opts.now()
        const continuesRun = character && now - this.lastCharacterKeyAt <= KEY_RUN_GAP_MS
        this.lastCharacterKeyAt = character ? now : -Infinity
        if (!continuesRun) this.keyed(msg.requestId)
        return
      }
      case 'input:button':
        if (msg.payload.phase !== 'up') this.keyed(msg.requestId)
        return
      case 'input:type':
      case 'app:install':
      case 'app:launch':
      case 'app:clear-state':
      case 'open-url':
      case 'network:set':
        this.keyed(msg.requestId)
        return
      case 'clipboard:write':
        if (msg.payload.pasteAfter === true) this.keyed(msg.requestId)
        return
      case 'clipboard:read':
        if (msg.payload?.press === 'cut') this.keyed(msg.requestId)
        return
      default:
        // A turn, a fold and the keyboard toggle carry no requestId to key a picture by.
    }
  }

  /** Every picture still on its way, for the dialog to wait on before it takes its snapshot. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /** A gesture's picture nobody will send: let the full-size frame go now, not at the next collection. */
  private drop(): void {
    const held = this.gesture
    this.gesture = null
    if (held) void held.then((bitmap) => bitmap?.close?.())
  }

  private keyed(requestId: string | undefined): void {
    if (requestId) this.track(this.grab().then((bitmap) => this.send(requestId, bitmap)))
  }

  private grab(): Promise<ImageBitmap | null> {
    const source = this.opts.surface()
    if (!source) return Promise.resolve(null)
    if (this.opts.grab) return this.opts.grab(source).catch(() => null)
    if (typeof createImageBitmap !== 'function') return Promise.resolve(null)
    return createImageBitmap(source as ImageBitmapSource).catch(() => null)
  }

  private track(work: Promise<void>): void {
    const settled = work.catch(() => {}).finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }

  private async send(requestId: string, bitmap: ImageBitmap | null): Promise<void> {
    if (!bitmap) return
    let jpeg: Blob | null
    try {
      jpeg = await (this.opts.encode ?? encode)(bitmap)
    } finally {
      bitmap.close?.()
    }
    if (!jpeg) return
    const upload = this.opts.upload ?? ((id, body) => fetch(`/api/v1/sessions/${this.opts.sessionId}/capture/thumbnails/${encodeURIComponent(id)}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'image/jpeg' }, body,
    }))
    const first = await upload(requestId, jpeg)
    if (first.status === 409) {
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS))
      await upload(requestId, jpeg)
    }
  }
}

/** The picture at `THUMBNAIL_WIDTH`, its aspect kept, as a JPEG. In idle time: it is never on an input's path. */
async function encode(bitmap: ImageBitmap): Promise<Blob | null> {
  await idle()
  const width = THUMBNAIL_WIDTH
  const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', QUALITY))
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 500 })
    else setTimeout(resolve, 0)
  })
}
