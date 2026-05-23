import { describe, it, expect, beforeEach } from 'vitest'
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
    it('returns all platforms when no canRun is provided', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent)
      AgentRegistry.register('android', AnotherMock)
      expect(AgentRegistry.available()).toEqual(expect.arrayContaining(['ios', 'android']))
    })

    it('returns platform when canRun returns true', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => true })
      expect(AgentRegistry.available()).toContain('ios')
    })

    it('excludes platform when canRun returns false', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false })
      expect(AgentRegistry.available()).not.toContain('ios')
    })

    it('returns empty array when all canRun return false', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { canRun: () => false })
      AgentRegistry.register('android', AnotherMock, { canRun: () => false })
      expect(AgentRegistry.available()).toHaveLength(0)
    })

    it('mixes: includes only platforms where canRun returns true', () => {
      class AnotherMock extends MockAgent {}
      AgentRegistry.register('ios', MockAgent, { canRun: () => true })
      AgentRegistry.register('android', AnotherMock, { canRun: () => false })
      expect(AgentRegistry.available()).toEqual(['ios'])
    })

    it('canRun does not affect get()', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false })
      expect(AgentRegistry.get('ios')).toBeInstanceOf(MockAgent)
    })

    it('re-register without opts clears previous canRun', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false })
      AgentRegistry.register('ios', MockAgent)
      expect(AgentRegistry.available()).toContain('ios')
    })

    it('re-register with new canRun replaces old one', () => {
      AgentRegistry.register('ios', MockAgent, { canRun: () => false })
      AgentRegistry.register('ios', MockAgent, { canRun: () => true })
      expect(AgentRegistry.available()).toContain('ios')
    })
  })
})
