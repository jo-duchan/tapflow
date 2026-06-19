/**
 * True when the relay URL is a wss connection to localhost. In the all-in-one `tapflow start` setup
 * the relay terminates TLS with a domain cert, but the co-located agent reaches it over wss://localhost
 * — a cert that won't match localhost. localhost never leaves the machine, so MITM is impossible; the
 * agent accepts the cert (rejectUnauthorized:false) only in this case. External relays keep full
 * verification.
 */
export function isLocalhostWss(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets ([::1] → ::1)
    return u.protocol === 'wss:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')
  } catch {
    return false
  }
}
