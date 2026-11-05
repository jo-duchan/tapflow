import type { Flow } from './schema.js'
import { fetchWithToken, type TokenSource } from './credentials.js'

/**
 * Whether a flow runs against this target is decided here and nowhere else, so the CLI and MCP's `run_flow` cannot
 * disagree. A flow carries no build: only a run is tied to one. A new condition (a version range, say) is another
 * field on the target and another check below, not a second place that decides.
 */
export interface EligibilityTarget {
  /** The build under test. Absent when the run names none, or its bundle id could not be learned. */
  build?: { id: number; bundleId: string | null }
  /** Run only flows carrying at least one of these. Empty or absent means every flow. */
  includeTags?: readonly string[]
  /** Skip flows carrying any of these. Wins over `includeTags`. */
  excludeTags?: readonly string[]
}

export type SkipReason = 'tag-filter' | 'app-mismatch'

export type Eligibility = { ok: true } | { ok: false; reason: SkipReason; message: string }

export function isEligible(flow: Pick<Flow, 'appId' | 'tags'>, target: EligibilityTarget): Eligibility {
  const tags = flow.tags ?? []
  const excluded = tags.find((t) => target.excludeTags?.includes(t))
  if (excluded !== undefined) return { ok: false, reason: 'tag-filter', message: `tagged ${excluded}` }
  if (target.includeTags && target.includeTags.length > 0 && !tags.some((t) => target.includeTags!.includes(t))) {
    return { ok: false, reason: 'tag-filter', message: `not tagged ${target.includeTags.join(' or ')}` }
  }
  // A build whose bundle id the relay could not read is unknown, not a mismatch: the flow runs as it did before.
  const bundleId = target.build?.bundleId
  if (flow.appId !== undefined && bundleId != null && flow.appId !== bundleId) {
    return {
      ok: false,
      reason: 'app-mismatch',
      message: `flow is for ${flow.appId}, build ${target.build!.id} is ${bundleId}`,
    }
  }
  return { ok: true }
}

/** `--include-tags a,b` → `['a', 'b']`. */
export function parseTagList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0)
}

export type BuildLookup =
  /** `platform` lets a flow that presses a button the platform lacks be refused before a device is chosen. */
  | { kind: 'found'; bundleId: string | null; platform: string | null }
  | { kind: 'not-found' }
  /** The relay could not be asked: no token, a token without the scope, a network error or a timeout. */
  | { kind: 'unknown'; reason: string }

const BUILD_LOOKUP_TIMEOUT_MS = 5_000

/**
 * The build's bundle id, for the app check. Only a 404 is an answer about the build. Everything else leaves the
 * check out rather than failing the run: `flow run` needs only a `view` token while this route wants
 * `builds:write`, and MCP reaches the device on loopback with no token at all, so treating a refusal as an error
 * would break runs that work today.
 */
export async function lookupBuild(
  httpBase: string,
  tokens: TokenSource,
  buildId: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = BUILD_LOOKUP_TIMEOUT_MS,
): Promise<BuildLookup> {
  if (!tokens.token) return { kind: 'unknown', reason: 'no token' }
  const url = new URL(`/api/v1/builds/${buildId}`, httpBase).toString()
  let res: Response
  try {
    res = await fetchWithToken(tokens, url, { signal: AbortSignal.timeout(timeoutMs) }, fetchImpl)
  } catch (e) {
    return { kind: 'unknown', reason: `could not reach the relay (${(e as Error).message})` }
  }
  if (res.status === 404) return { kind: 'not-found' }
  if (!res.ok) return { kind: 'unknown', reason: `the relay answered ${res.status}` }
  try {
    const body = (await res.json()) as { bundle_id?: unknown; platform?: unknown }
    return {
      kind: 'found',
      bundleId: typeof body.bundle_id === 'string' ? body.bundle_id : null,
      platform: typeof body.platform === 'string' ? body.platform : null,
    }
  } catch {
    // An older relay serving index.html with 200 for an unknown API path.
    return { kind: 'unknown', reason: 'the relay did not answer with a build' }
  }
}
