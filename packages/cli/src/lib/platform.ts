import { execSync } from 'node:child_process'

export function hasAdb(): boolean {
  try {
    return execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim().length > 0
  } catch {
    return false
  }
}
