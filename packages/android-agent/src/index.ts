import { execSync } from 'node:child_process'
import { AgentRegistry } from '@tapflowio/agent-core'
import type { AgentConnectOpts } from '@tapflowio/agent-core'
import { AndroidAgent } from './AndroidAgent.js'

export { AndroidAgent } from './AndroidAgent.js'
export type { AndroidAgentOptions } from './AndroidAgent.js'
export { AdbWrapper } from './AdbWrapper.js'
export { EmulatorLauncher } from './EmulatorLauncher.js'
export { AndroidTouchHelper } from './AndroidTouchHelper.js'
export { ScrcpySession } from './scrcpy/ScrcpySession.js'
export { ScrcpyControl } from './scrcpy/ScrcpyControl.js'
export { ScrcpyVideo } from './scrcpy/ScrcpyVideo.js'

function hasAdb(): boolean {
  try {
    return execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim().length > 0
  } catch {
    return false
  }
}

AgentRegistry.register('android', AndroidAgent, {
  canRun: hasAdb,
  connect: async (relayUrl: string, opts?: AgentConnectOpts) => {
    const agent = new AndroidAgent({ deviceFilter: opts?.deviceFilter, token: opts?.token })
    await agent.connect(relayUrl)
    return agent
  },
})
