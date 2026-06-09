import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../../lib/setup.js', () => ({
  runSetupAndroid: vi.fn(),
}))

import { runSetupAndroid } from '../../lib/setup.js'
import { cmdSetup } from '../../commands/setup.js'

const mockRunSetupAndroid = vi.mocked(runSetupAndroid)

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
  })

  afterEach(() => vi.restoreAllMocks())

  it('setup android는 runSetupAndroid 결과를 출력', async () => {
    mockRunSetupAndroid.mockResolvedValue([
      { label: 'Homebrew installed', ok: true },
      { label: 'No running emulator', ok: false, warn: true, detail: 'Start an AVD' },
    ])

    await cmdSetup('android')
    expect(mockRunSetupAndroid).toHaveBeenCalled()
    const out = logLines.join('\n')
    expect(out).toContain('Homebrew installed')
    expect(out).toContain('No running emulator')
  })

  it('알 수 없는 platform이면 에러 + exit(1)', async () => {
    await expect(cmdSetup('windows')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errLines.join('\n')).toMatch(/platform/i)
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })
})
