import type { UIElement } from '@tapflowio/agent-core'
import { interfaceTurnOf, type InterfaceTurn } from '@tapflowio/protocol/screen'
import { RelayHttpError } from './sessionErrors.js'

// The relay's `GET /api/v1/sessions/:id/ui-tree`, read the same way by every host: `RelayClient` over Node's fetch and
// the dashboard over the browser's (Flow Capture, #1125). Here rather than in `RelayClient`, which reaches Node.

// Statuses that won't self-heal by polling: bad request, auth, missing session, device-not-booted
// (a flow always boots first, so mid-flow 409 is a dead device, not a race). Everything else
// (agent/foreground-race 502, idle-timeout 504, 5xx, network 0) is retryable.
export const PERMANENT_QUERY_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409])
const UI_ROLES = new Set(['button', 'text', 'input', 'image', 'checkbox', 'switch', 'slider', 'list', 'cell', 'tab', 'other'])

export function isUIElement(value: unknown): value is UIElement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const frame = record.frame
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return false
  const rect = frame as Record<string, unknown>
  if (typeof record.role !== 'string' || !UI_ROLES.has(record.role) || typeof record.label !== 'string' || typeof record.enabled !== 'boolean') return false
  if (record.identifier !== undefined && typeof record.identifier !== 'string') return false
  if (record.rawRole !== undefined && typeof record.rawRole !== 'string') return false
  if (record.placeholder !== undefined && typeof record.placeholder !== 'string') return false
  if (record.secure !== undefined && typeof record.secure !== 'boolean') return false
  if (record.focused !== undefined && typeof record.focused !== 'boolean') return false
  const x = rect.x
  const y = rect.y
  const width = rect.width
  const height = rect.height
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return (x as number) >= 0 && (y as number) >= 0 && (width as number) >= 0 && (height as number) >= 0
    && (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1
}

/** A ui-tree body as the elements and the app's interface turn, or a permanent failure naming a body nothing can use. */
export function parseUITreeResponse(body: unknown): { elements: UIElement[]; interfaceTurn?: InterfaceTurn } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('elements' in body) || !Array.isArray(body.elements) || !body.elements.every(isUIElement)) {
    throw new RelayHttpError('ui-tree query returned an invalid response shape', 200, undefined, true)
  }
  const interfaceTurn = interfaceTurnOf((body as { interfaceTurn?: unknown }).interfaceTurn)
  return interfaceTurn === undefined ? { elements: body.elements as UIElement[] } : { elements: body.elements as UIElement[], interfaceTurn }
}
