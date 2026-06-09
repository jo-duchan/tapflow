import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}))

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { confirm, text } from '@clack/prompts'
import { runSetupAndroid, runSetupIos } from '../../lib/setup.js'

const mockExecSync = vi.mocked(execSync)
const mockSpawnSync = vi.mocked(spawnSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockAppendFileSync = vi.mocked(appendFileSync)
const mockConfirm = vi.mocked(confirm)
const mockText = vi.mocked(text)
const XCODE_APP = '/Applications/Xcode.app'

const STUDIO_APP = '/Applications/Android Studio.app'
const sdkAdb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb')
const zshrc = join(homedir(), '.zshrc')

const okSpawn = { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null }

function findStep(results: { label: string }[], keyword: string) {
  return results.find((r) => r.label.toLowerCase().includes(keyword.toLowerCase()))
}

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

describe('runSetupAndroid', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('SHELL', '/bin/zsh')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReturnValue('')
    mockSpawnSync.mockReturnValue(okSpawn as never)
    mockConfirm.mockResolvedValue(true as never)
    // 기본: 완전히 구성된 머신 (각 테스트에서 필요한 부분만 override)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setTTY(undefined)
  })

  it('Homebrew 있으면 ok', async () => {
    const results = await runSetupAndroid()
    expect(findStep(results, 'homebrew')?.ok).toBe(true)
  })

  it('Homebrew 없음 + 비대화형이면 confirm 없이 warn + 안내', async () => {
    setTTY(false)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') throw new Error('not found')
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })

    const results = await runSetupAndroid()
    const brew = findStep(results, 'homebrew')
    expect(brew?.ok).toBe(false)
    expect(brew?.warn).toBe(true)
    expect(brew?.detail).toContain('brew.sh')
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockSpawnSync).not.toHaveBeenCalledWith('/bin/bash', expect.any(Array), expect.anything())
  })

  it('Homebrew 없음 + TTY + 수락 시 공식 스크립트 설치', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') throw new Error('not found')
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })

    const results = await runSetupAndroid()
    expect(mockConfirm).toHaveBeenCalled()
    expect(mockSpawnSync).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', expect.stringContaining('Homebrew/install')],
      expect.anything(),
    )
    expect(findStep(results, 'homebrew')?.ok).toBe(true)
  })

  it('Homebrew 없음 + TTY + 거절 시 warn + 설치 미실행', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(false as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') throw new Error('not found')
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })

    const results = await runSetupAndroid()
    const brew = findStep(results, 'homebrew')
    expect(brew?.warn).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('/bin/bash', expect.any(Array), expect.anything())
  })

  it('adb가 PATH에 있으면 ok, 설치/등록 미호출', async () => {
    const results = await runSetupAndroid()
    expect(findStep(results, 'adb')?.ok).toBe(true)
    expect(mockAppendFileSync).not.toHaveBeenCalled()
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', 'android-platform-tools'], expect.anything())
  })

  it('adb 부재 시 brew install android-platform-tools 실행', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') throw new Error('not found')
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === STUDIO_APP)

    const results = await runSetupAndroid()
    expect(mockSpawnSync).toHaveBeenCalledWith('brew', ['install', 'android-platform-tools'], expect.anything())
    expect(findStep(results, 'adb')?.ok).toBe(true)
  })

  it('adb가 SDK엔 있고 PATH 없으면 shell rc에 PATH 등록', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') throw new Error('not found')
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === sdkAdb || p === STUDIO_APP)

    const results = await runSetupAndroid()
    const adb = findStep(results, 'adb')
    expect(adb?.ok).toBe(true)
    expect(mockAppendFileSync).toHaveBeenCalledWith(zshrc, expect.stringContaining('platform-tools'))
    expect(adb?.detail).toContain('.zshrc')
    // brew install은 호출되지 않아야 (이미 SDK에 있음)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', 'android-platform-tools'], expect.anything())
  })

  it('PATH 등록 멱등 — rc에 마커가 이미 있으면 append 안 함', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') throw new Error('not found')
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === sdkAdb || p === STUDIO_APP || p === zshrc)
    mockReadFileSync.mockReturnValue(
      '# >>> tapflow android sdk >>>\nexport PATH="x:$PATH"\n# <<< tapflow android sdk <<<\n',
    )

    const results = await runSetupAndroid()
    expect(findStep(results, 'adb')?.ok).toBe(true)
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  it('bash 셸이면 .bashrc에 등록', async () => {
    vi.stubEnv('SHELL', '/bin/bash')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') throw new Error('not found')
      if (c.includes('devices')) return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === sdkAdb || p === STUDIO_APP)

    await runSetupAndroid()
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      join(homedir(), '.bashrc'),
      expect.stringContaining('platform-tools'),
    )
  })

  it('Android Studio 있으면 ok, cask 설치 미호출', async () => {
    mockExistsSync.mockImplementation((p) => p === STUDIO_APP)

    const results = await runSetupAndroid()
    expect(findStep(results, 'android studio')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', '--cask', 'android-studio'], expect.anything())
  })

  it('Android Studio 없고 확인 수락 시 cask 설치', async () => {
    setTTY(true)
    mockExistsSync.mockReturnValue(false) // Android Studio 없음
    mockConfirm.mockResolvedValue(true as never)

    const results = await runSetupAndroid()
    expect(mockConfirm).toHaveBeenCalled()
    expect(mockSpawnSync).toHaveBeenCalledWith('brew', ['install', '--cask', 'android-studio'], expect.anything())
    expect(findStep(results, 'android studio')?.ok).toBe(true)
  })

  it('Android Studio 확인 거절 시 warn + 설치 미실행', async () => {
    setTTY(true)
    mockExistsSync.mockReturnValue(false)
    mockConfirm.mockResolvedValue(false as never)

    const results = await runSetupAndroid()
    const studio = findStep(results, 'android studio')
    expect(studio?.warn).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', '--cask', 'android-studio'], expect.anything())
  })

  it('비대화형(non-TTY)이면 cask 설치 skip + 안내', async () => {
    setTTY(false)
    mockExistsSync.mockReturnValue(false)

    const results = await runSetupAndroid()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', '--cask', 'android-studio'], expect.anything())
    expect(findStep(results, 'android studio')?.warn).toBe(true)
  })

  it('AVD가 있으면 ok (부팅 안 함)', async () => {
    const results = await runSetupAndroid()
    expect(findStep(results, 'avd')?.ok).toBe(true)
  })

  it('AVD가 없으면 비대화형에서 warn (생성 안 함)', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c === 'emulator -list-avds') return ''
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === STUDIO_APP)

    const results = await runSetupAndroid()
    expect(findStep(results, 'avd')?.warn).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('미지원 셸(fish 등)이면 자동 등록 대신 warn + 수동 export 안내', async () => {
    vi.stubEnv('SHELL', '/usr/bin/fish')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') throw new Error('not found')
      if (c.includes('devices')) return 'List of devices attached\n'
      return ''
    })
    mockExistsSync.mockImplementation((p) => p === sdkAdb || p === STUDIO_APP)

    const results = await runSetupAndroid()
    const adb = findStep(results, 'adb')
    expect(adb?.warn).toBe(true)
    expect(adb?.detail).toContain('export PATH')
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  it('AVD 없음 + TTY + 수락 시 sdkmanager + avdmanager로 생성', async () => {
    setTTY(true)
    vi.stubEnv('ANDROID_HOME', '/opt/android-sdk')
    mockConfirm.mockResolvedValue(true as never)
    const sdkmanager = join('/opt/android-sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
    const avdmanager = join('/opt/android-sdk', 'cmdline-tools', 'latest', 'bin', 'avdmanager')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'which adb') return '/opt/homebrew/bin/adb\n'
      if (c === 'emulator -list-avds') return ''
      return ''
    })
    mockExistsSync.mockImplementation(
      (p) => p === STUDIO_APP || p === '/opt/android-sdk' || p === sdkmanager || p === avdmanager,
    )

    const results = await runSetupAndroid()
    expect(mockSpawnSync).toHaveBeenCalledWith(sdkmanager, [expect.stringContaining('system-images')], expect.anything())
    expect(mockSpawnSync).toHaveBeenCalledWith(avdmanager, expect.arrayContaining(['create', 'avd']), expect.anything())
    expect(findStep(results, 'avd')?.ok).toBe(true)
  })

  it('멱등 — 완전히 구성된 머신은 전부 ok, 부작용 없음', async () => {
    mockExistsSync.mockImplementation((p) => p === STUDIO_APP)

    const results = await runSetupAndroid()
    expect(results.every((r) => r.ok)).toBe(true)
    expect(mockAppendFileSync).not.toHaveBeenCalled()
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })
})

