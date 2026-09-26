export const AGENT_SCOPE = 'agent'
export const VIEW_SCOPE = 'view'
const ADMIN_ROLE = 'Admin'

// ws close reason은 123바이트 한도 (RFC 6455 §5.5.1).
export const WS_REJECT_REASON =
  "Unauthorized: agents need a PAT with 'agent' scope (--token / TAPFLOW_AGENT_TOKEN); browsers must sign in"
/** A PAT with neither `view` nor `agent`: it may upload builds, not open device sessions. */
export const WS_SCOPE_REASON =
  "Forbidden: this token lacks the 'view' scope needed for device sessions; create an API-type token"
/** An `agent` token is issued by an Admin and is only as good as that Admin role, checked at every use. */
export const WS_AGENT_OWNER_REASON =
  "Unauthorized: this agent token's owner is no longer an Admin; an Admin must issue a new agent token"
/** An open socket whose token was revoked, expired, or went with its owner. */
export const WS_TOKEN_GONE_REASON =
  'Unauthorized: this token was revoked or has expired, or its owner was removed'

export interface ConnectionAuthInput {
  isLocal: boolean
  hasCookieAuth: boolean
  /** Scopes of a valid PAT on the upgrade request, or null when none was presented. */
  patScopes: string[] | null
  /** The PAT owner's current role (from the users table), or null when no PAT was presented. */
  patOwnerRole: string | null
}

export type ConnectionDecision =
  | { action: 'reject'; reason: string }
  | { action: 'accept'; role: 'browser' }
  /**
   * 첫 메시지(agent:register / stream:register)가 역할을 결정한다. What the first message may make of
   * the socket is decided here, with the credentials: `mayBrowse` gates the fallback to `browser`, and
   * `mayRegisterAgent` gates the two handshakes. A local socket may do both.
   */
  | { action: 'accept'; role: 'first-message'; mayBrowse: boolean; mayRegisterAgent: boolean }

// 새 WebSocket 연결을 첫 메시지 도착 전에 분류한다. (주소 × 자격) 매트릭스를
// 단위 테스트할 수 있도록 순수 함수로 분리 (#271).
//
// **A PAT confers the browser role only with `view`.** Any valid PAT used to, so a `builds:write`
// token meant for CI uploads could drive devices, and an agent-only token whose first frame was not a
// handshake fell through to `browser` as well. The HTTP side already asked for `view` (screenshots,
// UI trees); the socket now asks the same question.
export function classifyConnection(
  { isLocal, hasCookieAuth, patScopes, patOwnerRole }: ConnectionAuthInput,
): ConnectionDecision {
  if (isLocal) {
    return hasCookieAuth
      ? { action: 'accept', role: 'browser' }
      : { action: 'accept', role: 'first-message', mayBrowse: true, mayRegisterAgent: true }
  }
  const canView = patScopes?.includes(VIEW_SCOPE) ?? false
  // 명시적 에이전트 자격은 떠돌이 쿠키보다 우선한다 — 원격 에이전트의 인증 경로.
  if (patScopes?.includes(AGENT_SCOPE)) {
    if (patOwnerRole === ADMIN_ROLE) {
      return { action: 'accept', role: 'first-message', mayBrowse: canView, mayRegisterAgent: true }
    }
    // A demoted owner's `view,agent` token keeps what `view` alone would give: a Viewer's `view` token
    // may run QA sessions, so taking browsing away here would be stricter than the role model.
    if (canView) return { action: 'accept', role: 'browser' }
    return { action: 'reject', reason: WS_AGENT_OWNER_REASON }
  }
  if (hasCookieAuth) return { action: 'accept', role: 'browser' }
  if (canView) return { action: 'accept', role: 'browser' }
  if (patScopes) return { action: 'reject', reason: WS_SCOPE_REASON }
  return { action: 'reject', reason: WS_REJECT_REASON }
}

/**
 * The credential a remote socket was accepted with. Recorded once at the handshake and re-checked
 * against the database for as long as the socket is open. Local sockets have none: they needed no
 * credential, so there is nothing to revoke.
 */
export type SocketPrincipal =
  | { via: 'cookie'; userId: number; /** JWT `exp`, seconds */ jwtExp?: number }
  /** The PAT's id, never its hash: the hash is a bearer secret, the id is only a row. */
  | { via: 'pat'; userId: number; patId: number }

/** What the database says now about a principal's credential. */
export interface CurrentCredential {
  /** Cookie principals: the user row still exists. */
  userExists: boolean
  /** PAT principals: the token row, unexpired, with its owner — or null when revoked, expired or cascaded. */
  pat: { scopes: string[]; ownerRole: string } | null
}

/**
 * Would this socket still be accepted, given what the database says now? Returns the close reason, or
 * null when it would.
 *
 * **One predicate instead of one rule per event.** Removal, demotion, revocation, expiry and an
 * invitation accept that changes a role all reach an open socket through the same question, asked on
 * the heartbeat and again right after any of those writes. A list of "which sockets does this event
 * affect" is the design this replaced, and it had already missed expiry and the invitation path.
 *
 * `role` is what the socket has become: `agent` and `stream` rest on the `agent` scope and its owner's
 * Admin role; `browser` rests on `view`. A socket that has not sent its first frame yet (`undefined`)
 * is re-classified as a fresh handshake would be.
 */
export function revalidatePrincipal(
  principal: SocketPrincipal,
  role: 'agent' | 'browser' | 'stream' | undefined,
  current: CurrentCredential,
  nowSeconds: number,
): string | null {
  if (principal.via === 'cookie') {
    if (!current.userExists) return WS_REJECT_REASON
    if (principal.jwtExp !== undefined && principal.jwtExp <= nowSeconds) return WS_REJECT_REASON
    return null
  }
  const pat = current.pat
  if (!pat) return WS_TOKEN_GONE_REASON
  if (role === 'agent' || role === 'stream') {
    return pat.scopes.includes(AGENT_SCOPE) && pat.ownerRole === ADMIN_ROLE ? null : WS_AGENT_OWNER_REASON
  }
  if (role === 'browser') return pat.scopes.includes(VIEW_SCOPE) ? null : WS_SCOPE_REASON
  const again = classifyConnection({ isLocal: false, hasCookieAuth: false, patScopes: pat.scopes, patOwnerRole: pat.ownerRole })
  return again.action === 'reject' ? again.reason : null
}
