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
    expect(() => AgentRegistry.get('unknown')).toThrow(PlatformError)
    expect(() => AgentRegistry.get('unknown')).toThrow('No agent registered for platform: unknown')
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
})
