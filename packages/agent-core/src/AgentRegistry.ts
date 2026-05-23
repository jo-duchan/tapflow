import type { DeviceAgent, DeviceAgentConstructor } from './DeviceAgent.js'
import { PlatformError } from './errors.js'

interface AgentRegistryOpts {
  canRun?: () => boolean
}

const constructors = new Map<string, DeviceAgentConstructor>()
const instances = new Map<string, DeviceAgent>()
const registryOpts = new Map<string, AgentRegistryOpts>()

export const AgentRegistry = {
  register(platform: string, AgentClass: DeviceAgentConstructor, opts?: AgentRegistryOpts): void {
    constructors.set(platform, AgentClass)
    instances.delete(platform)
    if (opts) {
      registryOpts.set(platform, opts)
    } else {
      registryOpts.delete(platform)
    }
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

  platforms(): string[] {
    return [...constructors.keys()]
  },

  available(): string[] {
    return [...constructors.keys()].filter((p) => {
      const opts = registryOpts.get(p)
      return !opts?.canRun || opts.canRun()
    })
  },

  clear(): void {
    constructors.clear()
    instances.clear()
    registryOpts.clear()
  },
}
