import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlatformError } from '../index'
import { AgentRegistry } from '../AgentRegistry'
import type { DeviceAgent } from '../DeviceAgent'
import type { Device } from '../types'

class MockAgent implements DeviceAgent {
  listDevices(): Promise<Device[]> { return Promise.resolve([]) }
  boot(_deviceId: string): Promise<void> { return Promise.resolve() }
  shutdown(_deviceId: string): Promise<void> { return Promise.resolve() }
  installApp(_path: string): Promise<void> { return Promise.resolve() }
  launchApp(_bundleId: string): Promise<void> { return Promise.resolve() }
  screenshot(): Promise<Buffer> { return Promise.resolve(Buffer.alloc(0)) }
  stream(): ReadableStream<Buffer> { return new ReadableStream() }
  touchStart(_x: number, _y: number): void {}
  touchMove(_x: number, _y: number): Promise<void> { return Promise.resolve() }
  touchEnd(): Promise<void> { return Promise.resolve() }
}

const mockConnect = async () => ({ disconnect: () => {} })

describe('AgentRegistry', () => {
  beforeEach(() => {
    AgentRegistry.clear()
  })

  it('registers and retrieves an agent instance', () => {
    AgentRegistry.register('mock', MockAgent)
    const agent = AgentRegistry.get('mock')
    expect(agent).toBeInstanceOf(MockAgent)
  })

  it('returns the same instance on repeated get calls', () => {
    AgentRegistry.register('mock', MockAgent)
    const a = AgentRegistry.get('mock')
    const b = AgentRegistry.get('mock')
    expect(a).toBe(b)
  })

  it('throws when platform is not registered', () => {
    let thrown: unknown

    try {
      AgentRegistry.get('unknown')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(PlatformError)
    expect((thrown as Error).message).toBe('No agent registered for platform: unknown')
  })


  it('resets cached instance when re-registering', () => {
    AgentRegistry.register('mock', MockAgent)
    const a = AgentRegistry.get('mock')
    AgentRegistry.register('mock', MockAgent)
    const b = AgentRegistry.get('mock')
    expect(a).not.toBe(b)
  })

  it('handles multiple platforms independently', () => {
    class AnotherMock extends MockAgent {}
    AgentRegistry.register('mock', MockAgent)
    AgentRegistry.register('another', AnotherMock)
    expect(AgentRegistry.get('mock')).toBeInstanceOf(MockAgent)
    expect(AgentRegistry.get('another')).toBeInstanceOf(AnotherMock)
  })

  describe('platforms()', () => {
    it('returns empty array when nothing is registered', () => {
      expect(AgentRegistry.platforms()).toEqual([])
    })

    it('returns all registered platform keys', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent)
      AgentRegistry.register('android', AnotherMock)
      expect(AgentRegistry.platforms()).toEqual(expect.arrayContaining(['ios', 'android']))
      expect(AgentRegistry.platforms()).toHaveLength(2)
    })

    it('reflects re-registration without duplicates', () => {
      AgentRegistry.register('ios', MockAgent)
      AgentRegistry.register('ios', MockAgent)
      expect(AgentRegistry.platforms()).toHaveLength(1)
    })
  })

  describe('available()', () => {
    it('returns platforms that have a connect hook and no canRun', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { connect: mockConnect })
      AgentRegistry.register('android', AnotherMock, { connect: mockConnect })
      expect(AgentRegistry.available()).toEqual(expect.arrayContaining(['ios', 'android']))
    })

    it('excludes platforms without a connect hook', () => {
      AgentRegistry.register('ios', MockAgent)
      expect(AgentRegistry.available()).not.toContain('ios')
    })

    it('returns platform when canRun returns true', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => true, connect: mockConnect })
      expect(AgentRegistry.available()).toContain('ios')
    })

    it('excludes platform when canRun returns false', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false, connect: mockConnect })
      expect(AgentRegistry.available()).not.toContain('ios')
    })

    it('returns empty array when all canRun return false', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { canRun: () => false, connect: mockConnect })
      AgentRegistry.register('android', AnotherMock, { canRun: () => false, connect: mockConnect })
      expect(AgentRegistry.available()).toHaveLength(0)
    })

    it('mixes: includes only platforms where canRun returns true', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { canRun: () => true, connect: mockConnect })
      AgentRegistry.register('android', AnotherMock, { canRun: () => false, connect: mockConnect })
      expect(AgentRegistry.available()).toEqual(['ios'])
    })

    it('canRun does not affect get()', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false, connect: mockConnect })
      expect(AgentRegistry.get('ios')).toBeInstanceOf(MockAgent)
    })

    it('re-register without opts clears previous canRun', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false, connect: mockConnect })
      AgentRegistry.register('ios', MockAgent)
      expect(AgentRegistry.available()).not.toContain('ios')
    })

    it('re-register with new canRun replaces old one', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false, connect: mockConnect })
      AgentRegistry.register('ios', MockAgent, { canRun: () => true, connect: mockConnect })
      expect(AgentRegistry.available()).toContain('ios')
    })

    it('skips platforms whose canRun throws', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { canRun: () => { throw new Error('boom') }, connect: mockConnect })
      AgentRegistry.register('android', AnotherMock, { canRun: () => true, connect: mockConnect })
      expect(AgentRegistry.available()).toEqual(['android'])
    })
  })

  describe('connect()', () => {
    it('calls registered connect hook with relayUrl and opts', async () => {
      const connectSpy = vi.fn().mockResolvedValue({ disconnect: vi.fn() })
      AgentRegistry.register('ios', MockAgent, { connect: connectSpy })
      await AgentRegistry.connect('ios', 'ws://localhost:4000', { deviceFilter: 'test' })
      expect(connectSpy).toHaveBeenCalledWith('ws://localhost:4000', { deviceFilter: 'test' })
    })

    it('throws PlatformError when no connect hook is registered', async () => {
      AgentRegistry.register('ios', MockAgent)
      await expect(AgentRegistry.connect('ios', 'ws://localhost:4000')).rejects.toThrow(PlatformError)
    })

    it('throws PlatformError when platform is not registered', async () => {
      await expect(AgentRegistry.connect('unknown', 'ws://localhost:4000')).rejects.toThrow(PlatformError)
    })

    it('returns agent with disconnect method', async () => {
      const disconnectSpy = vi.fn()
      AgentRegistry.register('ios', MockAgent, {
        connect: async () => ({ disconnect: disconnectSpy }),
      })
      const agent = await AgentRegistry.connect('ios', 'ws://localhost:4000')
      agent.disconnect()
      expect(disconnectSpy).toHaveBeenCalled()
    })
  })
})
