import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('@tapflowio/relay', () => ({
  RelayServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
  initDb: vi.fn(),
  config: { server: { dataDir: '/tmp/tapflow-test' } },
}))
vi.mock('@tapflowio/ios-agent', () => ({
  IOSAgent: vi.fn().mockImplementation(() => ({
    listDevices: vi.fn().mockResolvedValue([
      { id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' },
    ]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}))
vi.mock('@tapflowio/android-agent', () => ({
  AndroidAgent: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}))

import { execSync } from 'node:child_process'
import { RelayServer, initDb } from '@tapflowio/relay'
import { IOSAgent } from '@tapflowio/ios-agent'
import { AndroidAgent } from '@tapflowio/android-agent'
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

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(() => {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
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

  it('비-Mac + adb 없음 → 릴레이 기동 후 relay-only 모드 (exit 없음)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await cmdStart({})

    expect(RelayServer).toHaveBeenCalled()
    expect(IOSAgent).not.toHaveBeenCalled()
    expect(AndroidAgent).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

})
