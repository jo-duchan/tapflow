import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { basename, dirname } from 'path'
import { promisify } from 'util'
import { APP_LOG_CHUNK_LIMIT, defaultAppLogStreamDeps, inertAppLogStreamDeps, type AppLogStreamDeps } from './AppLogStream.js'

const execFileAsync = promisify(execFile)

export const APP_LOG_WATCH_EXIT_POLL_MS = 250
export const APP_LOG_WATCH_RESTART_MIN_MS = 1_000
export const APP_LOG_WATCH_RESTART_MAX_MS = 30_000

export type AppLogRunEvent = 'started' | 'running' | 'exited'
/** What the watch hands its sender, in order: text as it came, and the run boundaries between it. */
export type AppLogWatchItem = { kind: 'text'; text: string } | { kind: 'run'; event: AppLogRunEvent; pid: number }

export interface AppLogWatchDeps extends AppLogStreamDeps {
  /** The pid of the app's process running on device `udid` now (its executable ends in `imageSuffix`), or null. */
  findRunning(udid: string, imageSuffix: string): Promise<number | null>
  isAlive(pid: number): boolean
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The app process on simulator `udid` whose executable ends in `imageSuffix`, from `ps -o pid=,command=` output. A
 * simulator's apps are host processes; their executable lives under that device's directory.
 */
export function runningAppPid(ps: string, udid: string, imageSuffix: string): number | null {
  const device = `/Devices/${udid}/`
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const command = m[2]!
    if (command.includes(device) && (command.endsWith(imageSuffix) || command.includes(`${imageSuffix} `))) return Number(m[1])
  }
  return null
}

export const defaultAppLogWatchDeps: AppLogWatchDeps = {
  ...defaultAppLogStreamDeps,
  async findRunning(udid, imageSuffix) {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
      return runningAppPid(stdout, udid, imageSuffix)
    } catch {
      return null
    }
  },
  isAlive: isProcessAlive,
}

/** Under vitest an agent streams nothing: a suite must never spawn into a real simulator. */
export const inertAppLogWatchDeps: AppLogWatchDeps = {
  ...inertAppLogStreamDeps,
  findRunning: async () => null,
  isAlive: () => false,
}

/** `log stream`'s own header (see `AppLogStream.ts`): dropped before the first entry, never after. */
const HEADER_LINE = /^(?:Filtering the log data using |Timestamp\s+Ty\s+Process\[PID:TID\]\s*$)/

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The app's output for a session, however the app is opened: a Launch, its home-screen icon, a relaunch after a crash.
 * One `log stream` filtered by the executable's path, not by a pid, so it outlives each run of the app and a reinstall
 * (whose container path changes; measured on iOS 26.5, M1 in the plan). Runs are told apart by the pid on each entry's
 * first line (`<Exec>[pid:tid]`, at a fixed position); a continuation line of a multi-line entry has none and belongs
 * to the entry before it.
 */
export class AppLogWatch {
  private readonly imageSuffix: string
  private readonly entry: RegExp
  private child: ChildProcess | null = null
  private stopped = false
  private headerDone = false
  private partial = ''
  private readonly items: AppLogWatchItem[] = []
  private retryTimer: NodeJS.Timeout | null = null
  private exitPoll: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartDelay = APP_LOG_WATCH_RESTART_MIN_MS
  private spawnedAt = 0
  /** The run lines are going to now. */
  private current: number | null = null
  /** Runs whose `exited` was sent: a late line of one joins the current run, with no boundary. */
  private readonly exited = new Set<number>()

