import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}))

import { execSync } from 'node:child_process'
import * as readline from 'node:readline/promises'
import { cmdReset } from '../../commands/reset.js'

const mockExecSync = vi.mocked(execSync)
const mockCreateInterface = vi.mocked(readline.createInterface)

function mockRl(answer: string) {
  mockCreateInterface.mockReturnValue({
    question: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  } as never)
}

describe('cmdReset', () => {
  let output: string[]

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => vi.restoreAllMocks())

  it('"n" 입력 시 Aborted 출력 후 종료', async () => {
    mockRl('n')
    await cmdReset()
    expect(output.join('\n')).toContain('Aborted')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('"y" 입력 시 iOS 시뮬레이터 종료', async () => {
    mockRl('y')
    mockExecSync.mockImplementation(() => '')

    await cmdReset()
    expect(mockExecSync).toHaveBeenCalledWith('xcrun simctl shutdown all', expect.anything())
  })

  it('"y" 입력 + adb 있으면 Android 에뮬레이터도 종료', async () => {
    mockRl('y')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n'
      return ''
    })

    await cmdReset()
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('adb -s emulator-5554 emu kill'),
      expect.anything(),
    )
  })

  it('실행 중인 Android 에뮬레이터 없으면 "no running emulators" 출력', async () => {
    mockRl('y')
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      if (c === 'adb devices') return 'List of devices attached\n'
      return ''
    })

    await cmdReset()
    expect(output.join('\n')).toContain('no running emulators')
  })

  it('완료 후 "RESET COMPLETE" 배너 출력', async () => {
    mockRl('y')
    mockExecSync.mockImplementation(() => '')

    await cmdReset()
    expect(output.join('\n')).toContain('RESET COMPLETE')
  })

  it('대소문자 구분 없이 "Y" 도 허용', async () => {
    mockRl('Y')
    mockExecSync.mockImplementation(() => '')

    await cmdReset()
    expect(output.join('\n')).toContain('RESET COMPLETE')
  })
})
