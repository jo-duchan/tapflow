import { execFileSync } from 'node:child_process'

// Enumerate every host PID belonging to a booted simulator. A simulator's processes are all
// descendants of one `launchd_sim` whose command line embeds the device UDID (e.g.
// .../Devices/<UDID>/data/var/run/launchd_bootstrap.plist). We find that root and walk its tree —
// those are the processes a whole-sim audio tap must cover (the app + WebKit WebContent + system
// sounds), which a single-app tap misses. `psOutput` is injectable for tests.
export function enumerateSimPids(udid: string, psOutput?: string): number[] {
  const out = psOutput ?? execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }).toString()
  const children = new Map<number, number[]>()
  let root = 0
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const command = m[3]
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)!.push(pid)
    if (command.includes('launchd_sim') && command.includes(udid)) root = pid
  }
  if (!root) return []

  // walk descendants (the root launchd_sim itself never emits audio, so it's excluded)
  const pids: number[] = []
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()!
    for (const c of children.get(p) ?? []) {
      pids.push(c)
      stack.push(c)
    }
  }
  return pids
}
