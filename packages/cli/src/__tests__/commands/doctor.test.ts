import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/doctor.js', () => ({
  runDoctorChecks: vi.fn(),
}))

import { runDoctorChecks } from '../../lib/doctor.js'
import { cmdDoctor } from '../../commands/doctor.js'

const mockRunDoctorChecks = vi.mocked(runDoctorChecks)

describe('cmdDoctor', () => {
  let logLines: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

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
    expect(logLines.join('\n')).toContain('Some checks failed')
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
})
