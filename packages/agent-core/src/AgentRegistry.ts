import type { DeviceAgent, DeviceAgentConstructor } from './DeviceAgent.js'
import { PlatformError } from './errors.js'

const constructors = new Map<string, DeviceAgentConstructor>()
const instances = new Map<string, DeviceAgent>()

export const AgentRegistry = {
  register(platform: string, AgentClass: DeviceAgentConstructor): void {
    constructors.set(platform, AgentClass)
    instances.delete(platform)
  },

  get(platform: string): DeviceAgent {
    if (!constructors.has(platform)) {
      throw new PlatformError(`No agent registered for platform: ${platform}`)
    }
    if (!instances.has(platform)) {
      const AgentClass = constructors.get(platform)!
      instances.set(platform, new AgentClass())
    }
    return instances.get(platform)!
  },

  clear(): void {
    constructors.clear()
    instances.clear()
  },
}
