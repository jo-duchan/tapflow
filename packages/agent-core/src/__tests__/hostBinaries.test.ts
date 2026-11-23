import { describe, it, expect } from 'vitest'
import { androidSdkCandidates, findOnPath, hostExecutableName } from '../utils/hostBinaries'

describe('hostExecutableName', () => {
  it('leaves names alone off Windows', () => {
    expect(hostExecutableName('adb', 'darwin')).toBe('adb')
    expect(hostExecutableName('sdkmanager', 'linux')).toBe('sdkmanager')
  })

  it('adds .exe to binaries and .bat to the SDK scripts on Windows', () => {
    expect(hostExecutableName('adb', 'win32')).toBe('adb.exe')
    expect(hostExecutableName('emulator', 'win32')).toBe('emulator.exe')
    expect(hostExecutableName('aapt', 'win32')).toBe('aapt.exe')
    expect(hostExecutableName('sdkmanager', 'win32')).toBe('sdkmanager.bat')
    expect(hostExecutableName('avdmanager', 'win32')).toBe('avdmanager.bat')
  })

  it('keeps an extension that is already there', () => {
    expect(hostExecutableName('adb.exe', 'win32')).toBe('adb.exe')
  })
})

describe('findOnPath', () => {
  it('returns the first PATH entry holding the file on POSIX', () => {
    const files = new Set(['/opt/b/adb', '/opt/c/adb'])
    const found = findOnPath('adb', {
      platform: 'darwin',
      env: { PATH: '/opt/a:/opt/b:/opt/c' },
      isFile: (c) => files.has(c),
    })
    expect(found).toBe('/opt/b/adb')
  })

  it('returns null when nothing matches', () => {
    expect(findOnPath('adb', { platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => false })).toBeNull()
  })

  it('returns null with no PATH at all', () => {
    expect(findOnPath('adb', { platform: 'linux', env: {}, isFile: () => true })).toBeNull()
  })

  it('tries PATHEXT extensions on Windows, reading Path case-insensitively', () => {
    const files = new Set(['C:\\sdk\\platform-tools\\adb.exe'])
    const found = findOnPath('adb', {
      platform: 'win32',
      env: { Path: 'C:\\Windows\\System32;C:\\sdk\\platform-tools', PATHEXT: '.COM;.EXE;.BAT' },
      isFile: (c) => files.has(c),
    })
    expect(found).toBe('C:\\sdk\\platform-tools\\adb.exe')
  })

  it('falls back to the default PATHEXT when it is unset on Windows', () => {
    const files = new Set(['C:\\sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat'])
    const found = findOnPath('sdkmanager', {
      platform: 'win32',
      env: { PATH: 'C:\\Windows;C:\\sdk\\cmdline-tools\\latest\\bin' },
      isFile: (c) => files.has(c),
    })
    expect(found).toBe('C:\\sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat')
  })

  it('unwraps a quoted PATH entry on Windows', () => {
    const files = new Set(['C:\\Program Files\\Android\\platform-tools\\adb.exe'])
    const found = findOnPath('adb', {
      platform: 'win32',
      env: { PATH: '"C:\\Program Files\\Android\\platform-tools"' },
      isFile: (c) => files.has(c),
    })
    expect(found).toBe('C:\\Program Files\\Android\\platform-tools\\adb.exe')
  })

  it('uses a given extension as-is on Windows', () => {
    const files = new Set(['C:\\bin\\adb.exe'])
    expect(findOnPath('adb.exe', { platform: 'win32', env: { PATH: 'C:\\bin' }, isFile: (c) => files.has(c) }))
      .toBe('C:\\bin\\adb.exe')
  })
})

describe('androidSdkCandidates', () => {
  it('keeps the macOS and Linux defaults after the env vars off Windows', () => {
    expect(androidSdkCandidates({ platform: 'darwin', env: { ANDROID_HOME: '/sdk' }, home: '/Users/me' })).toEqual([
      '/sdk',
      '/Users/me/Library/Android/sdk',
      '/Users/me/Android/Sdk',
    ])
  })

  it('uses %LOCALAPPDATA%\\Android\\Sdk on Windows', () => {
    expect(androidSdkCandidates({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ANDROID_SDK_ROOT: 'D:\\sdk' },
      home: 'C:\\Users\\me',
    })).toEqual(['D:\\sdk', 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk'])
  })

  it('derives the Windows default from the home directory when LOCALAPPDATA is unset', () => {
    expect(androidSdkCandidates({ platform: 'win32', env: {}, home: 'C:\\Users\\me' }))
      .toEqual(['C:\\Users\\me\\AppData\\Local\\Android\\Sdk'])
  })
})
