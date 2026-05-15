import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

import { execSync, spawn } from 'node:child_process'
import { cmdBoot } from '../../commands/boot.js'

const mockExecSync = vi.mocked(execSync)
const mockSpawn = vi.mocked(spawn)

const simctlWith = (state: 'Booted' | 'Shutdown') =>
  JSON.stringify({
    devices: { 'iOS-17': [{ udid: 'AAA-BBB', name: 'iPhone 16 Pro', state }] },
  })

describe('cmdBoot', () => {
  let logLines: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any

  beforeEach(() => {
    vi.resetAllMocks()
    // resetAllMocks 후 spawn 기본 반환값 재설정 (없으면 child.unref()가 throw → try/catch에 잡힘)
    mockSpawn.mockReturnValue({ unref: vi.fn() } as never)
    logLines = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => vi.restoreAllMocks())

  it('이름으로 iOS 시뮬레이터 부팅', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlWith('Shutdown')
      return ''
    })

    await cmdBoot('iPhone 16 Pro')
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('xcrun simctl boot AAA-BBB'),
      expect.anything(),
    )
  })

  it('UDID로 iOS 시뮬레이터 부팅', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlWith('Shutdown')
      return ''
    })

    await cmdBoot('AAA-BBB')
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('xcrun simctl boot AAA-BBB'),
      expect.anything(),
    )
  })

  it('이미 부팅된 시뮬레이터는 early return', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return simctlWith('Booted')
      return ''
    })

    await cmdBoot('iPhone 16 Pro')
    expect(logLines.join('\n')).toContain('already booted')
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('xcrun simctl boot'),
      expect.anything(),
    )
  })

  it('iOS에 없으면 Android AVD로 폴백하여 emulator 실행', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return JSON.stringify({ devices: {} })
      if (c === 'which emulator') return '/usr/local/bin/emulator\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    await cmdBoot('Pixel_8')
    expect(mockSpawn).toHaveBeenCalledWith(
      'emulator',
      ['@Pixel_8'],
      expect.objectContaining({ detached: true }),
    )
  })

  it('iOS도 Android도 없으면 exit(1)', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl list devices')) return JSON.stringify({ devices: {} })
      if (c === 'which emulator') return '/usr/local/bin/emulator\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    await expect(cmdBoot('NonExistent')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('xcrun 실패 시 Android로 폴백', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c.includes('xcrun simctl')) throw new Error('xcrun not found')
      if (c === 'which emulator') return '/usr/local/bin/emulator\n'
      if (c === 'emulator -list-avds') return 'Pixel_8\n'
      return ''
    })

    await cmdBoot('Pixel_8')
    expect(mockSpawn).toHaveBeenCalledWith('emulator', ['@Pixel_8'], expect.anything())
  })
})
