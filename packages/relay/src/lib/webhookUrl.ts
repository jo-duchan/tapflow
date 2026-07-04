/**
 * Validate a webhook destination URL. Returns an error string, or null when allowed.
 * Blocks loopback and cloud-metadata addresses; private LAN ranges (10/172.16/192.168)
 * are intentionally allowed because self-hosted CI often lives there.
 *
 * Lives in its own module so both webhooks.ts (delivery) and config.ts (config-file
 * endpoints) can validate without a circular import — webhooks.ts imports config.ts,
 * so config.ts can't import back into webhooks.ts.
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
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  // Node normalizes an IPv4-mapped IPv6 host (e.g. ::ffff:127.0.0.1) to a hex form
  // like ::ffff:7f00:1, which would slip past the IPv4 checks below yet still connect
  // to the embedded IPv4 — an SSRF bypass. Unwrap it back to dotted IPv4 first.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    host = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
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
