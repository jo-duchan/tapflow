import { describe, it, expect } from 'vitest'
import { classifyConnection, WS_REJECT_REASON, AGENT_SCOPE } from '../lib/connectionAuth'

// #271 — (loopback/원격) × (무인증/쿠키/view PAT/agent PAT) 분류 매트릭스
describe('classifyConnection', () => {
  const local = { isLocal: true, hasCookieAuth: false, patScopes: null }
  const remote = { isLocal: false, hasCookieAuth: false, patScopes: null }

  it('local + no auth → first-message (agent/stream 핸드셰이크가 역할 결정)', () => {
    expect(classifyConnection(local)).toEqual({ action: 'accept', role: 'first-message' })
  })

  it('local + cookie → browser (같은 Mac 대시보드)', () => {
    expect(classifyConnection({ ...local, hasCookieAuth: true }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it('local + agent PAT → first-message (토큰이 있어도 로컬은 무인증과 동일)', () => {
    expect(classifyConnection({ ...local, patScopes: [AGENT_SCOPE] }))
      .toEqual({ action: 'accept', role: 'first-message' })
  })

  it('remote + no auth → reject (사유에 agent 스코프 안내 포함)', () => {
    const d = classifyConnection(remote)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') {
      expect(d.reason).toContain(AGENT_SCOPE)
      expect(d.reason).toContain('--token')
    }
  })

  it('remote + cookie → browser (원격 대시보드, 17b8615 동작 유지)', () => {
    expect(classifyConnection({ ...remote, hasCookieAuth: true }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it('remote + agent 스코프 없는 PAT → browser (스푸핑 가드가 agent:register를 차단)', () => {
    expect(classifyConnection({ ...remote, patScopes: ['view', 'builds:write'] }))
      .toEqual({ action: 'accept', role: 'browser' })
  })

  it('remote + agent 스코프 PAT → first-message (원격 에이전트 인증 경로)', () => {
    expect(classifyConnection({ ...remote, patScopes: [AGENT_SCOPE] }))
      .toEqual({ action: 'accept', role: 'first-message' })
  })

  it('remote + 복합 스코프 PAT(view,agent) → first-message', () => {
    expect(classifyConnection({ ...remote, patScopes: ['view', AGENT_SCOPE] }))
      .toEqual({ action: 'accept', role: 'first-message' })
  })

  it('remote + agent PAT + cookie 동시 → 명시적 에이전트 자격이 우선 (first-message)', () => {
    expect(classifyConnection({ ...remote, hasCookieAuth: true, patScopes: [AGENT_SCOPE] }))
      .toEqual({ action: 'accept', role: 'first-message' })
  })

  it('거절 사유는 ws close reason 한도(123바이트, RFC 6455) 이내', () => {
    expect(Buffer.byteLength(WS_REJECT_REASON, 'utf8')).toBeLessThanOrEqual(123)
  })
})
