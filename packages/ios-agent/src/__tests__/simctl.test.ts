import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('child_process', () => ({ execFile: execFileMock }))

import { defaultRunner } from '../simctl'

const VERSION_MISMATCH_ERR = Object.assign(new Error('simctl failed'), {
  stderr: 'CoreSimulator.framework was changed while the process was running. Service version (1051.50) does not match expected service version (1051.54).',
})

describe('defaultRunner — CoreSimulatorService 자동 복구', () => {
  let restoreTimeout: () => void

  beforeEach(() => {
    execFileMock.mockReset()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      queueMicrotask(fn as () => void)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    restoreTimeout = () => spy.mockRestore()
  })

  afterEach(() => restoreTimeout())

  it('버전 불일치 에러 발생 시 killall 후 재시도하여 성공한다', async () => {
    let simctlCallCount = 0
    execFileMock.mockImplementation((cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      if (cmd === 'killall') {
        cb(null, { stdout: '' })
      } else {
        simctlCallCount++
        if (simctlCallCount === 1) {
          cb(VERSION_MISMATCH_ERR)
        } else {
          cb(null, { stdout: 'ok' })
        }
      }
      return { on: vi.fn() }
    })

    const result = await defaultRunner.exec('list', 'devices')
    expect(result).toBe('ok')
    expect(execFileMock.mock.calls.some((c: unknown[]) => (c as [string])[0] === 'killall')).toBe(true)
  })

  it('버전 불일치가 아닌 에러는 즉시 throw한다', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null) => void
      cb(new Error('some other error'))
      return { on: vi.fn() }
    })
    await expect(defaultRunner.exec('list')).rejects.toThrow('some other error')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('재시도에도 실패하면 에러를 throw한다', async () => {
    execFileMock.mockImplementation((cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      if (cmd === 'killall') {
        cb(null, { stdout: '' })
      } else {
        cb(VERSION_MISMATCH_ERR)
      }
      return { on: vi.fn() }
    })

    await expect(defaultRunner.exec('list')).rejects.toThrow()
    const simctlCalls = execFileMock.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] !== 'killall'
    )
    expect(simctlCalls).toHaveLength(2)
  })
})
