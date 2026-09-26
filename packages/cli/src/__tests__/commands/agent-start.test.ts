import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type { AgentConnectOpts } from '@tapflowio/agent-core'

vi.mock('node:child_process')
vi.mock('@tapflowio/ios-agent', () => ({ requestAudioPermission: vi.fn(), isAudioSupported: vi.fn(() => true) }))
vi.mock('@tapflowio/android-agent', () => ({}))
// The singleton claim is a real socket held for the life of the process, so one claim inside a vitest
// worker would refuse every later test in the file. These tests are about connecting and about the
// token; `agentSingleton.test.ts` is what exercises the claim itself, against a real temp directory.
vi.mock('../../lib/agent-singleton.js', () => ({
  claimAgentSlot: vi.fn(async () => ({ held: true, release: () => {} })),
  claimPath: vi.fn((p: string) => `/tmp/tapflow-agent-${p}.sock`),
}))

import { execSync } from 'node:child_process'
import { AgentRegistry } from '@tapflowio/agent-core'
import { cmdAgentStart } from '../../commands/agent-start.js'
import { claimAgentSlot } from '../../lib/agent-singleton.js'

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
  type ConnectHook = (relayUrl: string, opts?: AgentConnectOpts) => Promise<{ disconnect(): void }>
  let iosConnectSpy: Mock<ConnectHook>
  let androidConnectSpy: Mock<ConnectHook>
  let iosDisconnectSpy: Mock<() => void>
  let androidDisconnectSpy: Mock<() => void>

  beforeEach(() => {
    vi.resetAllMocks()
    AgentRegistry.clear()

    iosDisconnectSpy = vi.fn<() => void>()
    androidDisconnectSpy = vi.fn<() => void>()
    iosConnectSpy = vi.fn<ConnectHook>().mockResolvedValue({ disconnect: iosDisconnectSpy })
    androidConnectSpy = vi.fn<ConnectHook>().mockResolvedValue({ disconnect: androidDisconnectSpy })

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

  // The singleton wiring sat behind a mock and had no coverage at all: deleting the whole claim loop
  // left the suite green. These pin the refusal, its exit code, and the two ways a claim has to go
  // back — a later platform refusing, and a platform that claimed and then failed to connect.
  it('refuses and exits when an agent for that platform is already running', async () => {
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    vi.mocked(claimAgentSlot).mockResolvedValueOnce({ held: false, reason: 'in-use' })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    // A refusal must not connect: a second agent registering is what evicts the first one's socket
    // at the relay, which is the thing being prevented.
    expect(iosConnectSpy, 'it refused and connected anyway').not.toHaveBeenCalled()
  })

  it('gives back an earlier claim when a later platform is refused', async () => {
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    AgentRegistry.register('android', DummyAgent as never, { canRun: () => true, connect: androidConnectSpy })
    const release = vi.fn()
    vi.mocked(claimAgentSlot)
      .mockResolvedValueOnce({ held: true, release })
      .mockResolvedValueOnce({ held: false, reason: 'in-use' })
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdAgentStart({})).rejects.toThrow('process.exit')
    expect(release, 'it exited still holding the slot it took first').toHaveBeenCalledTimes(1)
  })

  it('does not say an agent is running when the probe found none', async () => {
    // A stale claim means the liveness probe got no answer — so "already running" is false, and it is
    // false in the case that is hardest to diagnose: there is no process to go and find.
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    vi.mocked(claimAgentSlot).mockResolvedValueOnce({ held: false, reason: 'stale-claim' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    const printed = log.mock.calls.flat().join('\n')
    expect(printed, 'the running-agent banner is false here').not.toContain('AGENT ALREADY RUNNING')
    expect(printed).toContain('CLAIM LEFT BY ANOTHER ACCOUNT')
    expect(printed, 'the remediation has to name the file to remove').toContain('/tmp/tapflow-agent-ios.sock')
  })

  it('gives the claim back when the platform it was taken for fails to connect', async () => {
    // With another platform already connected the failure is a warning and this process runs on — so
    // a claim held for an agent that does not exist would refuse the next `agent start` for it.
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    AgentRegistry.register('android', DummyAgent as never, { canRun: () => true, connect: androidConnectSpy })
    androidConnectSpy.mockRejectedValue(new Error('adb went away'))
    const iosRelease = vi.fn()
    const androidRelease = vi.fn()
    vi.mocked(claimAgentSlot)
      .mockResolvedValueOnce({ held: true, release: iosRelease })
      .mockResolvedValueOnce({ held: true, release: androidRelease })

    await cmdAgentStart({})

    expect(androidRelease, 'the failed platform kept its slot').toHaveBeenCalledTimes(1)
    expect(iosRelease, 'the connected platform lost its slot').not.toHaveBeenCalled()
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

  // The relay's own reason is the instruction here; the generic "create an agent-scope PAT" hint would
  // point at the wrong fix. Mutation: the hint keyed on `code=1008` alone again turns this red.
  it("a demoted owner's 1008 prints the relay's reason and not the agent-scope hint", async () => {
    const reason = "Unauthorized: this agent token's owner is no longer an Admin; an Admin must issue a new agent token"
    iosConnectSpy.mockRejectedValue(new Error(`relay closed the connection during handshake (code=1008: ${reason})`))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('no longer an Admin')
    expect(output).not.toContain('Remote relays require a PAT with the agent scope')
  })

  // Every other 1008 keeps the hint. Mutation: narrowing the hint back to one reason (the regex this
  // replaced) turns the `Forbidden` and scope rows red.
  it.each([
    'relay closed the connection during handshake (code=1008)',
    'relay closed the connection during handshake (code=1008: Forbidden)',
    "relay closed the connection during handshake (code=1008: Forbidden: this token lacks the 'view' scope needed for device sessions; create an API-type token)",
  ])('%s → token hint', async (text) => {
    iosConnectSpy.mockRejectedValue(new Error(text))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdAgentStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Remote relays require a PAT with the agent scope')
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
