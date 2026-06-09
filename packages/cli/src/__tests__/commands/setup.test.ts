import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../../lib/setup.js', () => ({
  runSetupAndroid: vi.fn(),
  runSetupIos: vi.fn(),
}))
vi.mock('../../lib/doctor.js', () => ({
  resolveAdb: vi.fn(),
}))

import { runSetupAndroid, runSetupIos } from '../../lib/setup.js'
import { resolveAdb } from '../../lib/doctor.js'
import { cmdSetup } from '../../commands/setup.js'

const mockRunSetupAndroid = vi.mocked(runSetupAndroid)
const mockRunSetupIos = vi.mocked(runSetupIos)
const mockResolveAdb = vi.mocked(resolveAdb)

describe('cmdSetup', () => {
  let logLines: string[]
  let errLines: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    logLines = []
    errLines = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errLines.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...args) => errLines.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    mockRunSetupAndroid.mockResolvedValue([{ label: 'Homebrew installed', ok: true }])
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode installed', ok: true }])
  })

  afterEach(() => vi.restoreAllMocks())

  it('setup ios → runSetupIos만 호출', async () => {
    await cmdSetup('ios')
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })

  it('setup android → runSetupAndroid만 호출 (회귀)', async () => {
    await cmdSetup('android')
    expect(mockRunSetupAndroid).toHaveBeenCalled()
    expect(mockRunSetupIos).not.toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 있음 → ios와 android 둘 다', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue({ path: '/x/adb', inPath: true })

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 없음 → ios만', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })

  it('인자 없음 + 감지 0개 → 안내, exit 없음', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockResolveAdb.mockReturnValue(null)

    await cmdSetup()
    expect(mockRunSetupIos).not.toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errLines.join('\n')).toMatch(/no supported platform/i)
  })

  it('알 수 없는 platform → warn + exit(1)', async () => {
    await expect(cmdSetup('windows')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errLines.join('\n')).toMatch(/platform/i)
    expect(mockRunSetupIos).not.toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })
})
