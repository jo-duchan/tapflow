import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

export interface SleepBlocker {
  /** Start holding the power assertion (idempotent). No-op off macOS. */
  acquire(): void
  /** Release the assertion. Safe to call when not held. */
  release(): void
}

/**
 * macOS-only host power assertion via `caffeinate -i`, so the system doesn't
 * idle-throttle (or sleep) the simulator/emulator while a session is active —
 * the emulator's software H.264 encoder starves badly when the host idles
 * (unattended/backgrounded Mac). Off macOS this is a complete no-op.
 *
 * `caffeinate -i` only prevents idle/system sleep; it does NOT override battery
 * CPU scaling. Partial but meaningful mitigation. `platform`/`spawnFn` are
 * injectable for tests.
 */
export function createSleepBlocker(
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): SleepBlocker {
  let proc: ChildProcess | null = null
  return {
    acquire(): void {
      if (proc || platform !== 'darwin') return
      try {
        proc = spawnFn('caffeinate', ['-i'], { stdio: 'ignore' })
        // caffeinate missing or failed — drop the handle so a later acquire retries.
        proc.on('error', () => { proc = null })
        proc.unref()
      } catch {
        proc = null
      }
    },
    release(): void {
      proc?.kill()
      proc = null
    },
  }
}
