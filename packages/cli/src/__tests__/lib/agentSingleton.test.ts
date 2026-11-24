// One agent per Mac per platform, and the claim is a real socket rather than a pid file.
//
// **Every assertion here is against the real kernel behaviour, not a double.** The whole reason this
// is a socket is that the kernel releases the listener when the process dies — including a `kill -9`,
// where no cleanup code runs — and a double would simply agree with whatever this file believed.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimAgentSlot, claimPath } from '../../lib/agent-singleton.js'

/** Short on purpose: `sun_path` is 104 bytes on Darwin, and vitest's own temp paths are long. */
const dir = mkdtempSync(join(tmpdir(), 'tf-'))
const kids: ChildProcess[] = []
const released: Array<() => void> = []

afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
  for (const r of released.splice(0)) r()
})

/** A separate process that takes the claim and then does nothing, like a running agent. */
function owner(platform: string): Promise<ChildProcess> {
  const src = `
    const net = require('node:net')
    const s = net.createServer(c => c.destroy())
    s.listen(${JSON.stringify(claimPath(platform, dir))}, () => process.stdout.write('up\\n'))
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] })
  kids.push(child)
  return new Promise((resolve) => { child.stdout!.once('data', () => resolve(child)) })
}

describe('the agent slot', () => {
  it('is taken when nobody holds it', async () => {
    const claim = await claimAgentSlot('ios', dir)
    expect(claim.held).toBe(true)
    if (claim.held) released.push(claim.release)
    expect(existsSync(claimPath('ios', dir))).toBe(true)
  })

  it('is refused while another process holds it', async () => {
    await owner('android')
    const claim = await claimAgentSlot('android', dir)
    expect(claim).toEqual({ held: false, reason: 'in-use' })
  })

  it('is free again after the holder is killed without cleaning up', async () => {
    // `SIGKILL`, because that is the case a pid file, a lock file or a timestamp cannot cover: no
    // handler runs, the socket file stays on disk, and only the kernel's release of the listener
    // distinguishes a dead owner from a live one.
    const child = await owner('probe')
    expect((await claimAgentSlot('probe', dir)).held, 'refused while alive').toBe(false)
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))
    // A Unix socket file outlives its owner; a Windows named pipe goes with it, so there is no corpse to see
    // there — only the reacquisition below, which holds on both.
    if (process.platform !== 'win32') expect(existsSync(claimPath('probe', dir)), 'the corpse is still on disk').toBe(true)
    const claim = await claimAgentSlot('probe', dir)
    expect(claim.held, 'a dead owner still held the slot').toBe(true)
    if (claim.held) released.push(claim.release)
  })

  // Unix only: on Windows the claim is a named pipe (`\\.\pipe\…`), where no plain file can be written.
  it.skipIf(process.platform === 'win32')('takes over a path left by something that is not a socket at all', async () => {
    // A plain file at the path answers `connect` with an error the same way a corpse does. Treating
    // that as "held" would wedge the platform until someone found the file.
    writeFileSync(claimPath('junk', dir), 'not a socket')
    const claim = await claimAgentSlot('junk', dir)
    expect(claim.held).toBe(true)
    if (claim.held) released.push(claim.release)
  })

  it('releases on request, so a second claim in the same process succeeds', async () => {
    const first = await claimAgentSlot('cycle', dir)
    expect(first.held).toBe(true)
    if (first.held) first.release()
    const second = await claimAgentSlot('cycle', dir)
    expect(second.held, 'release did not free the path').toBe(true)
    if (second.held) released.push(second.release)
  })

  it('keeps platforms apart', async () => {
    await owner('ios2')
    const other = await claimAgentSlot('android2', dir)
    expect(other.held, 'an iOS agent blocked an Android one').toBe(true)
    if (other.held) released.push(other.release)
  })

  it('gives the slot to exactly one of two callers arriving together', async () => {
    // **The case the first three mutations all missed.** They changed what was on the path — a file,
    // a live owner, a shared name — and none of them changed how many callers arrive at once, which
    // is the only thing the ordering of probe, unlink and bind is about. Probing first and unlinking
    // before binding let the second caller delete the socket the first had just bound: measured
    // `[true, true]`.
    const results = await Promise.all([
      claimAgentSlot('race', dir), claimAgentSlot('race', dir), claimAgentSlot('race', dir),
    ])
    for (const r of results) if (r.held) released.push(r.release)
    expect(results.filter((r) => r.held).length, 'more than one caller won the slot').toBe(1)
  })

  it('answers a probe even while the owner is busy', async () => {
    // The backlog is the kernel's, and the listener destroys what it accepts, so a probe cannot be
    // refused for being queued behind other probes — which would read as "the owner is dead".
    await owner('busy')
    const results = await Promise.all([
      claimAgentSlot('busy', dir), claimAgentSlot('busy', dir), claimAgentSlot('busy', dir),
    ])
    expect(results.map((r) => r.held)).toEqual([false, false, false])
  })
})

// The claim on Windows is a named pipe: Node binds IPC servers there only under `\\.\pipe\`.
// Path shape only — binding one needs a Windows host.
describe('claimPath on Windows', () => {
  it('names a machine-wide pipe for the default location', () => {
    expect(claimPath('android', undefined, 'win32')).toBe('\\\\.\\pipe\\tapflow-agent-android')
  })

  it('gives a non-default directory its own pipe, so test runs do not share the real claim', () => {
    const a = claimPath('android', 'C:\\temp\\a', 'win32')
    const b = claimPath('android', 'C:\\temp\\b', 'win32')
    expect(a).toMatch(/^\\\\\.\\pipe\\tapflow-agent-android-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it('keeps the socket file everywhere else', () => {
    // Built with join so the expectation follows the host's separators, as claimPath does — on a
    // native-Windows test run join('/tmp', …) yields backslashes, and a literal string would not match.
    expect(claimPath('android', '/tmp', 'darwin')).toBe(join('/tmp', 'tapflow-agent-android.sock'))
    expect(claimPath('ios', '/tmp', 'linux')).toBe(join('/tmp', 'tapflow-agent-ios.sock'))
  })
})
