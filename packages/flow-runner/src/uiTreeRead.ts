import type { UIElement } from '@tapflowio/agent-core'
import type { ReachResult, ReachTarget } from '@tapflowio/protocol'
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

/**
 * The relay's `POST /api/v1/sessions/:id/reach` body (#1125), one result per target in order. A result this client
 * cannot read, or an answer for another number of targets, is `unknown`: the engine then taps the frame's centre and
 * says the tap was not checked, never treats it as reached.
 */
/**
 * The request for `POST /sessions/:id/reach`, built here for all three clients (`RelayClient`, mcp-server's and the
 * dashboard's channel): each holds one serialization, its socket send, and `clientOutboundTyped` keeps it so.
 */
export function reachRequest(targets: ReachTarget[], signal?: AbortSignal): { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal } {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets }), ...(signal ? { signal } : {}) }
}

export function readReachResults(body: unknown, count: number): ReachResult[] {
  const results = (body as { results?: unknown } | null)?.results
  const unknown = (reason: string): ReachResult => ({ state: 'unknown', reason })
  if (!Array.isArray(results) || results.length !== count) return Array.from({ length: count }, () => unknown('unreadable reach answer'))
  return results.map((r): ReachResult => {
    const o = (r ?? {}) as Record<string, unknown>
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    const f = (o['frame'] ?? {}) as Record<string, unknown>
    switch (o['state']) {
      case 'reachable': {
        const p = o['point']
        if (!Array.isArray(p) || p.length !== 2 || !p.every(num) || typeof o['atCentre'] !== 'boolean' || ![f['x'], f['y'], f['width'], f['height']].every(num)) return unknown('unreadable reach answer')
        return { state: 'reachable', point: [p[0] as number, p[1] as number], atCentre: o['atCentre'] as boolean, frame: { x: f['x'] as number, y: f['y'] as number, width: f['width'] as number, height: f['height'] as number } }
      }
      case 'occluded': return typeof o['by'] === 'string' ? { state: 'occluded', by: o['by'] } : { state: 'occluded' }
      case 'offscreen': return { state: 'offscreen' }
      case 'missing': return { state: 'missing', candidates: num(o['candidates']) ? o['candidates'] as number : 0 }
      case 'unknown': return unknown(typeof o['reason'] === 'string' ? o['reason'] : 'unknown')
      default: return unknown('unreadable reach answer')
    }
  })
}
