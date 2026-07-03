import crypto from 'crypto'
import { createLogger } from '@tapflowio/agent-core'
import { getDb } from '../db.js'

const logger = createLogger('relay:webhooks')

// Each outbound request is bounded so a slow receiver can't tie up delivery.
export const WEBHOOK_TIMEOUT_MS = 5000

export interface WebhookPayload {
  event: string
  build: {
    id: string
    platform: string | null
    appVersion: string | null
    status: string
  }
  changedAt: string
}

// Minimal fetch shape so tests can inject a fake without pulling in DOM lib types.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number }>

/**
 * Validate a webhook destination URL. Returns an error string, or null when allowed.
 * Blocks loopback and cloud-metadata addresses; private LAN ranges (10/172.16/192.168)
 * are intentionally allowed because self-hosted CI often lives there.
 */
export function validateWebhookUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Invalid URL'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'URL must use http or https'
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.')
  ) {
    return 'URL host is not allowed (loopback or metadata address)'
  }
  return null
}

/** HMAC-SHA256 signature of the raw request body, formatted like EAS's expo-signature. */
export function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

interface EndpointRow {
  url: string
  secret: string | null
}

/**
 * Deliver a payload to every enabled webhook endpoint. Best-effort: a failed or slow
 * endpoint is logged and never throws to the caller (callers fire-and-forget so the
 * originating request is unaffected). One endpoint's failure does not stop the others.
 */
export async function deliverWebhooks(
  payload: WebhookPayload,
  opts: { fetchFn?: FetchLike } = {}
): Promise<void> {
  const rows = getDb()
    .prepare('SELECT url, secret FROM webhook_endpoints WHERE enabled = 1')
    .all() as EndpointRow[]
  if (rows.length === 0) return

  const body = JSON.stringify(payload)
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike)

  await Promise.allSettled(
    rows.map(async (ep) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (ep.secret) headers['X-Tapflow-Signature'] = signPayload(ep.secret, body)
      try {
        const res = await fetchFn(ep.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        })
        if (!res.ok) logger.warn(`webhook POST ${ep.url} returned ${res.status}`)
      } catch (err) {
        logger.warn(`webhook POST ${ep.url} failed: ${String(err)}`)
      }
    })
  )
}
