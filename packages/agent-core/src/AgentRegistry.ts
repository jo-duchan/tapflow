import type { DeviceAgent, DeviceAgentConstructor } from './DeviceAgent.js'
import { PlatformError } from './errors.js'

export interface AgentConnectOpts {
  deviceFilter?: string
}

interface AgentRegistryOpts {
  canRun?: () => boolean
  connect?: (relayUrl: string, opts?: AgentConnectOpts) => Promise<{ disconnect(): void }>
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

  async connect(platform: string, relayUrl: string, opts?: AgentConnectOpts): Promise<{ disconnect(): void }> {
    const hook = registryOpts.get(platform)?.connect
    if (!hook) {
      throw new PlatformError(`No connect handler registered for platform: ${platform}`)
    }
    return hook(relayUrl, opts)
  },

  platforms(): string[] {
    return [...constructors.keys()]
  },

  available(): string[] {
    return [...constructors.keys()].filter((p) => {
      const opts = registryOpts.get(p)
      if (!opts?.connect) return false
      if (!opts.canRun) return true
      try {
        return opts.canRun()
      } catch {
        return false
      }
    })
  },

  clear(): void {
    constructors.clear()
    instances.clear()
    registryOpts.clear()
  },
}
