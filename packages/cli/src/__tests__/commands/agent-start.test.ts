import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('@tapflowio/ios-agent', () => ({ requestAudioPermission: vi.fn(), isAudioSupported: vi.fn(() => true) }))
vi.mock('@tapflowio/android-agent', () => ({}))

import { execSync } from 'node:child_process'
import { AgentRegistry } from '@tapflowio/agent-core'
import { cmdAgentStart } from '../../commands/agent-start.js'

const mockExecSync = vi.mocked(execSync)

function testHasAdb(): boolean {
  try {
    return String(mockExecSync('which adb', { encoding: 'utf8', stdio: 'pipe' })).trim().length > 0
  } catch {
    return false
  }
}

class DummyAgent {}

describe('cmdAgentStart', () => {
  let iosConnectSpy: ReturnType<typeof vi.fn>
  let androidConnectSpy: ReturnType<typeof vi.fn>
  let iosDisconnectSpy: ReturnType<typeof vi.fn>
  let androidDisconnectSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    AgentRegistry.clear()

    iosDisconnectSpy = vi.fn()
    androidDisconnectSpy = vi.fn()
    iosConnectSpy = vi.fn().mockResolvedValue({ disconnect: iosDisconnectSpy })
    androidConnectSpy = vi.fn().mockResolvedValue({ disconnect: androidDisconnectSpy })

    AgentRegistry.register('ios', DummyAgent as never, {
      canRun: () => process.platform === 'darwin',
      connect: iosConnectSpy,
    })
    AgentRegistry.register('android', DummyAgent as never, {
      canRun: testHasAdb,
      connect: androidConnectSpy,
    })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })
  })

  afterEach(() => {
    AgentRegistry.clear()
    vi.restoreAllMocks()
  })

  it('--relay 없으면 ws://localhost:4000 으로 연결', async () => {
    await cmdAgentStart({ platform: 'ios' })
    expect(iosConnectSpy).toHaveBeenCalledWith('ws://localhost:4000', expect.anything())
  })

  it('macOS + adb → iOS, Android 모두 연결', async () => {
    await cmdAgentStart({})
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
  })

  // #271 — 원격 릴레이 인증 토큰 전달
  describe('--token / TAPFLOW_AGENT_TOKEN', () => {
    const ORIG_ENV = process.env.TAPFLOW_AGENT_TOKEN

    afterEach(() => {
      if (ORIG_ENV === undefined) delete process.env.TAPFLOW_AGENT_TOKEN
      else process.env.TAPFLOW_AGENT_TOKEN = ORIG_ENV
    })

    it('--token이 connect opts로 전달된다', async () => {
      delete process.env.TAPFLOW_AGENT_TOKEN
      await cmdAgentStart({ platform: 'ios', token: 'tflw_pat_flag' })
      expect(iosConnectSpy).toHaveBeenCalledWith(
        'ws://localhost:4000',
        expect.objectContaining({ token: 'tflw_pat_flag' }),
      )
    })

    it('플래그가 없으면 TAPFLOW_AGENT_TOKEN 환경변수를 쓴다', async () => {
      process.env.TAPFLOW_AGENT_TOKEN = 'tflw_pat_env'
      await cmdAgentStart({ platform: 'ios' })
      expect(iosConnectSpy).toHaveBeenCalledWith(
        'ws://localhost:4000',
        expect.objectContaining({ token: 'tflw_pat_env' }),
      )
    })

    it('플래그가 환경변수보다 우선한다', async () => {
      process.env.TAPFLOW_AGENT_TOKEN = 'tflw_pat_env'
      await cmdAgentStart({ platform: 'ios', token: 'tflw_pat_flag' })
      expect(iosConnectSpy).toHaveBeenCalledWith(
        'ws://localhost:4000',
        expect.objectContaining({ token: 'tflw_pat_flag' }),
      )
    })

    it('둘 다 없으면 token이 undefined (localhost 무인증 경로)', async () => {
      delete process.env.TAPFLOW_AGENT_TOKEN
      await cmdAgentStart({ platform: 'ios' })
      expect(iosConnectSpy).toHaveBeenCalledWith(
        'ws://localhost:4000',
        expect.objectContaining({ token: undefined }),
      )
    })
  })

  it('--platform ios → iOS만 연결', async () => {
    await cmdAgentStart({ platform: 'ios' })
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
  })

  it('--platform android → Android만 연결', async () => {
    await cmdAgentStart({ platform: 'android' })
    expect(iosConnectSpy).not.toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
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
    iosConnectSpy.mockRejectedValue(new Error('connection refused'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // #271 — 릴레이의 1008 인증 거절은 토큰 발급 안내와 함께 표시한다
  it('1008 인증 거절 → 배너에 --token 발급 안내 포함', async () => {
    iosConnectSpy.mockRejectedValue(
      new Error('relay closed the connection during handshake (code=1008: Unauthorized: agents need a PAT)'),
    )
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('--token')
    expect(output).toContain('Tokens')
  })

  it('1008이 아닌 실패에는 토큰 안내를 붙이지 않는다', async () => {
    iosConnectSpy.mockRejectedValue(new Error('connection refused'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).not.toContain('--token')
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
    await cmdAgentStart({ platform: 'ios', relay: 'wss://relay.example.com' })
    expect(iosConnectSpy).toHaveBeenCalledWith('wss://relay.example.com', expect.anything())
  })

  it('SIGINT → 모든 에이전트 disconnect', async () => {
    let sigintHandler: (() => void) | undefined
    vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') sigintHandler = handler as () => void
      return process
    })
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await cmdAgentStart({ platform: 'ios' })
    expect(() => sigintHandler?.()).toThrow('process.exit')
    expect(iosDisconnectSpy).toHaveBeenCalled()
  })

  it('--platform 미등록 플랫폼 → exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'web' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
