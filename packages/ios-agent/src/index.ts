import { AgentRegistry } from '@tapflowio/agent-core'
import { IOSAgent } from './IOSAgent.js'

export { IOSAgent } from './IOSAgent.js'
export type { IOSAgentOptions } from './IOSAgent.js'
export { SimctlWrapper } from './SimctlWrapper.js'
export { MjpegStreamer } from './MjpegStreamer.js'
export { KEY_CODE_MAP, MODIFIER_BITS } from './KeyCodeMap.js'

AgentRegistry.register('ios', IOSAgent, { canRun: () => process.platform === 'darwin' })
