import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('node:net')
const lean = vi.hoisted(() => ({ applied: [] as string[], tiers: {} as Record<string, string> }))
vi.mock('@tapflowio/ios-agent', () => ({
  LeanStore: vi.fn(function () { return { applied: () => lean.applied, currentTier: (udid: string) => ({ name: lean.tiers[udid] ?? 'lean', keep: [] }) } }),
}))

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { runDoctorChecks } from '../../lib/doctor.js'

const mockExistsSync = vi.mocked(existsSync)
const mockReaddirSync = vi.mocked(readdirSync)
const mockReadFileSync = vi.mocked(readFileSync)

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

  it('Node 버전 >= 22이면 ok', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'version', 'get').mockReturnValue('v22.0.0')
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    expect(result.common.find((c) => c.label.includes('Node'))?.ok).toBe(true)
  })

  // v20 specifically: Node 20 went EOL 2026-04-30 and doctor used to pass it. Pinning the old
  // floor as a failure is what proves this check moved with `engines`, rather than a lower one
  // that would still fail either way.
  it('Node 버전 20이면 실패 + detail 포함 (EOL, 하한이 22로 올라감)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'version', 'get').mockReturnValue('v20.0.0')
    mockPortAvailable(true)
    mockExecSync.mockImplementation(() => { throw new Error('not found') })

    const result = await runDoctorChecks()
    const nodeCheck = result.common.find((c) => c.label.includes('Node'))
    expect(nodeCheck?.ok).toBe(false)
    expect(nodeCheck?.detail).toContain('Node ≥ 22')
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
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app' || p === '/Applications/Xcode.app/Contents/Developer')
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
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app' || p === '/Applications/Xcode.app/Contents/Developer')
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

  it('finds an Xcode installed under a versioned name, as xcodes installs it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => String(p).startsWith('/Applications/Xcode-27.0.0.app'))
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcode-select -p') return '/Applications/Xcode-27.0.0.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 27.0\n'
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    expect(result.ios?.find((c) => c.label.startsWith('Xcode'))).toMatchObject({ label: 'Xcode 27.0', ok: true })
  })

  it('names the versioned bundle in the xcode-select hint when it is not selected', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => String(p).startsWith('/Applications/Xcode-27.0.0.app'))
    mockReaddirSync.mockReturnValue(['Xcode-27.0.0.app'] as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c === 'xcodebuild -version') throw new Error('requires Xcode')
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.detail).toContain('sudo xcode-select -s /Applications/Xcode-27.0.0.app/Contents/Developer')
  })

  it('quotes a bundle path with a space in the xcode-select hint', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => String(p).startsWith('/Applications/Xcode 27.app'))
    mockReaddirSync.mockReturnValue(['Xcode 27.app'] as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c === 'xcodebuild -version') throw new Error('requires Xcode')
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks()
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.detail).toContain(`sudo xcode-select -s '/Applications/Xcode 27.app/Contents/Developer'`)
  })

  // xcode-select falls back to /Applications/Xcode.app on its own, never to a versioned bundle, so
  // this Mac has an Xcode and no developer directory: any shim call raises the CLT install dialog.
  it('does not call the shims when the only Xcode is a versioned bundle nothing has selected', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => String(p).startsWith('/Applications/Xcode-27.0.0.app'))
    mockReaddirSync.mockReturnValue(['Xcode-27.0.0.app'] as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcode-select -p') throw new Error('xcode-select: error: unable to get active developer directory')
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('ios')
    const shimCalls = mockExecSync.mock.calls.map(([c]) => String(c)).filter((c) => /^(xcrun|xcodebuild)\b/.test(c))
    expect(shimCalls).toEqual([])
    expect(mockSpawnSync.mock.calls.filter(([c]) => c === 'xcrun' || c === 'xcodebuild')).toEqual([])
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.detail).toContain('sudo xcode-select -s /Applications/Xcode-27.0.0.app/Contents/Developer')
  })

  it('suggests the licence and first launch, not xcode-select, when the found Xcode is already selected', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => String(p).startsWith('/Applications/Xcode-27.0.0.app'))
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcode-select -p') return '/Applications/Xcode-27.0.0.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') throw new Error('You have not agreed to the Xcode license agreements.')
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const result = await runDoctorChecks('ios')
    const xcodeCheck = result.ios?.find((c) => c.label === 'Xcode')
    expect(xcodeCheck?.detail).toContain('xcodebuild -license accept')
    expect(xcodeCheck?.detail).not.toContain('xcode-select -s')
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

  // Setup writes PATH only on a run that installs SDK packages, so on a complete SDK "setup adds it" was not true.
  it('on Windows, names the folder to add to PATH rather than promising setup will add it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\dev\\AppData\\Local')
    vi.stubEnv('PATH', 'C:\\Windows\\System32')
    const sdkAdb = join('C:\\Users\\dev\\AppData\\Local\\Android\\Sdk', 'platform-tools', 'adb.exe')
    mockExistsSync.mockImplementation((p) => p === sdkAdb)
    vi.mocked(statSync).mockImplementation((() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) as never)
    mockExecSync.mockImplementation(() => '')

    const result = await runDoctorChecks('android')
    const adbCheck = result.android?.find((c) => c.label.includes('not in PATH'))
    expect(adbCheck?.detail).toContain(`Add ${win32.dirname(sdkAdb)} to your user PATH`)
    expect(adbCheck?.detail).toContain('new terminal')
    expect(adbCheck?.detail).not.toContain('tapflow setup android')
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

