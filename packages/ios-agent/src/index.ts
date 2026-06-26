import { AgentRegistry } from '@tapflowio/agent-core'
import type { AgentConnectOpts } from '@tapflowio/agent-core'
import { IOSAgent } from './IOSAgent.js'

export { IOSAgent } from './IOSAgent.js'
export type { IOSAgentOptions } from './IOSAgent.js'
export { SimctlWrapper } from './SimctlWrapper.js'
export { MjpegStreamer } from './MjpegStreamer.js'
export { KEY_CODE_MAP, MODIFIER_BITS } from './KeyCodeMap.js'
// Audio-capture TCC priming for `tapflow setup ios` (grant up front, not at first boot).
export { requestAudioPermission, isAudioSupported } from './AudioCaptureStreamer.js'

AgentRegistry.register('ios', IOSAgent, {
  canRun: () => process.platform === 'darwin',
  connect: async (relayUrl: string, opts?: AgentConnectOpts) => {
    // No pre-boot: connect registers devices only. Booting happens on demand via
    // device:boot (dashboard / MCP). deviceFilter narrows which devices are exposed
    // (Android parity — see AndroidAgent).
    const agent = new IOSAgent({ deviceFilter: opts?.deviceFilter, token: opts?.token })
    await agent.connect(relayUrl)
    return agent
  },
})
