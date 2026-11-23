import { execSync } from 'node:child_process'
import { findOnPath } from '@tapflowio/agent-core/utils'

/**
 * Throw unless `name` resolves on PATH — the probe `devices`, `reset` and `boot` run before calling a
 * tool by name.
 *
 * macOS and Linux keep the `which` probe they always ran. Windows has no `which` (#1100), so there
 * the lookup is agent-core's `findOnPath`, which honours `PATHEXT` the way `cmd.exe` resolves the
 * bare `adb` / `emulator` these commands go on to run.
 */
export function requireOnPath(name: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    if (findOnPath(name, { platform }) === null) throw new Error(`${name} not found on PATH`)
    return
  }
  execSync(`which ${name}`, { stdio: 'pipe' })
}
