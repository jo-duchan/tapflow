import { z } from 'zod'

/**
 * Addresses the dashboard hands to someone else: a link a teammate opens, and the relay address an
 * agent on another Mac connects to. Built here and nowhere else (#788).
 *
 * **The relay decides what its settings mean; this file only falls back.** `/api/v1/relay/host` reports
 * `publicBaseUrl` (where a teammate's browser goes: a started tunnel, else `relay.url`) and
 * `agentRelayUrl` (`relay.url` alone). They are separate because an agent on the relay's own LAN must not
 * stream through a tunnel, so a link and the agent command can name different hosts. See
 * `packages/relay/src/lib/publicUrl.ts`.
 *
 * **When the relay offers nothing,** a viewer on localhost gets the relay's LAN address — their own
 * address is the one place a teammate cannot reach — and any other viewer keeps the address they are
 * already using, which is known to work. The relay withholds its LAN guess inside a container, where the
 * only candidate is a bridge address nobody can open.
 *
 * `useRelay` does not come here: it connects this page to its own relay, and the browser's own origin is
 * the right answer for that.
 */

const publicUrlWarningReason = 'container-without-public-url'
export type PublicUrlWarningReason = typeof publicUrlWarningReason

const relayHostInfoSchema = z.object({
  lanHost: z.string().nullable().optional().catch(undefined),
  port: z.number().optional().catch(undefined),
  publicBaseUrl: z.string().nullable().optional().catch(undefined),
  agentRelayUrl: z.string().nullable().optional().catch(undefined),
  publicUrlWarning: z.literal(publicUrlWarningReason).optional().catch(undefined),
})

export type RelayHostInfo = z.infer<typeof relayHostInfoSchema>

export interface Viewer {
  protocol: string
  hostname: string
  host: string
  origin: string
}

export interface TeammateBases {
  linkBase: string
  agentWsBase: string
  publicUrlWarning?: PublicUrlWarningReason
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']

export function resolveTeammateBases(info: RelayHostInfo | null, viewer: Viewer): TeammateBases {
  const wsScheme = viewer.protocol === 'https:' ? 'wss' : 'ws'
  const lan = info?.lanHost && info.port !== undefined && LOCAL_HOSTNAMES.includes(viewer.hostname)
    ? `${info.lanHost}:${info.port}`
    : null
  return {
    linkBase: info?.publicBaseUrl ?? (lan ? `${viewer.protocol}//${lan}` : viewer.origin),
    agentWsBase: info?.agentRelayUrl ?? (lan ? `${wsScheme}://${lan}` : `${wsScheme}://${viewer.host}`),
    ...(info?.publicUrlWarning ? { publicUrlWarning: info.publicUrlWarning } : {}),
  }
}

export function joinPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

let pending: Promise<TeammateBases> | null = null

/** How long a caller waits for the relay before building from the viewer's own address. */
export const LOOKUP_DEADLINE_MS = 3000

/**
 * Asks the relay once per page. A refused or failed lookup resolves to the viewer fallback rather than
 * throwing: every caller is about to show or copy an address, and the browser's own is better than none.
 * A failure is not cached, so a session that expired and was renewed without a reload asks again.
 *
 * A lookup that never settles is a failure too. The cached promise is shared, so without a deadline one
 * hung request would hold the invite dialog on "Creating link…" and stop every comment-link copy for the
 * rest of the page.
 */
export function loadTeammateBases(): Promise<TeammateBases> {
  if (pending) return pending
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), LOOKUP_DEADLINE_MS)
  pending = fetch('/api/v1/relay/host', { credentials: 'include', signal: controller.signal })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`relay host lookup: ${res.status}`))))
    .then((body: unknown) => relayHostInfoSchema.parse(body))
    .catch(() => {
      pending = null
      return null
    })
    .finally(() => clearTimeout(deadline))
    .then((info) => {
      const { protocol, hostname, host, origin } = window.location
      return resolveTeammateBases(info, { protocol, hostname, host, origin })
    })
  return pending
}

/** The cache lives for the page, which in a test file is every test. */
export function resetTeammateBasesForTests(): void {
  pending = null
}
