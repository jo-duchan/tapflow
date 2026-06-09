import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../../lib/doctor.js', () => ({
  runDoctorChecks: vi.fn(),
}))

import { runDoctorChecks } from '../../lib/doctor.js'
import { cmdDoctor } from '../../commands/doctor.js'

const mockRunDoctorChecks = vi.mocked(runDoctorChecks)

describe('cmdDoctor', () => {
  let logLines: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    logLines = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
  })

  afterEach(() => vi.restoreAllMocks())

  it('모든 체크 통과 시 "All checks passed" 출력', async () => {
    mockRunDoctorChecks.mockResolvedValue({
      common: [{ label: 'Node v20.0.0', ok: true }],
      ios: [{ label: 'Xcode 15.0', ok: true }],
      android: null,
    })

    await cmdDoctor()
    expect(logLines.join('\n')).toContain('All checks passed')
  })

  it('실패 체크 있으면 "Some checks failed" 출력 후 exit(1)', async () => {
    mockRunDoctorChecks.mockResolvedValue({
      common: [{ label: 'Node v18.0.0', ok: false, detail: 'Node ≥ 20 required.' }],
      ios: null,
      android: null,
    })

    await expect(cmdDoctor()).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(logLines.join('\n')).toContain('SOME CHECKS FAILED')
  })

  it('iOS 섹션 있으면 iOS 헤더 출력', async () => {
    mockRunDoctorChecks.mockResolvedValue({
      common: [{ label: 'Node v20.0.0', ok: true }],
      ios: [
        { label: 'Xcode 15.0', ok: true },
        { label: 'xcrun simctl', ok: true },
        { label: 'Simulator booted: iPhone 16 Pro', ok: true },
      ],
      android: null,
    })

    await cmdDoctor()
    expect(logLines.join('\n')).toContain('iOS')
  })

  it('Android 섹션 있으면 Android 헤더 출력', async () => {
    mockRunDoctorChecks.mockResolvedValue({
      common: [{ label: 'Node v20.0.0', ok: true }],
      ios: null,
      android: [
        { label: 'adb found: /usr/local/bin/adb', ok: true },
        { label: 'AVD: Pixel_8', ok: true },
      ],
    })

    await cmdDoctor()
    expect(logLines.join('\n')).toContain('Android')
  })

  it('실패 체크의 detail 메시지 출력', async () => {
    mockRunDoctorChecks.mockResolvedValue({
      common: [{ label: 'Node v18.0.0', ok: false, detail: 'Node ≥ 20 required.' }],
      ios: null,
      android: null,
    })

    await expect(cmdDoctor()).rejects.toThrow('process.exit')
    expect(logLines.join('\n')).toContain('Node ≥ 20 required.')
  })

  describe('--json', () => {
    it('유효한 JSON + ok=true + {ok, common, ios, android} 형태', async () => {
      mockRunDoctorChecks.mockResolvedValue({
        common: [{ label: 'Node v20.0.0', ok: true }],
        ios: [{ label: 'Xcode 15.0', ok: true }],
        android: null,
      })

      await cmdDoctor({ json: true })
      const parsed = JSON.parse(logLines.join('\n'))
      expect(parsed).toMatchObject({ ok: true })
      expect(parsed).toHaveProperty('common')
      expect(parsed).toHaveProperty('ios')
      expect(parsed).toHaveProperty('android')
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('실패 체크 있으면 ok=false + exit(1)', async () => {
      mockRunDoctorChecks.mockResolvedValue({
        common: [{ label: 'Node v18.0.0', ok: false, detail: 'Node ≥ 20 required.' }],
        ios: null,
        android: null,
      })

      await expect(cmdDoctor({ json: true })).rejects.toThrow('process.exit')
      const parsed = JSON.parse(logLines.join('\n'))
      expect(parsed.ok).toBe(false)
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('warn만 있으면 ok=true (warn은 실패 아님)', async () => {
      mockRunDoctorChecks.mockResolvedValue({
        common: [{ label: 'Node v20.0.0', ok: true }],
        ios: [{ label: 'Simulator', ok: false, warn: true, detail: 'No simulator is running.' }],
        android: null,
      })

      await cmdDoctor({ json: true })
      const parsed = JSON.parse(logLines.join('\n'))
      expect(parsed.ok).toBe(true)
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('ANSI 색 코드 미포함', async () => {
      mockRunDoctorChecks.mockResolvedValue({
        common: [{ label: 'Node v20.0.0', ok: true }],
        ios: null,
        android: null,
      })

      await cmdDoctor({ json: true })
      expect(logLines.join('\n')).not.toContain('[')
    })

    it('detail/warn 필드를 그대로 직렬화', async () => {
      mockRunDoctorChecks.mockResolvedValue({
        common: [{ label: 'Node v20.0.0', ok: true }],
        ios: null,
        android: [
          {
            label: 'adb (not in PATH)',
            ok: false,
            warn: true,
            detail: 'adb found at /x/adb but not in PATH. Run: tapflow setup android',
          },
        ],
      })

      await cmdDoctor({ json: true })
      const parsed = JSON.parse(logLines.join('\n'))
      expect(parsed.android[0]).toMatchObject({
        warn: true,
        detail: expect.stringContaining('setup android'),
      })
    })
  })
})
