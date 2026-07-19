import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('node:net')

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runDoctorChecks } from '../../lib/doctor.js'

const mockExistsSync = vi.mocked(existsSync)
const mockReaddirSync = vi.mocked(readdirSync)

const mockExecSync = vi.mocked(execSync)
const mockSpawnSync = vi.mocked(spawnSync)
const mockCreateServer = vi.mocked(createServer)
const sdkmanagerLinux = join(homedir(), 'Android', 'Sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
const emulatorLinux = join(homedir(), 'Android', 'Sdk', 'emulator', 'emulator')

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

function mockPortAvailable(available: boolean): void {
  mockCreateServer.mockImplementation(() => {
    const handlers = new Map<string, () => void>()
    const server = {
      once: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler)
        return server
      }),
      listen: vi.fn(() => {
        handlers.get(available ? 'listening' : 'error')?.()
        return server
      }),
      close: vi.fn((handler?: () => void) => {
        handler?.()
        return server
      }),
    }
    return server as never
  })
}

describe('runDoctorChecks', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockPortAvailable(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

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

  it('adb 있으면 Android 섹션 포함 (SDK·AVD 존재)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    mockExistsSync.mockImplementation((p) => p === sdkmanagerLinux || p === emulatorLinux)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })
    mockSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === emulatorLinux && Array.isArray(args) && args.includes('-list-avds')) {
        return { stdout: 'Pixel_8\n' } as never
      }
      return { stdout: '' } as never
    })

    const result = await runDoctorChecks()
    expect(result.android).not.toBeNull()
    expect(result.android?.some((c) => c.label.includes('Pixel_8'))).toBe(true)
  })

  it('adb 없으면 Android 섹션은 숨기지 않고 미설치를 fail로 표시', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.android).not.toBeNull()
    const adbCheck = result.android?.find((c) => c.label === 'adb')
    expect(adbCheck?.ok).toBe(false)
    expect(adbCheck?.warn).toBeFalsy()
    expect(adbCheck?.detail).toContain('setup android')
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
    mockPortAvailable(true)
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    const nodeCheck = result.common.find((c) => c.label.includes('Node'))
    expect(nodeCheck?.ok).toBe(false)
    expect(nodeCheck?.detail).toContain('Node ≥ 20')
  })

  it('Port 4000이 사용 가능하면 common 진단에서 ok로 표시', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockPortAvailable(true)
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    const portCheck = result.common.find((c) => c.label === 'Port 4000')
    expect(portCheck).toStrictEqual({ label: 'Port 4000', ok: true, detail: undefined })
    expect(mockCreateServer.mock.results[0]?.value.listen).toHaveBeenCalledWith({ port: 4000, host: '::', ipv6Only: false })
  })

  it('Port 4000이 점유되어 있으면 해결 명령을 포함해 실패로 표시', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockPortAvailable(false)
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    const portCheck = result.common.find((c) => c.label === 'Port 4000')
    expect(portCheck?.ok).toBe(false)
    expect(portCheck?.detail).toBe('Port 4000 is already in use. Run: lsof -ti:4000 | xargs kill')
  })

  it('booted 시뮬레이터가 있으면 이름 포함', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app')
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

  it('booted 안 됐어도 디바이스가 있으면 ok (부팅은 on-demand)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 15.0\n'
      if (c.startsWith('xcrun simctl')) return simctlNoneBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const simCheck = result.ios?.find((c) => c.label.includes('Simulator'))
    expect(simCheck?.ok).toBe(true)
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

  it('adb가 PATH엔 없지만 표준 SDK 위치에 있으면 not-in-PATH 진단', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    const sdkAdb = join(homedir(), 'Library/Android/sdk/platform-tools/adb')
    mockExistsSync.mockImplementation((p) => p === sdkAdb)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') throw new Error('not found')
      if (c.startsWith(sdkAdb) && c.includes('devices')) return 'List of devices attached\n'
      if (c === 'emulator -list-avds') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.android).not.toBeNull()
    const adbCheck = result.android?.find((c) => c.label.includes('not in PATH'))
    expect(adbCheck?.warn).toBe(true)
    expect(adbCheck?.detail).toContain('new terminal')
    expect(adbCheck?.detail).toContain('tapflow doctor')
    expect(adbCheck?.detail).toContain(sdkAdb)
  })

  it("platform 'android' 지정 시 Android만 진단 (iOS null)", async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    const result = await runDoctorChecks('android')
    expect(result.ios).toBeNull()
    expect(result.android).not.toBeNull()
  })

  it("platform 'ios' 지정 시 iOS만 진단 (Android null)", async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.startsWith('xcrun simctl')) return simctlBooted
      return ''
    })

    const result = await runDoctorChecks('ios')
    expect(result.android).toBeNull()
    expect(result.ios).not.toBeNull()
  })

  it("platform 'ios'를 non-macOS에서 지정하면 macOS 필요 warn", async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks('ios')
    const iosCheck = result.ios?.[0]
    expect(iosCheck?.warn).toBe(true)
    expect(iosCheck?.detail).toContain('macOS')
  })

  it('ANDROID_HOME 지정 시 해당 경로의 adb로 진단', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const customSdk = '/opt/android-sdk'
    const customAdb = join(customSdk, 'platform-tools', 'adb')
    vi.stubEnv('ANDROID_HOME', customSdk)
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    mockExistsSync.mockImplementation((p) => p === customAdb)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') throw new Error('not found')
      if (c.startsWith(customAdb)) return 'List of devices attached\n'
      if (c === 'emulator -list-avds') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const adbCheck = result.android?.find((c) => c.label.includes('not in PATH'))
    expect(adbCheck?.detail).toContain(customAdb)
  })

  it('Android SDK(cmdline-tools)가 있으면 ok', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    const sdkmanager = join(homedir(), 'Android', 'Sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
    mockExistsSync.mockImplementation((p) => p === sdkmanager)
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })

    const result = await runDoctorChecks('android')
    const sdk = result.android?.find((c) => c.label.includes('Android SDK'))
    expect(sdk?.ok).toBe(true)
  })

  it('build-tools(aapt)가 있으면 aapt 체크 ok', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const sdk = '/opt/android-sdk'
    vi.stubEnv('ANDROID_HOME', sdk)
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    const sdkmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
    const buildTools = join(sdk, 'build-tools')
    const aapt = join(buildTools, '35.0.0', 'aapt')
    mockExistsSync.mockImplementation((p) => p === sdkmanager || p === buildTools || p === aapt)
    mockReaddirSync.mockImplementation((p) => (p === buildTools ? ['35.0.0'] : []) as never)
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('android')
    const aaptCheck = result.android?.find((c) => c.label.includes('aapt'))
    expect(aaptCheck?.ok).toBe(true)
  })

  it('build-tools가 없으면 aapt 체크 warn + setup 안내 (SDK는 있어도)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const sdk = '/opt/android-sdk'
    vi.stubEnv('ANDROID_HOME', sdk)
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    const sdkmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
    mockExistsSync.mockImplementation((p) => p === sdkmanager) // no build-tools
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('android')
    const aaptCheck = result.android?.find((c) => c.label.includes('aapt'))
    expect(aaptCheck?.ok).toBe(false)
    expect(aaptCheck?.warn).toBe(true)
    expect(aaptCheck?.detail).toContain('setup android')
  })

  it('build-tools가 있으면 cmdline-tools(sdkmanager) 없이도 aapt 체크 ok (sdkmanager 비의존 스캔)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const sdk = '/opt/android-sdk'
    vi.stubEnv('ANDROID_HOME', sdk)
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    const buildTools = join(sdk, 'build-tools')
    const aapt = join(buildTools, '35.0.0', 'aapt')
    // sdkmanager(cmdline-tools) 없음, build-tools/aapt만 존재
    mockExistsSync.mockImplementation((p) => p === buildTools || p === aapt)
    mockReaddirSync.mockImplementation((p) => (p === buildTools ? ['35.0.0'] : []) as never)
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('android')
    const aaptCheck = result.android?.find((c) => c.label.includes('aapt'))
    expect(aaptCheck?.ok).toBe(true)
  })

  it('Android SDK가 없으면 fail(✗)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('android')
    const sdk = result.android?.find((c) => c.label === 'Android SDK')
    expect(sdk?.ok).toBe(false)
    expect(sdk?.warn).toBeFalsy()
  })
})
