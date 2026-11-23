import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@tapflowio/ios-agent', () => ({ isAudioSupported: vi.fn(() => false), requestAudioPermission: vi.fn() }))
vi.mock('../../lib/setup-android-windows.js', () => ({
  runSetupAndroidWindows: vi.fn(async () => [{ label: 'windows path', ok: true }]),
  realWindowsDeps: vi.fn((opts: { assumeYes?: boolean }) => ({ fake: true, ...opts })),
}))

import { runSetupAndroid } from '../../lib/setup.js'
import { runSetupAndroidWindows, realWindowsDeps } from '../../lib/setup-android-windows.js'

describe('runSetupAndroid on Windows', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes the Windows path instead of Homebrew', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(await runSetupAndroid()).toEqual([{ label: 'windows path', ok: true }])
    expect(runSetupAndroidWindows).toHaveBeenCalledOnce()
    expect(realWindowsDeps).toHaveBeenLastCalledWith({ assumeYes: undefined })
  })

  it('hands --yes to the Windows flow', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await runSetupAndroid({ assumeYes: true })
    expect(realWindowsDeps).toHaveBeenLastCalledWith({ assumeYes: true })
  })
})
