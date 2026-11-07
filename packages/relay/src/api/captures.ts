import http from 'http'
import { requireAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import type { CaptureStore } from '../capture/CaptureStore.js'
import type { FlowCapturePreference } from '../capture/preference.js'

// Flow Capture's REST surface (#1125). Every route takes the **browser cookie only** (`requireAuth`), never a PAT: a
// capture holds what the person typed, and a `view` PAT is what their own MCP server and CI hold — accepting one would
// let those read typed passwords into a model's context. A capture is answered only to the person it belongs to; for
// anyone else it does not exist (404), so these routes do not say whose sessions are being captured.

type Params = Record<string, string>

/** `POST /api/v1/sessions/:sessionId/capture/snapshot` — freeze the steps recorded so far for the Capture flow
 *  dialog, which reads only this. Taking another replaces it. */
export function handleTakeSnapshot(req: http.IncomingMessage, res: http.ServerResponse, params: Params, store: CaptureStore): void {
  const auth = requireAuth(req, res)
  if (!auth) return
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
