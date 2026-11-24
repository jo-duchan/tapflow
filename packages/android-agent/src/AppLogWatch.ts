import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { APP_LOG_CHUNK_LIMIT } from './AppLogStream.js'

export const APP_LOG_WATCH_EXIT_POLL_MS = 1_000
export const APP_LOG_WATCH_RESTART_MIN_MS = 1_000
export const APP_LOG_WATCH_RESTART_MAX_MS = 30_000

export type AppLogRunEvent = 'started' | 'running' | 'exited'
/** What the watch hands its sender, in order: text as it came, and the run boundaries between it. */
export type AppLogWatchItem = { kind: 'text'; text: string } | { kind: 'run'; event: AppLogRunEvent; pid: number }

export interface AppLogWatchDeps {
  spawn: typeof spawn
  adbPath(): string
  /** The package's uid, or null when it is not installed or shares its uid with another package (refused as before). */
  uid(): Promise<number | null>
  processes(uid: number): Promise<Array<{ pid: number; name: string }>>
  /** The device's clock as `logcat -T` reads it, so the stream starts now rather than at the buffer's start. */
  deviceTime(): Promise<string | undefined>
}

/**
 * A starting app process is not yet called by its own name. Measured on API 34, the uid's process was first listed as
 * `zygote64`, and once as another app's package (`com.google.android.configupdater`), before taking the app's. Every
 * process of the uid is the app's, named as its package or `<package>:<name>`, so any other name is asked again.
 */
export const APP_LOG_WATCH_NAME_RETRY_MS = 50
export const APP_LOG_WATCH_NAME_RETRIES = 20

/** A `-v process` line: `I( 5344) the message  (Tag)`. The text sent is the message alone, as `-v raw` gave it
 *  (measured: 80 of 80 lines identical, M3 in the plan). A logcat banner (`--------- beginning of main`) has no pid. */
const PROCESS_LINE = /^[VDIWEFAS]\( *(\d+)\) (.*?)(?: {2}\([^()]*\))?$/

/**
 * The app's output for a session, however it is opened: a Launch, its launcher icon, a relaunch after a crash. One
 * `logcat --uid` stream, which outlives each process of the app (measured across `am crash` and a relaunch, M3). A run
 * is the app's main process, the one named as the package; lines of its other processes join the current run.
 */
export class AppLogWatch {
  private child: ChildProcess | null = null
  private stopped = false
  private uid: number | null = null
  private partial = ''
  /** Lines read and not yet placed: placing one may need to ask the device which process a new pid is. */
  private readonly lines: string[] = []
  private placing = false
  private readonly items: AppLogWatchItem[] = []
  private retryTimer: NodeJS.Timeout | null = null
  private exitPoll: NodeJS.Timeout | null = null
  private polling = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartDelay = APP_LOG_WATCH_RESTART_MIN_MS
  private spawnedAt = 0
  private current: number | null = null
  private readonly exited = new Set<number>()
  /** Whether each pid seen is the main process. */
  private readonly main = new Map<number, boolean>()

