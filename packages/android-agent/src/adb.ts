import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'
import { getAdbPath, getEmulatorPath } from './sdk.js'

const execFileAsync = promisify(execFile)
const logger = createLogger('android-agent:adb')

// `execFile` collects the child's stdout in memory and rejects with "stdout maxBuffer length exceeded"
// once it passes `maxBuffer`, which is 1 MiB unless set. `screencap -p` of a 1080×2424 screen with
// photos on it is larger than that, so every screenshot of such a screen failed inside the agent,
// while a flatter screen of the same size compressed under the limit and went through (#842). 64 MiB
// is what the iOS agent already gives `xcodebuild` in `XCUITreeReader`. `uiautomator dump` runs
// through `exec` and gets the same room: a large accessibility tree is the same failure one call over.
const ADB_MAXBUFFER = 64 * 1024 * 1024

// An empty AVD list is otherwise indistinguishable from an SDK the agent cannot find (#903), so the
// failure is said once rather than on every device poll.
let warnedListAvds = false

export interface AdbRunner {
  exec(...args: string[]): Promise<string>
  /** `exec` with the child killed after `timeoutMs`. Optional so a test double need not have it; a runner without it
   *  is called through `exec`, unbounded. */
  execBounded?(timeoutMs: number, ...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
  listAvds(): Promise<string[]>
}

export const defaultRunner: AdbRunner = {
  async exec(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { maxBuffer: ADB_MAXBUFFER })
    return stdout
  },
  async execBounded(timeoutMs: number, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { maxBuffer: ADB_MAXBUFFER, timeout: timeoutMs })
    return stdout
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { encoding: 'buffer', maxBuffer: ADB_MAXBUFFER })
    return stdout
  },
  async listAvds(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(getEmulatorPath(), ['-list-avds'])
      warnedListAvds = false
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    } catch (err) {
      if (!warnedListAvds) {
        warnedListAvds = true
        logger.warn(`cannot list AVDs, so no Android devices will be reported: ${(err as Error).message}`)
      }
      return []
    }
  },
}