describe('runSetupIos', () => {
  const simctlBooted = JSON.stringify({
    devices: { 'iOS-18': [{ udid: 'AAA', name: 'iPhone 16 Pro', state: 'Booted' }] },
  })
  const simctlShutdown = JSON.stringify({
    devices: { 'iOS-18': [{ udid: 'BBB', name: 'iPhone 15', state: 'Shutdown' }] },
  })
  const simctlEmpty = JSON.stringify({ devices: {} })

  beforeEach(() => {
    vi.resetAllMocks()
    mockSpawnSync.mockReturnValue(okSpawn as never)
    mockConfirm.mockResolvedValue(true as never)
    mockText.mockResolvedValue('' as never)
    // 기본: 완전히 구성된 macOS (brew·Xcode·활성화·Booted 시뮬)
    mockExistsSync.mockImplementation((p) => p === XCODE_APP)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setTTY(undefined)
  })

  it('Xcode 설치돼 있으면 ok', async () => {
    const results = await runSetupIos()
    expect(findStep(results, 'xcode')?.ok).toBe(true)
  })

  it('Xcode 미설치 + 비대화형이면 warn + App Store 링크', async () => {
    setTTY(false)
    mockExistsSync.mockReturnValue(false)

    const results = await runSetupIos()
    const xcode = findStep(results, 'xcode')
    expect(xcode?.warn).toBe(true)
    expect(xcode?.detail).toContain('apps.apple.com')
    expect(mockText).not.toHaveBeenCalled()
  })

  it('Xcode 미설치 + TTY → App Store 열고 재확인 후 설치되면 ok', async () => {
    setTTY(true)
    // 처음엔 미설치, 두 번째 호출(재확인)부터 설치됨
    let calls = 0
    mockExistsSync.mockImplementation((p) => {
      if (p === XCODE_APP) return calls++ > 0
      return false
    })

    const results = await runSetupIos()
    expect(mockText).toHaveBeenCalled()
    expect(mockSpawnSync).toHaveBeenCalledWith('open', [expect.stringContaining('apps.apple.com')], expect.anything())
    expect(findStep(results, 'xcode')?.ok).toBe(true)
  })

  it('active dir이 CommandLineTools면 활성화 단계 warn + xcode-select 안내', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })

    const results = await runSetupIos()
    const act = results.find((r) => r.detail?.includes('xcode-select -s'))
    expect(act?.warn).toBe(true)
  })

  it('디바이스가 있으면 부팅하지 않고 ready', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlShutdown // 미부팅 디바이스 존재
      return ''
    })

    const results = await runSetupIos()
    expect(findStep(results, 'simulator')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('xcrun', expect.anything(), expect.anything())
  })

  it('사용 가능한 시뮬레이터가 없으면 비대화형에서 warn', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlEmpty
      return ''
    })

    const results = await runSetupIos()
    expect(findStep(results, 'simulator')?.warn).toBe(true)
  })

  it('active dir이 CommandLineTools + TTY + 수락 시 sudo xcode-select 직접 실행', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })

    const results = await runSetupIos()
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['xcode-select', '-s', '/Applications/Xcode.app/Contents/Developer'],
      expect.anything(),
    )
    expect(findStep(results, 'xcode ready')?.ok).toBe(true)
  })

  it('시뮬 디바이스 없음 + TTY + 수락 시 xcodebuild -downloadPlatform 실행', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlEmpty
      return ''
    })

    await runSetupIos()
    expect(mockSpawnSync).toHaveBeenCalledWith('xcodebuild', ['-downloadPlatform', 'iOS'], expect.anything())
  })

  it('멱등 — 완전 구성 머신은 전부 ok, 부작용 없음', async () => {
    const results = await runSetupIos()
    expect(results.every((r) => r.ok)).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })
})
