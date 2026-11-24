import net from 'node:net'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Machine-wide on purpose — see `claimPath`. */
const MACHINE_DIR = '/tmp'

/**
 * One agent per Mac, per platform — claimed at startup and refused rather than fought over.
 *
 * **This exists because the alternative was an ownership model, and the ownership model was the wrong
 * answer to the wrong question.** Two agents on one Mac both enumerate the same host-wide simulator
 * list and both write the same host-wide filter rule, so the second one starting used to put every
 * device the first had taken offline back online. Making that *correct* would mean tracking who owns
 * each device across processes, in a store with no owner and no transactions, read from a synchronous
 * path — three design rounds established that the system has nowhere to keep that fact.
 *
 * The relay had already answered the question: agent identity there is `IOPlatformUUID` + platform,
 * one per Mac, and a second registration **evicts the first agent's socket**. So the configuration is
 * not supported; it just failed late, at the filter, instead of early, with a sentence.
 *
 * **Parallelism is untouched.** One agent manages every simulator on its Mac, and many testers on
 * many devices is exactly what already works. What is refused is a second `tapflow agent start` for
 * the same platform on the same machine.
 */

/**
 * Kept short on purpose: `sun_path` is **104 bytes** on Darwin and a longer path fails `EINVAL` at
 * `listen`, which was measured the first time this was tried from a nested temp directory.
 *
 * **`/tmp` rather than `tmpdir()`, because the resource is machine-wide and `tmpdir()` is not.**
 * `os.tmpdir()` answers a uid-scoped directory on macOS and honours `TMPDIR`, so a second account —
 * or a `sudo` run, whose `env_reset` drops `TMPDIR` — resolved a different path and both took the
 * slot. That is a false *allow* over a host-wide filter, which is the direction that costs something.
 *
 * `/tmp` is world-writable with the sticky bit, which trades that for a false *refuse*: one account
 * cannot unlink another's leftover socket, so a stale claim from a different user is reported as one
 * rather than taken over. That is rare, it is the safe direction, and it gets its own sentence
 * instead of being reported as "already running".
 */
export function claimPath(platform: string, dir = MACHINE_DIR, host: NodeJS.Platform = process.platform): string {
  // **On Windows Node's IPC server is a named pipe**, and its docs require the path to sit in
  // `\\?\pipe\` or `\\.\pipe\`. A `/tmp/...` path fails to bind, which this module reads as "already
  // running", so every agent start would be refused. A pipe in `\\.\pipe\` is machine-wide like
  // `/tmp`, and it goes away with the process that holds it, so there is no corpse to clear. A
  // non-default `dir` (tests) gets its own pipe name.
  if (host === 'win32') {
    const scope = dir === MACHINE_DIR ? '' : `-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`
    return `\\\\.\\pipe\\tapflow-agent-${platform}${scope}`
  }
  return join(dir, `tapflow-agent-${platform}.sock`)
}

export type ClaimResult =
  | { held: true; release: () => void }
  /** Something is listening: an agent for this platform is running. */
  | { held: false; reason: 'in-use' }
  /** A socket file is there, nothing answers, and this user may not remove it — another account's
   *  leftover. Refusing is right; saying "already running" would not be. */
  | { held: false; reason: 'stale-claim' }

/**
 * Take the claim, or report that a live agent already holds it.
 *
 * Liveness is the kernel's answer, not a heuristic: while the owner runs it accepts the connection,
 * and when it dies — **including `kill -9`, where no cleanup code runs** — the listener goes with the
 * process and a probe gets `ECONNREFUSED` even though the socket file survives. Measured. That is why
 * this is a socket and not a pid file, a lock file, or a timestamp: none of those releases itself.
 *
 * `ENOENT` and `ECONNREFUSED` both mean "nobody is home"; they differ only in whether a corpse was
 * left behind, and the corpse is unlinked before taking over.
 */
export async function claimAgentSlot(platform: string, dir = MACHINE_DIR): Promise<ClaimResult> {
  const path = claimPath(platform, dir)
  // **Bind first, and let the kernel be the one that decides.**
  //
  // Probing and then unlinking before binding is not a claim, it is a race with a suggestion in it:
  // two agents starting together both see nothing alive, and the second one's `unlink` removes the
  // socket the first has already bound — so both bind, both run, and the first becomes invisible to
  // every later probe. Measured before this was written: two concurrent calls both answered `held`.
  //
  // `bind(2)` is atomic against another `bind(2)`, so the only serialising thing here is the one the
  // kernel already provides. `EADDRINUSE` is then the question — a live owner or a corpse — and only
  // then is it worth asking.
  const first = await listenOn(path)
  if (first) return first
  if (await ownerIsAlive(path)) return { held: false, reason: 'in-use' }

  // A corpse: the file outlived the process that bound it. Clearing it is safe *because* nothing
  // answered, and the retry is single because a second `EADDRINUSE` means somebody won the race in
  // between — which is the correct answer, not something to keep trying past.
  // A named pipe (Windows) leaves no file behind, so there is nothing to unlink — only the retry.
  if (process.platform === 'win32') return (await listenOn(path)) ?? { held: false, reason: 'in-use' }
  try {
    unlinkSync(path)
  } catch (e) {
    // ENOENT means another starter cleared it first, and the retry below settles who wins. EPERM is
    // the sticky-bit case: the corpse belongs to another account and stays.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { held: false, reason: 'stale-claim' }
  }
  return (await listenOn(path)) ?? { held: false, reason: 'in-use' }
}

function listenOn(path: string): Promise<{ held: true; release: () => void } | null> {
  return new Promise((resolve) => {
    const server = net.createServer((c) => {
      // A probe only needs the connection to succeed. Closing at once keeps the backlog empty, so a
      // probe is never refused for being queued behind other probes — which would read as "gone".
      c.destroy()
    })
    // Nothing should stay alive for this handle alone; the agent's relay socket is what holds the
    // process open.
    server.unref()
    server.once('error', () => { resolve(null) })
    server.listen(path, () => {
      resolve({
        held: true,
        release: () => {
          server.close()
          try { unlinkSync(path) } catch { /* already gone */ }
        },
      })
    })
  })
}

function ownerIsAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => { probe.destroy(); resolve(false) })
  })
}
