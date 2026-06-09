import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../../lib/setup.js', () => ({
  runSetupAndroid: vi.fn(),
  runSetupIos: vi.fn(),
}))
vi.mock('../../lib/doctor.js', () => ({
  resolveAdb: vi.fn(),
}))
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}))

import { runSetupAndroid, runSetupIos } from '../../lib/setup.js'
import { resolveAdb } from '../../lib/doctor.js'
import { confirm } from '@clack/prompts'
import { cmdSetup } from '../../commands/setup.js'

const mockRunSetupAndroid = vi.mocked(runSetupAndroid)
const mockRunSetupIos = vi.mocked(runSetupIos)
const mockResolveAdb = vi.mocked(resolveAdb)
const mockConfirm = vi.mocked(confirm)

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

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

  afterEach(() => {
    vi.restoreAllMocks()
    setTTY(undefined)
  })

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

  it('인자 없음 + darwin + adb 없음 + 비대화형 → ios만 (Android 안 물음)', async () => {
    setTTY(false)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 없음 + TTY + Android 수락 → 둘 다', async () => {
    setTTY(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)
    mockConfirm.mockResolvedValue(true as never)

    await cmdSetup()
    expect(mockConfirm).toHaveBeenCalled()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 없음 + TTY + Android 거절 → ios만', async () => {
    setTTY(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)
    mockConfirm.mockResolvedValue(false as never)

    await cmdSetup()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })

  it('전부 ready면 SETUP COMPLETE 배너', async () => {
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode ready', ok: true }])

    await cmdSetup('ios')
    expect(logLines.join('\n')).toContain('SETUP COMPLETE')
  })

  it('미완 step 있으면 SETUP INCOMPLETE 배너 + 사유', async () => {
    mockRunSetupIos.mockResolvedValue([
      { label: 'Xcode ready', ok: true },
      { label: 'Simulator', ok: false, warn: true, detail: '...' },
    ])

    await cmdSetup('ios')
    const out = logLines.join('\n')
    expect(out).toContain('SETUP INCOMPLETE')
    expect(out).toContain('Simulator')
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