  constructor(
    private readonly udid: string,
    processImagePath: string,
    private readonly send: (item: AppLogWatchItem) => boolean,
    private readonly onError: (error: Error) => void,
    private readonly deps: AppLogWatchDeps = defaultAppLogWatchDeps,
    private readonly now: () => number = Date.now,
  ) {
    const exec = basename(processImagePath)
    this.imageSuffix = `/${basename(dirname(processImagePath))}/${exec}`
    this.entry = new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+ \\S+ +${escapeRegExp(exec)}\\[(\\d+):`)
  }

  /** Ends any stream an earlier agent left (#1235), notes a run already up, then streams. */
  async start(): Promise<void> {
    const orphans = await this.deps.findOrphans(this.udid).catch(() => [] as number[])
    if (this.stopped) return
    for (const pid of orphans) this.deps.killPid(pid)
    const running = await this.deps.findRunning(this.udid, this.imageSuffix).catch(() => null)
    if (this.stopped) return
    if (running !== null && running !== this.current) {
      this.endCurrent()
      this.current = running
      this.push({ kind: 'run', event: 'running', pid: running })
      this.flush()
    }
    this.spawnStream()
    if (!this.exitPoll) {
      this.exitPoll = setInterval(() => this.checkExit(), APP_LOG_WATCH_EXIT_POLL_MS)
      this.exitPoll.unref()
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const timer of [this.retryTimer, this.restartTimer]) if (timer) clearTimeout(timer)
    if (this.exitPoll) clearInterval(this.exitPoll)
    this.retryTimer = this.restartTimer = this.exitPoll = null
    this.items.length = 0
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }

  private spawnStream(): void {
    this.headerDone = false
    this.partial = ''
    this.spawnedAt = this.now()
    let child: ChildProcess
    try {
      child = this.deps.spawn('xcrun', [
        'simctl', 'spawn', this.udid, 'log', 'stream', '--level', 'debug', '--style', 'compact',
        '--predicate', `processImagePath ENDSWITH "${this.imageSuffix.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
      this.scheduleRestart()
      return
    }
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      if (this.stopped || this.child !== child) return
      this.read(text)
      this.flush()
    })
    child.once('error', (error: Error) => {
      if (this.child !== child) return
      this.onError(error)
    })
    child.once('close', (code) => {
      if (this.stopped || this.child !== child) return
      this.child = null
      // Not stopped by us: the simulator went down, or `simctl spawn` died. Raised again, a bit later each time.
      this.onError(new Error(`iOS app log watch stream ended (code ${code ?? 'signal'}); restarting`))
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    if (this.now() - this.spawnedAt >= APP_LOG_WATCH_RESTART_MAX_MS) this.restartDelay = APP_LOG_WATCH_RESTART_MIN_MS
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, APP_LOG_WATCH_RESTART_MAX_MS)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start()
    }, delay)
    this.restartTimer.unref()
  }

  /** Lines are assembled first: the pid is read from a whole line, and a chunk can end mid-line. */
  private read(text: string): void {
    const pieces = (this.partial + text).split('\n')
    this.partial = pieces.pop() ?? ''
    for (const line of pieces) this.line(line, true)
    if (this.partial.length > APP_LOG_CHUNK_LIMIT) {
      this.line(this.partial, false)
      this.partial = ''
    }
  }

  private line(line: string, ended: boolean): void {
    const m = this.entry.exec(line)
    if (!m && !this.headerDone && HEADER_LINE.test(line)) return
    this.headerDone = true
    if (m) {
      const pid = Number(m[1])
      if (pid !== this.current && !this.exited.has(pid)) {
        this.endCurrent()
        this.current = pid
        this.push({ kind: 'run', event: 'started', pid })
      }
    }
    this.push({ kind: 'text', text: ended ? `${line}\n` : line })
  }

  private endCurrent(): void {
    if (this.current === null || this.exited.has(this.current)) return
    this.exited.add(this.current)
    this.push({ kind: 'run', event: 'exited', pid: this.current })
  }

  private checkExit(): void {
    if (this.stopped || this.current === null || this.exited.has(this.current)) return
    if (this.deps.isAlive(this.current)) return
    this.endCurrent()
    this.flush()
  }

  /** Text is joined into chunks of at most `APP_LOG_CHUNK_LIMIT` bytes; a run boundary is its own item. */
  private push(item: AppLogWatchItem): void {
    const last = this.items[this.items.length - 1]
    if (item.kind === 'text' && last?.kind === 'text' && Buffer.byteLength(last.text) + Buffer.byteLength(item.text) <= APP_LOG_CHUNK_LIMIT) {
      last.text += item.text
      return
    }
    if (item.kind === 'text' && Buffer.byteLength(item.text) > APP_LOG_CHUNK_LIMIT) {
      let chunk = ''
      let bytes = 0
      for (const character of item.text) {
        const size = Buffer.byteLength(character)
        if (bytes + size > APP_LOG_CHUNK_LIMIT) {
          this.items.push({ kind: 'text', text: chunk })
          chunk = ''
          bytes = 0
        }
        chunk += character
        bytes += size
      }
      if (chunk) this.items.push({ kind: 'text', text: chunk })
      return
    }
    this.items.push(item.kind === 'text' ? { ...item } : item)
  }

  private flush(): void {
    if (this.stopped) return
    while (this.items.length > 0) {
      if (!this.send(this.items[0]!)) {
        // Held, in order, until the socket takes more: the pipe waits with it.
        this.child?.stdout?.pause()
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.flush()
          }, 20)
          this.retryTimer.unref()
        }
        return
      }
      this.items.shift()
    }
    this.child?.stdout?.resume()
  }
}
