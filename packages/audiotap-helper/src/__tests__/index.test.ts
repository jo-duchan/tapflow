import { describe, it, expect, vi } from 'vitest'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import { execFileSync } from 'node:child_process'
import { launchAudioHelper, launchMuteOnlyTap, isAudioSupported } from '../index'
import os from 'node:os'
const mockExecFileSync = vi.mocked(execFileSync)

describe('launchAudioHelper (iOS capture, per-sim isolation)', () => {
  it('forces a new instance with -n and passes port + pids', () => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue('' as never)
    launchAudioHelper('/x/audiotap-helper.app', 12345, [101, 102])
    const [cmd, args] = mockExecFileSync.mock.calls[0]
    expect(cmd).toBe('open')
    // -n prevents `open -a` from reusing the first sim's helper (multi-sim audio bug)
    expect(args).toEqual(['-g', '-n', '-a', '/x/audiotap-helper.app', '--args', '12345', '101', '102'])
  })
})

describe('launchMuteOnlyTap (Android host-mute)', () => {
  it('launches --mute-only with -n and the given pids (no port)', () => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue('' as never)
    launchMuteOnlyTap('/x/audiotap-helper.app', [67786])
    const [cmd, args] = mockExecFileSync.mock.calls[0]
    expect(cmd).toBe('open')
    expect(args).toEqual(['-g', '-n', '-a', '/x/audiotap-helper.app', '--args', '--mute-only', '67786'])
  })
})

describe('isAudioSupported (macOS 14.2+ / Darwin 23.2+ gate)', () => {
  function withRelease<T>(release: string, fn: () => T): T {
    const spy = vi.spyOn(os, 'release').mockReturnValue(release)
    try { return fn() } finally { spy.mockRestore() }
  }

  it('true on Darwin 23.2 (macOS 14.2) and above', () => {
    expect(withRelease('23.2.0', isAudioSupported)).toBe(true)
    expect(withRelease('23.6.0', isAudioSupported)).toBe(true)
    expect(withRelease('24.0.0', isAudioSupported)).toBe(true)
  })

  it('false below Darwin 23.2 (macOS < 14.2)', () => {
    expect(withRelease('23.1.0', isAudioSupported)).toBe(false)
    expect(withRelease('22.6.0', isAudioSupported)).toBe(false)
  })
})
