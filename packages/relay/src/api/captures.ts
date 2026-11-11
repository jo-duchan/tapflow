import http from 'http'
import { requireAuth } from '../middleware/auth.js'
import { json, readBodyLimited, readJson } from '../router.js'
import type { CaptureStore } from '../capture/CaptureStore.js'
import type { FlowCapturePreference } from '../capture/preference.js'

// Flow Capture's REST surface (#1125). Every route takes the **browser cookie only** (`requireAuth`), never a PAT: a
// capture holds what the person typed, and a `view` PAT is what their own MCP server and CI hold — accepting one would
// let those read typed passwords into a model's context. A capture is answered only to the person it belongs to; for
// anyone else it does not exist (404), so these routes do not say whose sessions are being captured.

type Params = Record<string, string>

/** `POST /api/v1/sessions/:sessionId/capture/snapshot` — freeze the steps recorded so far for the Capture flow
 *  dialog, which reads only this. Taking another replaces it. */
export async function handleTakeSnapshot(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return
  await store.settleReads(params['sessionId']!, String(auth.userId))
  const snapshot = store.takeSnapshot(params['sessionId']!, String(auth.userId))
  if (!snapshot) return json(res, 404, { error: 'No captured steps for this session' })
  json(res, 200, snapshot)
}

/** `GET` the same path — the snapshot the dialog took, for a reload inside it. */
export function handleGetSnapshot(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): void {
  const auth = requireAuth(req, res)
  if (!auth) return
  const snapshot = store.snapshot(params['sessionId']!, String(auth.userId))
  if (!snapshot) return json(res, 404, { error: 'No snapshot for this session' })
  json(res, 200, snapshot)
}

/** `DELETE` the same path — the dialog closed. */
export function handleDropSnapshot(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): void {
  const auth = requireAuth(req, res)
  if (!auth) return
  if (!store.dropSnapshot(params['sessionId']!, String(auth.userId))) return json(res, 404, { error: 'No snapshot for this session' })
  json(res, 200, { ok: true })
}

/** A thumbnail is a 160 px JPEG of the screen, measured at 5 KB; anything near this is not one. */
export const THUMBNAIL_MAX_BYTES = 16 * 1024
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/**
 * `PUT /api/v1/sessions/:sessionId/capture/thumbnails/:requestId` — the screen an input began on, from the person's own
 * dashboard (1b-3b), for an input this capture already holds. 409 when the input has not been recorded yet: it travels
 * on the socket and can land after this, and the dashboard asks once more. A touch on the soft keyboard is answered and
 * not kept, since its screen shows what was just typed.
 */
export async function handlePutThumbnail(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return
  const body = await readBodyLimited(req, THUMBNAIL_MAX_BYTES)
  if (!body) return json(res, 413, { error: `A thumbnail is at most ${THUMBNAIL_MAX_BYTES} bytes` })
  if (!body.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return json(res, 415, { error: 'A thumbnail is a JPEG' })
  const result = store.putThumbnail(params['sessionId']!, String(auth.userId), params['requestId']!, body)
  if (result === 'no-capture') return json(res, 404, { error: 'No captured steps for this session' })
  if (result === 'unknown-input') return json(res, 409, { error: 'No captured input has this requestId yet' })
  json(res, result === 'kept' ? 201 : 200, result === 'kept' ? { kept: true } : { kept: false, reason: result })
}

/** `GET /api/v1/sessions/:sessionId/capture/snapshot/thumbnails/:requestId` — one picture of a step in the snapshot. */
export function handleGetThumbnail(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): void {
  const auth = requireAuth(req, res)
  if (!auth) return
  const jpeg = store.thumbnail(params['sessionId']!, String(auth.userId), params['requestId']!)
  if (!jpeg) return json(res, 404, { error: 'No thumbnail for this step' })
  // Never cached: it is a picture of someone's screen, served to them alone.
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
  res.end(jpeg)
}

/**
 * `PUT /api/v1/sessions/:sessionId/capture/pause` — the dialog is about to replay on the device, so stop recording for
 * `ttlMs`; called again to extend it, and again after a reconnect before anything is sent. `DELETE` ends it. The
 * browser waits for this answer before its first replayed input, since the two travel on different channels.
 */
export function handlePause(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): void {
  const auth = requireAuth(req, res)
  if (!auth) return
  const sessionId = params['sessionId']!
  const user = String(auth.userId)
  if (req.method === 'DELETE') {
    if (!store.resume(sessionId, user)) return json(res, 404, { error: 'This session is not paused' })
    return json(res, 200, { ok: true })
  }
  if (!store.pause(sessionId, user)) return json(res, 404, { error: 'No captured steps for this session' })
  json(res, 200, { ok: true, ttlMs: store.pauseTtlMs })
}

/** `PATCH /api/v1/me/preferences` — the signed-in person's own settings. Every role, Viewer included: a Viewer tests on
 *  devices too, so their typing is captured like anyone's and they must be able to turn it off. */
export async function handleUpdatePreferences(
  req: http.IncomingMessage, res: http.ServerResponse, store: CaptureStore, preference: FlowCapturePreference,
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth) return
  let body: { flowCapture?: unknown } | null
  try { body = await readJson<{ flowCapture?: unknown } | null>(req) } catch { return json(res, 400, { error: 'Invalid JSON' }) }
  if (!body || typeof body !== 'object' || typeof body.flowCapture !== 'boolean') {
    return json(res, 400, { error: 'flowCapture must be a boolean' })
  }
  const user = String(auth.userId)
  preference.set(user, body.flowCapture)
  // Off means what is already recorded goes too, not only what comes next.
  if (!body.flowCapture) store.sealUser(user)
  json(res, 200, { flowCapture: body.flowCapture })
}