  constructor(
    private readonly serial: string,
    private readonly packageName: string,
    private readonly send: (item: AppLogWatchItem) => boolean,
    private readonly onError: (error: Error) => void,
    private readonly deps: AppLogWatchDeps,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    const uid = await this.deps.uid().catch(() => null)
    if (this.stopped) return
    if (uid === null) {
      this.onError(new Error(`no app log watch for ${this.packageName}: not installed, or its uid is shared`))
      return
    }
    this.uid = uid
    const processes = await this.deps.processes(uid).catch(() => [])
    if (this.stopped) return
    this.note(processes)
    const running = processes.find((p) => p.name === this.packageName)?.pid
    if (running !== undefined && running !== this.current) {
      this.endCurrent()
      this.current = running
      this.push({ kind: 'run', event: 'running', pid: running })
      this.flush()
    }
    const time = await this.deps.deviceTime().catch(() => undefined)
    if (this.stopped) return
    this.spawnStream(uid, time)
    if (!this.exitPoll) {
      this.exitPoll = setInterval(() => void this.checkExit(), APP_LOG_WATCH_EXIT_POLL_MS)
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
    this.lines.length = 0
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }

  private spawnStream(uid: number, time: string | undefined): void {
    this.partial = ''
    this.spawnedAt = this.now()
    let child: ChildProcess
    try {
      // Without a device time, the last line only: the whole buffer would be history from before the session.
      child = this.deps.spawn(this.deps.adbPath(), ['-s', this.serial, 'logcat', `--uid=${uid}`, '-T', time ?? '1', '-v', 'process'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
      this.scheduleRestart()
      return
    }
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      if (this.stopped || this.child !== child) return
      const pieces = (this.partial + text).split('\n')
      this.partial = pieces.pop() ?? ''
      this.lines.push(...pieces.map((line) => line.replace(/\r$/, '')))
      if (this.partial.length > APP_LOG_CHUNK_LIMIT) {
        this.lines.push(this.partial)
        this.partial = ''
      }
      void this.place()
    })
    child.once('error', (error: Error) => {
      if (this.child === child) this.onError(error)
    })
    child.once('close', (code) => {
      if (this.stopped || this.child !== child) return
      this.child = null
      this.onError(new Error(`Android app log watch stream ended (code ${code ?? 'signal'}); restarting`))
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

  private named(name: string): boolean {
    return name === this.packageName || name.startsWith(`${this.packageName}:`)
  }

  private note(processes: Array<{ pid: number; name: string }>): void {
    for (const p of processes) if (this.named(p.name)) this.main.set(p.pid, p.name === this.packageName)
  }

  /** Asks which process `pid` is, again while it has no name of its own yet. One the device no longer lists, or one
   *  still otherwise named after the retries (a manifest `android:process` naming it outside the package), joins the
   *  current run. */
  private async classify(uid: number, pid: number): Promise<void> {
    for (let attempt = 0; attempt < APP_LOG_WATCH_NAME_RETRIES; attempt++) {
      const processes = await this.deps.processes(uid).catch(() => [])
      if (this.stopped) return
      this.note(processes)
      const listed = processes.find((p) => p.pid === pid)
      if (!listed || this.named(listed.name)) break
      await new Promise((resolve) => setTimeout(resolve, APP_LOG_WATCH_NAME_RETRY_MS))
      if (this.stopped) return
    }
    if (!this.main.has(pid)) this.main.set(pid, false)
  }

  /** One line at a time, in order. A line of a pid not seen before waits for the device to say which process it is. */
  private async place(): Promise<void> {
    if (this.placing) return
    this.placing = true
    try {
      while (this.lines.length > 0 && !this.stopped) {
        const line = this.lines[0]!
        const m = PROCESS_LINE.exec(line)
        if (m) {
          const pid = Number(m[1])
          if (!this.main.has(pid) && pid !== this.current && !this.exited.has(pid) && this.uid !== null) {
            this.child?.stdout?.pause()
            await this.classify(this.uid, pid)
            if (this.stopped) return
          }
          if (this.main.get(pid) && pid !== this.current && !this.exited.has(pid)) {
            this.endCurrent()
            this.current = pid
            this.push({ kind: 'run', event: 'started', pid })
          }
          this.push({ kind: 'text', text: `${m[2]}\n` })
        } else {
          this.push({ kind: 'text', text: `${line}\n` })
        }
        this.lines.shift()
      }
    } finally {
      this.placing = false
    }
    this.flush()
  }

  private endCurrent(): void {
    if (this.current === null || this.exited.has(this.current)) return
    this.exited.add(this.current)
    this.push({ kind: 'run', event: 'exited', pid: this.current })
  }

  private async checkExit(): Promise<void> {
    if (this.stopped || this.polling || this.uid === null || this.current === null || this.exited.has(this.current)) return
    this.polling = true
    try {
      const processes = await this.deps.processes(this.uid)
      if (this.stopped) return
      this.note(processes)
      const current = this.current
      // Lines still waiting to be placed may belong to the run: it ends after them.
      if (current !== null && !processes.some((p) => p.pid === current) && this.lines.length === 0) {
        this.endCurrent()
        this.flush()
      }
    } catch {
      /* the next poll asks again */
    } finally {
      this.polling = false
    }
  }

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
    if (!this.placing) this.child?.stdout?.resume()
  }
}
