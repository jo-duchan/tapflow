import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
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
import { IOSAgent } from '@tapflowio/ios-agent'
import { AndroidAgent } from '@tapflowio/android-agent'
import { cmdAgentStart } from '../../commands/agent-start.js'

const mockExecSync = vi.mocked(execSync)

describe('cmdAgentStart', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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

    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('--relay 없으면 ws://localhost:4000 으로 연결', async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([{ id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' }]),
      connect: connectSpy,
      disconnect: vi.fn(),
    } as never))

    await cmdAgentStart({ platform: 'ios' })
    expect(connectSpy).toHaveBeenCalledWith('ws://localhost:4000')
  })

  it('macOS + adb → iOS, Android 모두 연결', async () => {
    await cmdAgentStart({})
    expect(IOSAgent).toHaveBeenCalled()
    expect(AndroidAgent).toHaveBeenCalled()
  })

  it('--platform ios → iOS만 연결', async () => {
    await cmdAgentStart({ platform: 'ios' })
    expect(IOSAgent).toHaveBeenCalled()
    expect(AndroidAgent).not.toHaveBeenCalled()
  })

  it('--platform android → Android만 연결', async () => {
    await cmdAgentStart({ platform: 'android' })
    expect(IOSAgent).not.toHaveBeenCalled()
    expect(AndroidAgent).toHaveBeenCalled()
  })

  it('비-Mac + adb 없음 → exit(1)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdAgentStart({})).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('connect 실패 → exit(1)', async () => {
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([{ id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' }]),
      connect: vi.fn().mockRejectedValue(new Error('connection refused')),
      disconnect: vi.fn(),
    } as never))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('--relay http:// 스킴 → exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios', relay: 'http://localhost:4000' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('--relay ftp:// 스킴 → exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios', relay: 'ftp://localhost:4000' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('--relay wss:// 스킴 → 정상 연결', async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([{ id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' }]),
      connect: connectSpy,
      disconnect: vi.fn(),
    } as never))

    await cmdAgentStart({ platform: 'ios', relay: 'wss://relay.example.com' })
    expect(connectSpy).toHaveBeenCalledWith('wss://relay.example.com')
  })

  it('SIGINT → 모든 에이전트 disconnect', async () => {
    const disconnectSpy = vi.fn()
    vi.mocked(IOSAgent).mockImplementation(() => ({
      listDevices: vi.fn().mockResolvedValue([{ id: 'AAA', name: 'iPhone 16 Pro', status: 'booted' }]),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: disconnectSpy,
    } as never))

    let sigintHandler: (() => void) | undefined
    vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') sigintHandler = handler as () => void
      return process
    })
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await cmdAgentStart({ platform: 'ios' })
    expect(() => sigintHandler?.()).toThrow('process.exit')
    expect(disconnectSpy).toHaveBeenCalled()
  })
})
