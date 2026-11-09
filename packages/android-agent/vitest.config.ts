import { mergeConfig, defineConfig } from 'vitest/config'
import { sourceFirst } from '../../vitest.shared'

// `sourceFirst`: this package's tests import a sibling, and must see its source rather than the
// last thing built of it. See vitest.shared.ts.
export default mergeConfig(sourceFirst, defineConfig({
  test: {
    env: {
      // These tests stand up a real relay and a real agent, and the agent reports the resources of the machine the
      // suite runs on. Over 80 %, by CPU or memory, the relay refuses `session:start` as `agent-resources-exhausted`,
      // so a reconnect test failed whenever the machine running it was busy, CI runners included. Usage never exceeds
      // 100, so this turns that refusal off here, where nothing tests it; the relay's and flow-runner's suites test it
      // with reports they make up. Still read from the real Mac: the kernel's memory pressure, which holds a cold boot
      // only at `critical` (`host-memory-critical`), and is never reported off macOS.
      TAPFLOW_RESOURCE_THRESHOLD_PERCENT: '100',
    },
  },
}))
