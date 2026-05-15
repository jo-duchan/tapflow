import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')

import { execSync } from 'node:child_process'
import { cmdDevices } from '../../commands/devices.js'

const mockExecSync = vi.mocked(execSync)

const simctlJson = JSON.stringify({
  devices: {
    'iOS-17': [
      { udid: 'AAA', name: 'iPhone 16 Pro', state: 'Booted' },
      { udid: 'BBB', name: 'iPhone 15', state: 'Shutdown' },
    ],
  },
})

describe('cmdDevices', () => {
  let output: string[]

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
  })

  afterEach(() => vi.restoreAllMocks())

  it('iOS 시뮬레이터 섹션 출력', () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlJson
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    cmdDevices()
    const joined = output.join('\n')
    expect(joined).toContain('iOS Simulators')
    expect(joined).toContain('iPhone 16 Pro')
    expect(joined).toContain('iPhone 15')
  })

  it('booted 시뮬레이터는 ● 마커로 표시', () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlJson
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    cmdDevices()
    expect(output.join('\n')).toContain('● iPhone 16 Pro')
  })

  it('Android AVD 섹션 출력', () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl')) throw new Error('not available')
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n'
      if (c.startsWith('adb -s emulator-5554')) return 'Pixel_8\nOK\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\nPixel_6\n'
      return ''
    })

    cmdDevices()
    const joined = output.join('\n')
    expect(joined).toContain('Android AVDs')
    expect(joined).toContain('Pixel_8')
  })

  it('실행 중인 AVD는 ● 마커, 나머지는 ○ 마커', () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl')) throw new Error('not available')
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n'
      if (c.startsWith('adb -s emulator-5554')) return 'Pixel_8\nOK\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\nPixel_6\n'
      return ''
    })

    cmdDevices()
    const joined = output.join('\n')
    expect(joined).toContain('● Pixel_8')
    expect(joined).toContain('○ Pixel_6')
  })

  it('iOS도 Android도 없으면 "No devices found" 출력', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    cmdDevices()
    expect(output.join('\n')).toContain('No devices found')
  })

  it('iOS와 Android 모두 있으면 두 섹션 모두 출력', () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlJson
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n'
      if (c.startsWith('adb -s emulator-5554')) return 'Pixel_8\nOK\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    cmdDevices()
    const joined = output.join('\n')
    expect(joined).toContain('iOS Simulators')
    expect(joined).toContain('Android AVDs')
  })
})
