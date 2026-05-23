import { AgentRegistry } from '@tapflowio/agent-core'
import type { AgentConnectOpts } from '@tapflowio/agent-core'
import { IOSAgent } from './IOSAgent.js'

export { IOSAgent } from './IOSAgent.js'
export type { IOSAgentOptions } from './IOSAgent.js'
export { SimctlWrapper } from './SimctlWrapper.js'
export { MjpegStreamer } from './MjpegStreamer.js'
export { KEY_CODE_MAP, MODIFIER_BITS } from './KeyCodeMap.js'

AgentRegistry.register('ios', IOSAgent, {
  canRun: () => process.platform === 'darwin',
  connect: async (relayUrl: string, opts?: AgentConnectOpts) => {
    const agent = new IOSAgent()
    const devices = await agent.listDevices()
    const deviceFilter = opts?.deviceFilter

    let target: (typeof devices)[number] | undefined
    if (deviceFilter) {
      target = devices.find((d) => d.name === deviceFilter || d.id === deviceFilter)
      if (!target) {
        throw new Error(`Device "${deviceFilter}" not found. Run \`tapflow devices\` to see available simulators.`)
      }
    } else {
      target = devices.find((d) => d.status === 'booted') ?? devices[0]
      if (!target) {
        throw new Error('No simulator found. Create one in Xcode → Window → Devices and Simulators.')
      }
    }

    if (target.status !== 'booted') {
      await agent.boot(target.id)
    }

    await agent.connect(relayUrl)
    return agent
  },
})
