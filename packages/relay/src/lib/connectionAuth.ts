export const AGENT_SCOPE = 'agent'

// ws close reason은 123바이트 한도 (RFC 6455 §5.5.1).
export const WS_REJECT_REASON =
  "Unauthorized: agents need a PAT with 'agent' scope (--token / TAPFLOW_AGENT_TOKEN); browsers must sign in"

export interface ConnectionAuthInput {
  isLocal: boolean
  hasCookieAuth: boolean
  /** Scopes of a valid PAT on the upgrade request, or null when none was presented. */
  patScopes: string[] | null
}

export type ConnectionDecision =
  | { action: 'reject'; reason: string }
  | { action: 'accept'; role: 'browser' }
  /** 첫 메시지(agent:register / stream:register)가 역할을 결정한다. */
  | { action: 'accept'; role: 'first-message' }

// 새 WebSocket 연결을 첫 메시지 도착 전에 분류한다. (주소 × 자격) 매트릭스를
// 단위 테스트할 수 있도록 순수 함수로 분리 (#271).
export function classifyConnection(
  { isLocal, hasCookieAuth, patScopes }: ConnectionAuthInput,
): ConnectionDecision {
  // 명시적 에이전트 자격은 떠돌이 쿠키보다 우선한다 — 원격 에이전트의 인증 경로.
  if (!isLocal && patScopes?.includes(AGENT_SCOPE)) return { action: 'accept', role: 'first-message' }
  if (hasCookieAuth) return { action: 'accept', role: 'browser' }
  if (isLocal) return { action: 'accept', role: 'first-message' }
  if (patScopes) return { action: 'accept', role: 'browser' }
  return { action: 'reject', reason: WS_REJECT_REASON }
}
