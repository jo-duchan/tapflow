import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { accessSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'

vi.mock('node:fs', () => ({ statSync: vi.fn(), accessSync: vi.fn(), constants: { X_OK: 1 } }))
vi.mock('node:os', () => ({ homedir: () => '/Users/dev' }))

import { ValidationError } from '@tapflowio/agent-core'
import { getAdbPath, getEmulatorPath } from '../sdk'

const STUDIO_SDK = '/Users/dev/Library/Android/sdk'

/** The fake disk: `paths` are executable files, `extra` holds what exists but cannot be run. */
function onDisk(...paths: string[]): void {
  disk(paths)
}

function disk(executables: string[], extra: { dirs?: string[]; nonExec?: string[] } = {}): void {
  const exec = new Set(executables)
  const dirs = new Set(extra.dirs)
  const nonExec = new Set(extra.nonExec)
  vi.mocked(statSync).mockImplementation(((p: string) => {
    const path = String(p)
    if (dirs.has(path)) return { isFile: () => false } as Stats
    if (exec.has(path) || nonExec.has(path)) return { isFile: () => true } as Stats
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }) as never)
  // A directory passes `X_OK` on a real disk (its x bit means searchable), so only `isFile` can
  // reject it; the fake answers the same way rather than letting `accessSync` do that job.
  vi.mocked(accessSync).mockImplementation((p) => {
    if (!exec.has(String(p)) && !dirs.has(String(p))) throw Object.assign(new Error(`EACCES: ${String(p)}`), { code: 'EACCES' })
  })
}

describe('Android SDK resolution', () => {
  beforeEach(() => {
    vi.stubEnv('ADB_PATH', '')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.mocked(statSync).mockReset()
    vi.mocked(accessSync).mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  // #903: Android Studio's SDK, platform-tools on PATH, no ANDROID_HOME. doctor passed and the agent
  // reported 0 devices, because this lookup threw and the caller swallowed it.
  it('finds the Android Studio SDK without ANDROID_HOME', () => {
    onDisk(join(STUDIO_SDK, 'platform-tools', 'adb'), join(STUDIO_SDK, 'emulator', 'emulator'))

    expect(getAdbPath()).toBe(join(STUDIO_SDK, 'platform-tools', 'adb'))
    expect(getEmulatorPath()).toBe(join(STUDIO_SDK, 'emulator', 'emulator'))
  })

  it('prefers ANDROID_HOME over the standard location', () => {
    vi.stubEnv('ANDROID_HOME', '/opt/sdk')
    onDisk('/opt/sdk/platform-tools/adb', join(STUDIO_SDK, 'platform-tools', 'adb'))

    expect(getAdbPath()).toBe('/opt/sdk/platform-tools/adb')
  })

  it('reads ANDROID_SDK_ROOT when ANDROID_HOME is unset', () => {
    vi.stubEnv('ANDROID_SDK_ROOT', '/opt/sdk-root')
    onDisk('/opt/sdk-root/emulator/emulator', join(STUDIO_SDK, 'emulator', 'emulator'))

    expect(getEmulatorPath()).toBe('/opt/sdk-root/emulator/emulator')
  })

  // A stale ANDROID_HOME used to be taken on trust and fail at spawn time instead.
  it('moves past an ANDROID_HOME that does not hold the tool', () => {
    vi.stubEnv('ANDROID_HOME', '/stale/sdk')
    onDisk(join(STUDIO_SDK, 'emulator', 'emulator'))

    expect(getEmulatorPath()).toBe(join(STUDIO_SDK, 'emulator', 'emulator'))
  })

  // The agent registers on `which adb`, so an adb it registered on has to be one it can also run.
  it('falls back to adb on PATH when no SDK candidate holds it', () => {
    vi.stubEnv('PATH', '/usr/bin:/opt/homebrew/bin')
    onDisk('/opt/homebrew/bin/adb')

    expect(getAdbPath()).toBe('/opt/homebrew/bin/adb')
  })

  it('falls back to the emulator on PATH too', () => {
    vi.stubEnv('PATH', '/usr/bin:/opt/android/emulator')
    onDisk('/opt/android/emulator/emulator')

    expect(getEmulatorPath()).toBe('/opt/android/emulator/emulator')
  })

  // Existing is not enough: a stale ANDROID_HOME whose `adb` lost its execute bit must not win over
  // the working SDK behind it.
  it('passes over an SDK candidate that is not executable', () => {
    vi.stubEnv('ANDROID_HOME', '/stale/sdk')
    disk([join(STUDIO_SDK, 'platform-tools', 'adb')], { nonExec: ['/stale/sdk/platform-tools/adb'] })

    expect(getAdbPath()).toBe(join(STUDIO_SDK, 'platform-tools', 'adb'))
  })

  // The SDK root on PATH puts its `emulator/` folder where a PATH search for `emulator` looks.
  it('passes over a directory on PATH with the tool name', () => {
    vi.stubEnv('PATH', '/Users/dev/sdk-root:/opt/android/emulator')
    disk(['/opt/android/emulator/emulator'], { dirs: ['/Users/dev/sdk-root/emulator'] })

    expect(getEmulatorPath()).toBe('/opt/android/emulator/emulator')
  })

  it('keeps ADB_PATH as an explicit override', () => {
    vi.stubEnv('ADB_PATH', '/custom/adb')
    onDisk(join(STUDIO_SDK, 'platform-tools', 'adb'))

    expect(getAdbPath()).toBe('/custom/adb')
  })

  it('names ANDROID_HOME in the error when nothing is found', () => {
    onDisk()

    expect(() => getAdbPath()).toThrow(ValidationError)
    expect(() => getEmulatorPath()).toThrow(/ANDROID_HOME/)
  })
})

// #1100: on Windows the tools are `adb.exe` and `emulator.exe`, and the default SDK is
// %LOCALAPPDATA%\Android\Sdk.
describe('Android SDK resolution on Windows', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ADB_PATH', '')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\dev\\AppData\\Local')
    vi.stubEnv('PATH', '')
    vi.mocked(statSync).mockReset()
    vi.mocked(accessSync).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const WIN_SDK = 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk'

  it('finds adb.exe and emulator.exe in the default Windows SDK', () => {
    onDisk(join(WIN_SDK, 'platform-tools', 'adb.exe'), join(WIN_SDK, 'emulator', 'emulator.exe'))

    expect(getAdbPath()).toBe(join(WIN_SDK, 'platform-tools', 'adb.exe'))
    expect(getEmulatorPath()).toBe(join(WIN_SDK, 'emulator', 'emulator.exe'))
  })

  it('does not take an extensionless file for the Windows binary', () => {
    onDisk(join(WIN_SDK, 'platform-tools', 'adb'))

    expect(() => getAdbPath()).toThrow(ValidationError)
  })

  it('gives a Windows example in the error', () => {
    onDisk()

    expect(() => getAdbPath()).toThrow(/setx ANDROID_HOME/)
  })
})
