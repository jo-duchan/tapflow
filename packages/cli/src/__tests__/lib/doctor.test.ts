import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { runDoctorChecks } from '../../lib/doctor.js'

const mockExistsSync = vi.mocked(existsSync)

const mockExecSync = vi.mocked(execSync)

const simctlBooted = JSON.stringify({
  devices: {
    'iOS-17': [
      { udid: 'AAA', name: 'iPhone 16 Pro', state: 'Booted' },
      { udid: 'BBB', name: 'iPhone 15', state: 'Shutdown' },
    ],
  },
})

const simctlNoneBooted = JSON.stringify({
  devices: {
    'iOS-17': [{ udid: 'AAA', name: 'iPhone 16 Pro', state: 'Shutdown' }],
  },
})

describe('runDoctorChecks', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExistsSync.mockReturnValue(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it('iOS 섹션은 macOS에서만 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 15.0\n'
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.ios).not.toBeNull()
  })

  it('non-macOS에서 iOS 섹션 null', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    expect(result.ios).toBeNull()
  })

  it('adb 있으면 Android 섹션 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n'
      if (c.startsWith('adb -s emulator-5554')) return 'Pixel_8\nOK\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.android).not.toBeNull()
    expect(result.android?.some((c) => c.label.includes('Pixel_8'))).toBe(true)
  })

  it('adb 없으면 Android 섹션 null', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.android).toBeNull()
  })

  it('Node 버전 >= 20이면 ok', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'version', 'get').mockReturnValue('v20.0.0')
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    expect(result.common.find((c) => c.label.includes('Node'))?.ok).toBe(true)
  })

  it('Node 버전 < 20이면 실패 + detail 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'version', 'get').mockReturnValue('v18.0.0')
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    const nodeCheck = result.common.find((c) => c.label.includes('Node'))
    expect(nodeCheck?.ok).toBe(false)
    expect(nodeCheck?.detail).toContain('Node ≥ 20')
  })

  it('booted 시뮬레이터가 있으면 이름 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 15.0\n'
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.ios?.some((c) => c.label.includes('iPhone 16 Pro'))).toBe(true)
  })

  it('booted 없으면 warn + 사용 가능한 시뮬레이터 이름으로 hint 생성', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 15.0\n'
      if (c.startsWith('xcrun simctl')) return simctlNoneBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const simCheck = result.ios?.find((c) => c.label === 'Simulator')
    expect(simCheck?.ok).toBe(false)
    expect(simCheck?.warn).toBe(true)
    expect(simCheck?.detail).toContain('iPhone 16 Pro')
  })

  it('Xcode 미설치 시 실패 + 링크 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') throw new Error('not found')
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.ok).toBe(false)
    expect(xcodeCheck?.detail).toContain('developer.apple.com')
  })

  it('Xcode.app 존재하지만 xcode-select 미설정 시 경로 설정 힌트 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockReturnValue(true)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') throw new Error('not found')
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.ok).toBe(false)
    expect(xcodeCheck?.detail).toContain('xcode-select -s')
  })
})
