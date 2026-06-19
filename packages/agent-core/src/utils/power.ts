import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'

export interface SleepBlocker {
  /** Start holding the power assertion (idempotent). No-op off macOS. */
  acquire(): void
  /** Release the assertion. Safe to call when not held. */
  release(): void
}

/**
 * macOS-only host power assertion via `caffeinate`, so the system doesn't
 * idle-throttle (or sleep) the simulator/emulator while a session is active —
 * the emulator's software H.264 encoder starves badly when the host idles
 * (unattended/backgrounded Mac). Off macOS this is a complete no-op.
 *
 * Defaults to `-di`, which also prevents display sleep: when the display sleeps
 * macOS parks the GPU, throttling the simulator render and encode pre-processing.
 * Running an agent effectively dedicates the Mac to tapflow, so keeping the
 * display awake is the right default. Set `TAPFLOW_ALLOW_DISPLAY_SLEEP` to fall
 * back to plain `-i` (system sleep only) on a shared daily-driver Mac.
 *
 * Neither flag overrides battery CPU scaling. Partial but meaningful mitigation.
 * `platform`/`spawnFn`/`env` are injectable for tests.
 */
export function createSleepBlocker(
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
  env: NodeJS.ProcessEnv = process.env,
): SleepBlocker {
  let proc: ChildProcess | null = null
  return {
    acquire(): void {
      if (proc || platform !== 'darwin') return
      try {
        const flag = env.TAPFLOW_ALLOW_DISPLAY_SLEEP ? '-i' : '-di'
        const child = spawnFn('caffeinate', [flag], { stdio: 'ignore' })
        proc = child
        // Drop the handle on any termination (missing binary, external kill, exit) so a
        // later acquire() re-spawns. Guard on identity so a stale child's late event can't
        // null out a newer one.
        const clear = (): void => { if (proc === child) proc = null }
        child.once('error', clear)
        child.once('close', clear)
        child.once('exit', clear)
        child.unref()
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
