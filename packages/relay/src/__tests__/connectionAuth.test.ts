import { describe, it, expect } from 'vitest'
import {
  classifyConnection,
  revalidatePrincipal,
  WS_REJECT_REASON,
  WS_SCOPE_REASON,
  WS_AGENT_OWNER_REASON,
  WS_TOKEN_GONE_REASON,
  AGENT_SCOPE,
  type SocketPrincipal,
} from '../lib/connectionAuth'

// #271 — (loopback/원격) × (무인증/쿠키/PAT 스코프) × PAT owner role 분류 매트릭스.
//
// Mutations run against this file, each turning it red:
// - `canView` forced to `true` → the `builds:write` row and the reason row fail.
// - the first-message decision's `mayBrowse` forced to `true` → the agent-only row fails.
// - `mayRegisterAgent` forced to `true` / the Admin check dropped → the owner-role rows and the
//   non-Admin `view,agent` row fail.
// - `revalidatePrincipal` returning null → every "closes" row in its block fails; dropping the `jwtExp`
//   check → the expired-cookie row fails.
describe('classifyConnection', () => {
  const local = { isLocal: true, hasCookieAuth: false, patScopes: null, patOwnerRole: null }
  const remote = { isLocal: false, hasCookieAuth: false, patScopes: null, patOwnerRole: null }
  const firstMessage = (mayBrowse: boolean, mayRegisterAgent: boolean) =>
    ({ action: 'accept', role: 'first-message', mayBrowse, mayRegisterAgent })

  it('local + no auth → first-message that may become anything', () => {
    expect(classifyConnection(local)).toEqual(firstMessage(true, true))
  })

  it('local + cookie → browser (같은 Mac 대시보드)', () => {
    expect(classifyConnection({ ...local, hasCookieAuth: true }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it('local + agent PAT → first-message (토큰이 있어도 로컬은 무인증과 동일)', () => {
    expect(classifyConnection({ ...local, patScopes: [AGENT_SCOPE], patOwnerRole: 'Viewer' }))
      .toEqual(firstMessage(true, true))
  })

  it('remote + no auth → reject (사유에 agent 스코프 안내 포함)', () => {
    const d = classifyConnection(remote)
    expect(d).toEqual({ action: 'reject', reason: WS_REJECT_REASON })
    expect(WS_REJECT_REASON).toContain(AGENT_SCOPE)
    expect(WS_REJECT_REASON).toContain('--token')
  })

  it('remote + cookie → browser (원격 대시보드, 17b8615 동작 유지)', () => {
    expect(classifyConnection({ ...remote, hasCookieAuth: true }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it('remote + view PAT → browser', () => {
    expect(classifyConnection({ ...remote, patScopes: ['view', 'builds:write'], patOwnerRole: 'Developer' }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it("a Viewer's view PAT → browser: the gate is the scope, not the role", () => {
    expect(classifyConnection({ ...remote, patScopes: ['view'], patOwnerRole: 'Viewer' }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  // Inverted deliberately: this row used to read "remote + agent 스코프 없는 PAT → browser", which let a
  // CI upload token drive devices.
  it('remote + PAT without view or agent (builds:write) → reject with the scope reason', () => {
    expect(classifyConnection({ ...remote, patScopes: ['builds:write'], patOwnerRole: 'Admin' }))
      .toEqual({ action: 'reject', reason: WS_SCOPE_REASON })
  })

  it('remote + agent-only PAT of an Admin → first-message that may not become a browser', () => {
    expect(classifyConnection({ ...remote, patScopes: [AGENT_SCOPE], patOwnerRole: 'Admin' }))
      .toEqual(firstMessage(false, true))
  })

  it('remote + view,agent PAT of an Admin → first-message that may do both', () => {
    expect(classifyConnection({ ...remote, patScopes: ['view', AGENT_SCOPE], patOwnerRole: 'Admin' }))
      .toEqual(firstMessage(true, true))
  })

  it.each(['Developer', 'QA', 'Viewer'])('remote + view,agent PAT of a %s → browser only', (role) => {
    expect(classifyConnection({ ...remote, patScopes: ['view', AGENT_SCOPE], patOwnerRole: role }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it.each([
    ['Admin', firstMessage(false, true)],
    ['Developer', { action: 'reject', reason: WS_AGENT_OWNER_REASON }],
    ['QA', { action: 'reject', reason: WS_AGENT_OWNER_REASON }],
    ['Viewer', { action: 'reject', reason: WS_AGENT_OWNER_REASON }],
  ])('agent PAT owned by a %s → only an Admin may register', (role, expected) => {
    expect(classifyConnection({ ...remote, patScopes: [AGENT_SCOPE], patOwnerRole: role })).toEqual(expected)
  })

  it('remote + agent PAT + cookie 동시 → 명시적 에이전트 자격이 우선 (first-message)', () => {
    expect(classifyConnection({ ...remote, hasCookieAuth: true, patScopes: [AGENT_SCOPE], patOwnerRole: 'Admin' }))
      .toEqual(firstMessage(false, true))
  })

  // The handshake does not read a PAT at all when the cookie is valid, so the pure function is asked
  // with the PAT absent; this row pins that a cookie alone is a browser whatever token rides along.
  it('remote + cookie + builds:write PAT (unread) → browser, the cookie result', () => {
    expect(classifyConnection({ ...remote, hasCookieAuth: true }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it.each([
    ['WS_REJECT_REASON', WS_REJECT_REASON],
    ['WS_SCOPE_REASON', WS_SCOPE_REASON],
    ['WS_AGENT_OWNER_REASON', WS_AGENT_OWNER_REASON],
    ['WS_TOKEN_GONE_REASON', WS_TOKEN_GONE_REASON],
  ])('%s fits a ws close reason (123 bytes, RFC 6455) and is ASCII', (_name, reason) => {
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123)
    expect(/^[\x20-\x7e]+$/.test(reason)).toBe(true)
  })
})

describe('revalidatePrincipal', () => {
  const now = 1_000_000
  const cookie: SocketPrincipal = { via: 'cookie', userId: 1, jwtExp: now + 60 }
  const pat: SocketPrincipal = { via: 'pat', userId: 1, patId: 9 }
  const live = (scopes: string[], ownerRole = 'Admin') => ({ userExists: true, pat: { scopes, ownerRole } })

  it('a live cookie stays open', () => {
    expect(revalidatePrincipal(cookie, 'browser', { userExists: true, pat: null }, now)).toBeNull()
  })

  it('a cookie whose user row is gone closes', () => {
    expect(revalidatePrincipal(cookie, 'browser', { userExists: false, pat: null }, now)).toBe(WS_REJECT_REASON)
  })

  it('a cookie whose JWT has expired closes', () => {
    expect(revalidatePrincipal({ ...cookie, jwtExp: now }, 'browser', { userExists: true, pat: null }, now))
      .toBe(WS_REJECT_REASON)
  })

  it('a PAT that is gone (revoked, expired or cascaded) closes', () => {
    expect(revalidatePrincipal(pat, 'agent', { userExists: true, pat: null }, now)).toBe(WS_TOKEN_GONE_REASON)
    expect(revalidatePrincipal(pat, 'browser', { userExists: true, pat: null }, now)).toBe(WS_TOKEN_GONE_REASON)
  })

  it.each(['agent', 'stream'] as const)('an %s socket closes when its owner is demoted', (role) => {
    expect(revalidatePrincipal(pat, role, live([AGENT_SCOPE], 'Developer'), now)).toBe(WS_AGENT_OWNER_REASON)
    expect(revalidatePrincipal(pat, role, live([AGENT_SCOPE], 'Admin'), now)).toBeNull()
  })

  // `view,agent` is the case that tells the stream branch apart: re-classified as a fresh handshake,
  // a non-Admin's `view,agent` token is an accepted browser, so a stream socket that fell through to
  // that path would stay open on a token that can no longer feed a screen.
  it.each(['agent', 'stream'] as const)('a %s-role socket on a view,agent token closes when its owner is demoted', (role) => {
    expect(revalidatePrincipal(pat, role, live(['view', AGENT_SCOPE], 'QA'), now)).toBe(WS_AGENT_OWNER_REASON)
  })

  it('a browser socket on a PAT that lacks view closes', () => {
    expect(revalidatePrincipal(pat, 'browser', live(['builds:write']), now)).toBe(WS_SCOPE_REASON)
  })

  it("a browser socket's owner changing role does not close it (Developer → QA)", () => {
    expect(revalidatePrincipal(pat, 'browser', live(['view', 'builds:write'], 'QA'), now)).toBeNull()
    expect(revalidatePrincipal(pat, 'browser', live(['view', AGENT_SCOPE], 'Viewer'), now)).toBeNull()
  })

  it('a socket that has not introduced itself is judged as a fresh handshake', () => {
    expect(revalidatePrincipal(pat, undefined, live([AGENT_SCOPE], 'QA'), now)).toBe(WS_AGENT_OWNER_REASON)
    expect(revalidatePrincipal(pat, undefined, live([AGENT_SCOPE], 'Admin'), now)).toBeNull()
  })
})
