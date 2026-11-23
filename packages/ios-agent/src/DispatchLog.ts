import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@tapflowio/agent-core'
import { killWithSigkillFallback } from './childProcessKill.js'
import { parseDispatch, SYSTEM_GESTURE_WINDOW, type Dispatch } from './touchLanding.js'

const execFileAsync = promisify(execFile)
const logger = createLogger('ios-agent:dispatch-log')

/**
 * UIKit's dispatch log for one recorded simulator (#1214), streamed from the host: `simctl spawn <udid> log stream` with
 * a predicate that keeps only the line UIKit writes for each touch event it delivers. Nothing is configured on the device
 * and nothing is injected, so a device already up is read the same as one just booted. Measured on iOS 26.5: each line
 * reaches the pipe as its own chunk within 1 ms of the event, and the stream is attached ~1.4 s after the spawn (a touch
 * before that has no line). The rules are in AGENTS.md, "Where a touch landed".
 */
export const DISPATCH_PREDICATE =
  'subsystem == "com.apple.UIKit" AND category == "EventDispatch" AND eventMessage BEGINSWITH "Sending UIEvent type: 0; subtype: 0; to window:"'

/** What the stream keeps: a gesture waits up to `MAX_DISPATCH_LAG_MS` for its line, and reads the one before it. */
const KEEP_MS = 10_000
const KEEP_MAX = 4_000
/** How often lines past `KEEP_MS` are let go while no new line arrives: they name what a person touched. */
const PRUNE_EVERY_MS = 1_000
/** As TouchHelper's: a stream that keeps dying is not restarted for ever. */
const RESPAWN_MAX = 3
const RESPAWN_WINDOW_MS = 30_000

export interface DispatchLogDeps {
  spawn(udid: string): ChildProcess
  /** The bundle id of the app whose executable is at `image` (its Info.plist), or null. */
  bundleOf(image: string): Promise<string | null>
  /** `log stream`s an earlier agent left for this device: an agent killed with -9 leaves `simctl spawn` running. */
  findOrphans(udid: string): Promise<number[]>
  killPid(pid: number): void
  now(): number
}

export const defaultDispatchLogDeps: DispatchLogDeps = {
  spawn: (udid) => spawn('xcrun', ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--predicate', DISPATCH_PREDICATE], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
  async bundleOf(image) {
    try {
      const out = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(dirname(image), 'Info.plist')], { timeout: 5_000 })
      const id = out.stdout.trim()
      return id || null
    } catch {
      return null
    }
  },
  async findOrphans(udid) {
    let out: string
    try {
      out = (await execFileAsync('/usr/bin/pgrep', ['-f', `simctl spawn ${udid} log stream`], { timeout: 5_000 })).stdout
    } catch {
      return [] // pgrep exits 1 when nothing matches
    }
    const pids: number[] = []
    for (const pid of out.split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)) {
      try {
        const cmd = (await execFileAsync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 })).stdout
        // Ours by its predicate, not only by the device: someone's own `log stream` on the same simulator stays.
        if (cmd.includes(`simctl spawn ${udid} log stream`) && cmd.includes('EventDispatch')) pids.push(pid)
      } catch { /* gone between the two calls */ }
    }
    return pids
  },
  // TERM ends the `log` inside the simulator with it (measured); a SIGKILL'd parent is what leaves both behind.
  killPid(pid) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  },
  now: () => Date.now(),
}

/** Under vitest an agent reads nothing: a suite must never spawn into a real simulator. */
export const inertDispatchLogDeps: DispatchLogDeps = {
  spawn: () => { throw new Error('no dispatch log under test') },
  bundleOf: async () => null,
  findOrphans: async () => [],
  killPid: () => {},
  now: () => Date.now(),
}

export class DispatchLog {
  private proc: ChildProcess | null = null
  private stopped = false
  private buf = ''
  private readonly kept: Dispatch[] = []
  private readonly spawns: number[] = []
  private readonly bundles = new Map<string, Promise<string | null>>()
  /** Whether any line in the format was read: until then, silence is a stream not yet attached, not a changed format. */
  private seen = false
  private pruner: ReturnType<typeof setInterval> | null = null

  constructor(private readonly udid: string, private readonly deps: DispatchLogDeps = defaultDispatchLogDeps) {}

  /** Clears what an earlier agent left for this device, then starts reading. */
  start(): Promise<void> {
    return this.deps.findOrphans(this.udid)
      .catch(() => [] as number[])
      .then((pids) => {
        for (const pid of pids) this.deps.killPid(pid)
        if (!this.stopped) this.spawnStream()
      })
  }

  stop(): void {
    this.stopped = true
    const proc = this.proc
    this.proc = null
    if (this.pruner) { clearInterval(this.pruner); this.pruner = null }
    this.kept.length = 0
    killWithSigkillFallback(proc)
  }

  get running(): boolean {
    return this.proc !== null
  }

  /** Whether the stream has delivered a line in the format it reads. */
  get attached(): boolean {
    return this.seen
  }

  /** The lines kept, in time order. */
  lines(): readonly Dispatch[] {
    return this.kept
  }

  bundleOf(image: string): Promise<string | null> {
    let b = this.bundles.get(image)
    if (!b) {
      b = this.deps.bundleOf(image).catch(() => null)
      this.bundles.set(image, b)
    }
    return b
  }

  private spawnStream(): void {
    const now = this.deps.now()
    while (this.spawns.length && now - this.spawns[0]! >= RESPAWN_WINDOW_MS) this.spawns.shift()
    if (this.spawns.length >= RESPAWN_MAX) {
      logger.warn(`the dispatch log for ${this.udid} stopped ${RESPAWN_MAX} times in ${RESPAWN_WINDOW_MS / 1000} s: touches are not placed until the next boot`)
      return
    }
    this.spawns.push(now)
    let proc: ChildProcess
    try {
      proc = this.deps.spawn(this.udid)
    } catch (e) {
      logger.warn(`could not read the dispatch log for ${this.udid}:`, (e as Error).message)
      return
    }
    this.proc = proc
    this.buf = ''
    if (!this.pruner) {
      this.pruner = setInterval(() => this.prune(), PRUNE_EVERY_MS)
      this.pruner.unref?.()
    }
    // Decoded by the stream, not per chunk: a chunk can end inside a character of a path (an app named in Hangul).
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.take(chunk))
    // A spawn that fails is not promised an `exit` after its `error`: both end it here, once, by the process's identity.
    const ended = () => {
      if (this.proc !== proc) return
      this.proc = null
      if (!this.stopped) this.spawnStream()
    }
    proc.on('error', (e) => {
      logger.warn(`the dispatch log for ${this.udid} failed:`, e.message)
      ended()
    })
    proc.on('exit', ended)
  }

  private prune(): void {
    const cutoff = this.deps.now() - KEEP_MS
    while (this.kept.length && (this.kept[0]!.at < cutoff || this.kept.length > KEEP_MAX)) this.kept.shift()
  }

  private take(text: string): void {
    this.buf += text
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const d = parseDispatch(line)
      if (!d) continue
      this.seen = true
      if (d.window === SYSTEM_GESTURE_WINDOW) continue
      // In time order: a line stamped before the last one kept goes in its place.
      let k = this.kept.length
      while (k > 0 && this.kept[k - 1]!.at > d.at) k--
      this.kept.splice(k, 0, d)
    }
    // A line with no end yet is held; one that never ends is not held for ever.
    if (this.buf.length > 64 * 1024) this.buf = ''
    this.prune()
  }
}
