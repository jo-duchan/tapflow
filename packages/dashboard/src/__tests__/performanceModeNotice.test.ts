import { describe, it, expect } from 'vitest'
import { shouldAutoShowPerfNotice } from '@/components/perf/PerformanceModeNotice'

describe('shouldAutoShowPerfNotice — 자동 1회 노출 정책', () => {
  it('standard + 미해제 → true', () => {
    expect(shouldAutoShowPerfNotice('standard', false)).toBe(true)
  })

  it('standard + 이미 해제 → false (브라우저당 1회)', () => {
    expect(shouldAutoShowPerfNotice('standard', true)).toBe(false)
  })

  it('high(이미 하드웨어 디코드)는 자동 안 뜸', () => {
    expect(shouldAutoShowPerfNotice('high', false)).toBe(false)
  })

  it('unsupported(디코드 불가)는 자동 안 뜸 — 성능 안내 대상 아님', () => {
    expect(shouldAutoShowPerfNotice('unsupported', false)).toBe(false)
  })
})
