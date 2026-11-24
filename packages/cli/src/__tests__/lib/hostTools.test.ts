import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')

import { execSync } from 'node:child_process'
import { statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { requireOnPath } from '../../lib/hostTools.js'

describe('requireOnPath', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  it('keeps the which probe on macOS and Linux', () => {
    requireOnPath('adb', 'darwin')
    expect(execSync).toHaveBeenCalledWith('which adb', { stdio: 'pipe' })
  })

  it('throws when which does', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    expect(() => requireOnPath('emulator', 'linux')).toThrow('not found')
  })

  // #1100: Windows has no `which`.
  it('resolves through PATH and PATHEXT on Windows without spawning anything', () => {
    vi.stubEnv('PATH', 'C:\\Windows;C:\\sdk\\emulator')
    vi.stubEnv('PATHEXT', '.EXE;.BAT')
    vi.mocked(statSync).mockImplementation(((p: string) => {
      if (String(p) === 'C:\\sdk\\emulator\\emulator.exe') return { isFile: () => true } as Stats
      throw new Error('ENOENT')
    }) as never)

    expect(() => requireOnPath('emulator', 'win32')).not.toThrow()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('throws on Windows when the tool is not on PATH', () => {
    vi.stubEnv('PATH', 'C:\\Windows')
    vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT') })

    expect(() => requireOnPath('adb', 'win32')).toThrow('adb not found on PATH')
    expect(execSync).not.toHaveBeenCalled()
  })
})
