import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TAPFLOW_DIR = join(homedir(), '.tapflow')
export const WDA_DIR = join(TAPFLOW_DIR, 'wda')
export const WDA_SOURCE_DIR = join(WDA_DIR, 'source')
export const WDA_BUILD_DIR = join(WDA_DIR, 'build')
export const WDA_XCTESTRUN_CACHE = join(WDA_DIR, 'WebDriverAgent.xctestrun')
export const WDA_PID_FILE = join(TAPFLOW_DIR, 'wda.pid')

export function ensureTapflowDir(): void {
  mkdirSync(WDA_DIR, { recursive: true })
}
