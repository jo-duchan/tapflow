import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('@tapflow/relay', () => ({
  RelayServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
}))
vi.mock('@tapflow/ios-agent', () => ({
  IOSAgent: vi.fn().mockImplementation(() => ({
    listDevices: vi.fn().mockResolvedValue([
      { id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' },
    ]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}))
vi.mock('@tapflow/android-agent', () => ({
  AndroidAgent: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}))

import { execSync } from 'node:child_process'
import { RelayServer } from '@tapflow/relay'
import { IOSAgent } from '@tapflow/ios-agent'
import { AndroidAgent } from '@tapflow/android-agent'
import { cmdStart } from '../../commands/start.js'

const mockExecSync = vi.mocked(execSync)

describe('cmdStart', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // resetAllMocks 후 class mock 구현 재설정
    vi.mocked(RelayServer).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never))
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([
        { id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' },
      ]),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    } as never))
    vi.mocked(AndroidAgent).mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    } as never))

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    // 기본: adb 있음
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('relay URL 없으면 RelayServer를 포트 4000으로 기동', async () => {
    await cmdStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('--relay 있으면 RelayServer 기동 안 함', async () => {
    await cmdStart({ relay: 'ws://remote:4000' })
    expect(RelayServer).not.toHaveBeenCalled()
  })

  it('macOS + adb 있으면 iOS와 Android 모두 연결', async () => {
    await cmdStart({})
    expect(IOSAgent).toHaveBeenCalled()
    expect(AndroidAgent).toHaveBeenCalled()
  })

  it('--platform ios 이면 iOS만 연결', async () => {
    await cmdStart({ platform: 'ios' })
    expect(IOSAgent).toHaveBeenCalled()
    expect(AndroidAgent).not.toHaveBeenCalled()
  })

  it('--platform android 이면 Android만 연결', async () => {
    await cmdStart({ platform: 'android' })
    expect(IOSAgent).not.toHaveBeenCalled()
    expect(AndroidAgent).toHaveBeenCalled()
  })

  it('adb 없으면 iOS만 연결', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    await cmdStart({})
    expect(IOSAgent).toHaveBeenCalled()
    expect(AndroidAgent).not.toHaveBeenCalled()
  })

  it('--device 로 특정 시뮬레이터 지정', async () => {
    const mockListDevices = vi.fn().mockResolvedValue([
      { id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' },
    ])
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: mockListDevices,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    } as never))

    await cmdStart({ platform: 'ios', device: 'iPhone 16 Pro' })
    expect(mockListDevices).toHaveBeenCalled()
  })

  it('존재하지 않는 --device 지정 시 exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdStart({ platform: 'ios', device: 'NonExistent' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('connect 실패 시 exit(1)', async () => {
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([{ id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' }]),
      connect: vi.fn().mockRejectedValue(new Error('connection refused')),
      disconnect: vi.fn(),
    } as never))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
