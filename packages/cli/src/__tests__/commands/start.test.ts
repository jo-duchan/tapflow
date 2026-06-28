import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('@tapflowio/relay', () => ({
  RelayServer: vi.fn().mockImplementation(function () { return ({
    start: vi.fn().mockResolvedValue(undefined),
  }) }),
  initDb: vi.fn(),
  loadedEnvPath: null,
  createCertProvider: vi.fn(),
  startTlsBackgroundTasks: vi.fn(() => () => {}),
  buildCorsOrigins: vi.fn(() => []),
  proxyWithoutPublicUrlWarning: vi.fn(() => null),

  config: { local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576 }, relay: { url: null }, tunnel: null, tls: undefined },
}))
vi.mock('@tapflowio/ios-agent', () => ({ requestAudioPermission: vi.fn(), isAudioSupported: vi.fn(() => true) }))
vi.mock('@tapflowio/android-agent', () => ({}))

const mockTunnel = { stop: vi.fn() }
vi.mock('../../lib/tunnel-runner.js', () => ({
  startConfiguredTunnel: vi.fn(),
}))

import { execSync } from 'node:child_process'
import { RelayServer, initDb, config } from '@tapflowio/relay'
import { AgentRegistry } from '@tapflowio/agent-core'
import { startConfiguredTunnel } from '../../lib/tunnel-runner.js'
import { cmdStart } from '../../commands/start.js'

const mockExecSync = vi.mocked(execSync)

function testHasAdb(): boolean {
  try {
    return String(mockExecSync('which adb', { encoding: 'utf8', stdio: 'pipe' })).trim().length > 0
  } catch {
    return false
  }
}

class DummyAgent {}

describe('cmdStart', () => {
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

    vi.mocked(RelayServer).mockImplementation(function () { return ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never) })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })

    vi.mocked(config).tunnel = null
    vi.mocked(startConfiguredTunnel).mockResolvedValue({ tunnel: mockTunnel as never, publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
  })

  afterEach(() => {
    AgentRegistry.clear()
    vi.restoreAllMocks()
  })

  it('relay URL 없으면 RelayServer를 포트 4000으로 기동', async () => {
    await cmdStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(function () {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
  })

  it('macOS + adb 있으면 iOS와 Android 모두 연결', async () => {
    await cmdStart({})
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
  })

  it('--platform ios 이면 iOS만 연결', async () => {
    await cmdStart({ platform: 'ios' })
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
  })

  it('--platform android 이면 Android만 연결', async () => {
    await cmdStart({ platform: 'android' })
    expect(iosConnectSpy).not.toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
  })

  it('adb 없으면 iOS만 연결', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    await cmdStart({})
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
  })

  it('--device 로 특정 디바이스 지정', async () => {
    await cmdStart({ platform: 'ios', device: 'iPhone 16 Pro' })
    expect(iosConnectSpy).toHaveBeenCalledWith('ws://localhost:4000', { deviceFilter: 'iPhone 16 Pro' })
  })

  it('존재하지 않는 --device 지정 시 exit(1)', async () => {
    iosConnectSpy.mockRejectedValue(new Error('Device "NonExistent" not found'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdStart({ platform: 'ios', device: 'NonExistent' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('connect 실패 시 exit(1)', async () => {
    iosConnectSpy.mockRejectedValue(new Error('connection refused'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
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
    expect(iosConnectSpy).not.toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('--platform 미등록 플랫폼 → exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdStart({ platform: 'web' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  describe('터널', () => {
    it('config.tunnel 없으면 터널 기동 안 함', async () => {
      await cmdStart({})
      expect(startConfiguredTunnel).not.toHaveBeenCalled()
    })

    it('config.tunnel 있으면 터널 기동 + 공개 URL이 배너에 출력', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      const output: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

      await cmdStart({})

      expect(startConfiguredTunnel).toHaveBeenCalledWith({ provider: 'tailscale' }, 4000)
      expect(output.join('\n')).toContain('my-mac.tailnet.ts.net')
    })

    it('SIGINT 시 에이전트와 터널 모두 종료', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      const onSpy = vi.spyOn(process, 'on')
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      await cmdStart({ platform: 'ios' })

      const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
      const handler = call![1] as () => void
      handler()
      expect(iosDisconnectSpy).toHaveBeenCalled()
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('터널 기동 실패(publicUrl null)면 localhost 배너 유지', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      vi.mocked(startConfiguredTunnel).mockResolvedValue({ tunnel: null, publicUrl: null })
      const output: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

      await cmdStart({ platform: 'ios' })

      expect(output.join('\n')).toContain('localhost:4000')
      expect(output.join('\n')).not.toContain('Public :')
    })
  })
})