describe('Network hook symbols (#629)', () => {
  // **Its own reset.** The `beforeEach` above lives inside the other `describe`, so without this the
  // call records of every earlier test are still here — and the assertion that no developer tool ran
  // read sixteen `xcodebuild -version` calls made by tests that had already finished.
  beforeEach(() => {
    vi.resetAllMocks()
    // The common checks probe a port; without this they hang on an unmocked `createServer`.
    mockPortAvailable(true)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  // **`node:fs` is mocked in this file, so the check degrades to a warn unless a test sets it up.**
  // That is why the suite stayed green while none of these branches existed: a passing count here was
  // never evidence about this function.
  const SDK = '/Xcode/iPhoneSimulator.sdk'
  const symbolsCheck = (r: Awaited<ReturnType<typeof runDoctorChecks>>) =>
    r.ios?.find((c) => c.label.startsWith('Network hook symbols'))

  function withSdk(declared: string, opts: { stubs?: 'all' | 'none' | 'partial' } = {}) {
    const stubs = opts.stubs ?? 'all'
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => {
      const path = String(p)
      if (path === '/Applications/Xcode.app' || path === '/Applications/Xcode.app/Contents/Developer') return true
      // `partial` keeps only `libSystem.tbd`, which is the shape that matters: the three files
      // partition the symbols, so a fraction of the evidence looks exactly like withdrawn symbols.
      if (path.endsWith('Network.tbd') || path.endsWith('SystemConfiguration.tbd')) return stubs === 'all'
      if (path.endsWith('.tbd')) return stubs !== 'none'
      return true
    })
    mockExecSync.mockImplementation((cmd) => {
      if (String(cmd).includes('--show-sdk-path')) return `${SDK}\n`
      if (String(cmd).includes('simctl list devices')) return simctlNoneBooted
      return ''
    })
    mockReadFileSync.mockReturnValue(declared as never)
  }

  // Nine, from two tables in `network-hook.m`. `hookSymbolsChecked.test.mjs` is what keeps this list
  // and `HOOK_SYMBOLS` from drifting from the dylib; this one is about what `doctor` does with them.
  const ALL = '_getaddrinfo _nw_path_get_status _nw_path_monitor_set_update_handler _nw_path_monitor_set_queue'
    + ' _SCNetworkReachabilityGetFlags _SCNetworkReachabilitySetCallback _SCNetworkReachabilitySetDispatchQueue'
    + ' _SCNetworkReachabilityScheduleWithRunLoop _SCNetworkReachabilityUnscheduleFromRunLoop'

  it('passes when the SDK declares every symbol, and names the SDK it read', async () => {
    withSdk(ALL)
    const c = symbolsCheck(await runDoctorChecks('ios'))
    expect(c?.ok).toBe(true)
    // The label carries the SDK because the answer is about that SDK and not about the runtime a
    // session will actually load — a Mac usually has several, older than its SDK.
    expect(c?.label).toContain('iPhoneSimulator.sdk')
  })

  it('names the symbol that is missing, not merely that one is', async () => {
    // "Something is missing" sends someone to read the `.tbd` files to find out which.
    withSdk(ALL.replace('_nw_path_get_status ', ''))
    const c = symbolsCheck(await runDoctorChecks('ios'))
    expect(c?.ok).toBe(false)
    expect(c?.warn, 'a session works without iOS network control, so this is not a failure').toBe(true)
    expect(c?.detail).toContain('nw_path_get_status')
    expect(c?.detail, 'a symbol that is present was reported as gone').not.toContain('getaddrinfo,')
  })

  it('names a reachability symbol too, which is the half that was added last', async () => {
    // **Aimed at the new entries rather than at the mechanism.** The test above already proves the
    // reporting works; what it cannot prove is that the three symbols added with the reachability set
    // are in the list `doctor` reads. A list that silently lost them would pass everything above.
    withSdk(ALL.replace('_SCNetworkReachabilitySetCallback ', ''))
    const c = symbolsCheck(await runDoctorChecks('ios'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toContain('SCNetworkReachabilitySetCallback')
    expect(c?.detail, 'a symbol that is present was reported as gone').not.toContain('SCNetworkReachabilityGetFlags,')
  })

  it('says it cannot tell when one stub file is absent, rather than that its symbols are gone', async () => {
    // **One present, one missing — the case a `some` check waves through.** The two files partition
    // the symbols, so reading only `libSystem.tbd` finds `getaddrinfo` and none of the three
    // `nw_path_*`: a layout change would be reported as three withdrawn symbols, with a request to
    // file a bug about it. Measured — with all stubs absent, `some` and `every` behave identically
    // and the first version of this test could not tell them apart.
    withSdk('_getaddrinfo only', { stubs: 'partial' })
    const c = symbolsCheck(await runDoctorChecks('ios'))
    expect(c?.ok).toBe(false)
    expect(c?.detail, 'a missing stub file was reported as a missing symbol').not.toContain('does not declare')
    expect(c?.detail).toContain('unknown')
  })

  it('survives a read that throws', async () => {
    // Every probe in this file is a read wrapped in a catch, for the reason its header gives: an
    // unwrapped throw here would reject the whole command and take the Android section with it.
    withSdk(ALL)
    mockReadFileSync.mockImplementation(() => { throw new Error('SDK replaced mid-update') })
    const c = symbolsCheck(await runDoctorChecks('ios'))
    expect(c?.ok).toBe(false)
    expect(c?.warn).toBe(true)
  })

  it('does not run xcrun on a Mac with no Xcode', async () => {
    // **The branch this check must stay out of.** Its own comment says why it exists: `xcrun` on a Mac
    // without Xcode pops the Command Line Tools install dialog — out of a diagnostic command, at a
    // designer or PM who ran `tapflow doctor` to find out why something does not work.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => !String(p).startsWith('/Applications/Xcode.app'))
    mockExecSync.mockImplementation(() => { throw new Error('xcrun must not be called here') })

    const result = await runDoctorChecks('ios')
    expect(symbolsCheck(result), 'the symbol check ran on the no-Xcode path').toBeUndefined()
    // Scoped to `xcrun` rather than to every subprocess: the common checks shell out too, and it is
    // the developer-tools binaries that pop the dialog.
    const devTools = mockExecSync.mock.calls
      .map((c) => String(c[0]))
      .filter((cmd) => cmd.startsWith('xcrun') || cmd.startsWith('xcodebuild'))
    expect(devTools, 'the no-Xcode path invoked developer tools').toEqual([])
  })
})

describe('Lean mode', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockPortAvailable(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app' || p === '/Applications/Xcode.app/Contents/Developer')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'xcodebuild -version') return 'Xcode 26.0\n'
      if (c.startsWith('xcrun simctl')) return simctlBooted
      if (c === 'which adb') throw new Error('not found')
      return ''
    })
    lean.applied = []
    lean.tiers = {}
  })
  afterEach(() => vi.restoreAllMocks())

  const leanCheck = async (on: boolean) =>
    (await runDoctorChecks('ios', { lean: on })).ios?.find((c) => c.label.startsWith('Lean mode (iOS)'))

  it('says it is on, and how many devices are lean right now', async () => {
    lean.applied = ['AAA']
    expect(await leanCheck(true)).toMatchObject({ label: 'Lean mode (iOS): on (1 device lean now)', ok: true })
  })

  it('does not count a device that no longer exists', async () => {
    // The host directory outlives `simctl delete`, so its marker does too.
    lean.applied = ['AAA', 'GONE']
    expect((await leanCheck(true))?.label).toBe('Lean mode (iOS): on (1 device lean now)')
  })

  it('says it is off', async () => {
    expect(await leanCheck(false)).toMatchObject({ label: 'Lean mode (iOS): off', ok: true })
  })

  it('reports the Android setting on its own line', async () => {
    const r = await runDoctorChecks(undefined, { lean: true })
    expect(r.android?.find((c) => c.label.startsWith('Lean mode'))?.label).toBe('Lean mode (Android): on')
    expect(r.ios?.filter((c) => c.label.startsWith('Lean mode'))).toHaveLength(1)
    const off = await runDoctorChecks(undefined, { lean: false })
    expect(off.android?.find((c) => c.label.startsWith('Lean mode'))?.label).toBe('Lean mode (Android): off')
  })

  it('asks simctl for the device list once, not once per check', async () => {
    await leanCheck(true)
    expect(mockExecSync.mock.calls.filter(([c]) => String(c).startsWith('xcrun simctl list devices'))).toHaveLength(1)
  })

  it('names the tier a run left a device on', async () => {
    lean.applied = ['AAA', 'BBB']
    lean.tiers = { BBB: 'slim' }
    expect((await leanCheck(true))?.label).toBe('Lean mode (iOS): on (2 devices: 1 lean, 1 slim now)')
    lean.applied = ['BBB']
    expect((await leanCheck(false))?.label).toBe('Lean mode (iOS): off (1 device still slim)')
  })

  it('says when it is off but a device is still lean, and when that clears', async () => {
    lean.applied = ['BBB']
    const check = await leanCheck(false)
    expect(check?.label).toBe('Lean mode (iOS): off (1 device still lean)')
    expect(check?.detail).toMatch(/puts each one back when it connects and finds it shut down/)
  })
  // #1100: on Windows the SDK's tools are adb.exe, emulator.exe, aapt.exe and sdkmanager.bat, the
  // default SDK is %LOCALAPPDATA%\Android\Sdk, and there is no `which`.
  it('finds a Windows SDK by its .exe/.bat names, without running which', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\dev\\AppData\\Local')
    const sdk = 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk'
    const toolsDir = 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools'
    vi.stubEnv('PATH', `C:\\Windows\\System32;${toolsDir}`)
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT')
    const onPathAdb = 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe'
    const present = new Set([
      join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'),
      join(sdk, 'build-tools'),
      join(sdk, 'build-tools', '35.0.0', 'aapt.exe'),
      join(sdk, 'emulator', 'emulator.exe'),
    ])
    mockExistsSync.mockImplementation((p) => present.has(String(p)))
    mockReaddirSync.mockImplementation(((p: string) => (String(p) === join(sdk, 'build-tools') ? ['35.0.0'] : [])) as never)
    vi.mocked(statSync).mockImplementation(((p: string) => {
      if (String(p) === onPathAdb) return { isFile: () => true } as Stats
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }) as never)
    mockSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === join(sdk, 'emulator', 'emulator.exe') && args[0] === '-list-avds') return { stdout: 'Pixel_8\r\nPixel_Fold\r\n' }
      return { stdout: '' }
    }) as never)
    mockExecSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('which')) throw new Error('which does not exist on Windows')
      return ''
    })

    const result = await runDoctorChecks('android')
    const labels = result.android?.map((c) => c.label) ?? []
    expect(labels).toContain(`Android SDK: ${sdk}`)
    expect(labels).toContain(`adb found: ${onPathAdb}`)
    expect(labels).toContain(`aapt (build-tools): ${join(sdk, 'build-tools', '35.0.0', 'aapt.exe')}`)
    // CRLF output from emulator.exe must not leave a trailing \r on the AVD name.
    expect(labels).toContain('AVD available: Pixel_8')
    expect(mockExecSync.mock.calls.some(([c]) => String(c).startsWith('which'))).toBe(false)
  })
})
