import { execFileSync } from 'child_process'

/**
 * Stable per-machine id from the macOS IOPlatformUUID, used by the relay to dedup an agent's
 * stale socket on re-register without false-positives. Unlike os.hostname() it's unique per Mac
 * (two hosts can share a hostname), and it survives reboots/reconnects. macOS-only — returns
 * undefined elsewhere (and on any failure), so callers fall back to the hostname.
 *
 * `platform`/`execFn` are injectable for tests.
 */
export function getMachineId(
  platform: NodeJS.Platform = process.platform,
  execFn: typeof execFileSync = execFileSync,
): string | undefined {
  if (platform !== 'darwin') return undefined
  try {
    const out = execFn('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }) as string
    return out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]
  } catch {
    return undefined
  }
}
